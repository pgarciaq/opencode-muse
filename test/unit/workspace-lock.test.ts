import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLock } from "../../src/session/workspace-lock.js";
import { RegistryValidationError, WorkspaceBusyError, WorkspaceLockCorruptError } from "../../src/errors.js";

const roots: string[] = [];
const workspaceA = "a".repeat(64);
const workspaceB = "b".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-muse-workspace-lock-"));
  roots.push(root);
  return root;
}

describe("WorkspaceLock", () => {
  test("workspaceLock.exclusiveAcquireReturnsRestrictiveLeaseAndReleaseIsIdempotent", async () => {
    const root = makeRoot();
    const lock = new WorkspaceLock({ stateDirectory: root });
    const lease = await lock.acquire(workspaceA, "ses_owner");
    const file = join(root, "locks", `${workspaceA}.lock`);

    expect(statSync(join(root, "locks")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(record.workspaceFingerprint).toBe(workspaceA);
    expect(JSON.stringify(record)).not.toContain("/workspace");
    await Promise.all([lease.release(), lease.release()]);
    expect(() => statSync(file)).toThrow();
  });

  test("workspaceLock.concurrentSameWorkspaceGetsOneOwnerAndOneBusyError", async () => {
    const root = makeRoot();
    const first = new WorkspaceLock({ stateDirectory: root });
    const second = new WorkspaceLock({ stateDirectory: root });
    const results = await Promise.allSettled([
      first.acquire(workspaceA, "ses_first"),
      second.acquire(workspaceA, "ses_second"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkspaceBusyError);
    await (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof first.acquire>>>).value.release();
  });

  test("workspaceLock.independentWorkspacesDoNotBlockEachOther", async () => {
    const root = makeRoot();
    const lock = new WorkspaceLock({ stateDirectory: root });
    const first = await lock.acquire(workspaceA, "ses_a");
    const second = await lock.acquire(workspaceB, "ses_b");
    await Promise.all([first.release(), second.release()]);
  });

  test("workspaceLock.recoversDeadOwnerAndLeavesLiveOwnerBusy", async () => {
    const root = makeRoot();
    const locks = join(root, "locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${workspaceA}.lock`), JSON.stringify({
      version: 1,
      workspaceFingerprint: workspaceA,
      openCodeSessionId: "ses_dead",
      ownerToken: "dead-owner",
      pid: 2_000_000_000,
      acquiredAt: 1,
    }), { mode: 0o600 });
    const staleRecovering = new WorkspaceLock({ stateDirectory: root, isProcessAlive: () => false });
    const lease = await staleRecovering.acquire(workspaceA, "ses_new");
    expect(JSON.parse(readFileSync(join(locks, `${workspaceA}.lock`), "utf8")).openCodeSessionId).toBe("ses_new");
    expect(existsSync(join(locks, `${workspaceA}.lock.reclaim`))).toBe(false);
    await lease.release();

    writeFileSync(join(locks, `${workspaceA}.lock`), JSON.stringify({
      version: 1,
      workspaceFingerprint: workspaceA,
      openCodeSessionId: "ses_live",
      ownerToken: "live-owner",
      pid: 123,
      acquiredAt: Date.now(),
    }), { mode: 0o600 });
    const liveCheck = new WorkspaceLock({ stateDirectory: root, isProcessAlive: () => true });
    await expect(liveCheck.acquire(workspaceA, "ses_waiting")).rejects.toBeInstanceOf(WorkspaceBusyError);
  });

  test("workspaceLock.doesNotReleaseAReplacedOwnerLock", async () => {
    const root = makeRoot();
    const lock = new WorkspaceLock({ stateDirectory: root });
    const lease = await lock.acquire(workspaceA, "ses_owner");
    const file = join(root, "locks", `${workspaceA}.lock`);
    writeFileSync(file, JSON.stringify({
      version: 1,
      workspaceFingerprint: workspaceA,
      openCodeSessionId: "ses_other",
      ownerToken: "replacement-token",
      pid: 456,
      acquiredAt: Date.now(),
    }), { mode: 0o600 });

    await lease.release();
    expect(JSON.parse(readFileSync(file, "utf8")).ownerToken).toBe("replacement-token");
  });

  test("workspaceLock.rejectsMalformedExistingLockWithoutAssumingItIsStale", async () => {
    const root = makeRoot();
    const locks = join(root, "locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${workspaceA}.lock`), "not-json", { mode: 0o600 });

    await expect(new WorkspaceLock({ stateDirectory: root }).acquire(workspaceA, "ses_new"))
      .rejects.toBeInstanceOf(WorkspaceLockCorruptError);
  });

  test("workspaceLock.serializesCompetingStaleOwnerRecovery", async () => {
    const root = makeRoot();
    const locks = join(root, "locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${workspaceA}.lock`), JSON.stringify({
      version: 1,
      workspaceFingerprint: workspaceA,
      openCodeSessionId: "ses_dead",
      ownerToken: "dead-owner",
      pid: 2_000_000_000,
      acquiredAt: 1,
    }), { mode: 0o600 });
    const first = new WorkspaceLock({ stateDirectory: root, isProcessAlive: (pid) => pid === process.pid });
    const second = new WorkspaceLock({ stateDirectory: root, isProcessAlive: (pid) => pid === process.pid });
    const results = await Promise.allSettled([
      first.acquire(workspaceA, "ses_first"),
      second.acquire(workspaceA, "ses_second"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const lease = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof first.acquire>>>).value;
    await lease.release();
  });

  test("workspaceLock.failsClosedOnAbandonedStaleRecoveryClaim", async () => {
    const root = makeRoot();
    const locks = join(root, "locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${workspaceA}.lock`), JSON.stringify({
      version: 1,
      workspaceFingerprint: workspaceA,
      openCodeSessionId: "ses_dead",
      ownerToken: "dead-owner",
      pid: 2_000_000_000,
      acquiredAt: 1,
    }), { mode: 0o600 });
    writeFileSync(join(locks, `${workspaceA}.lock.reclaim`), JSON.stringify({
      version: 1,
      ownerToken: "dead-reclaimer",
      pid: 2_000_000_000,
    }), { mode: 0o600 });

    await expect(new WorkspaceLock({ stateDirectory: root, isProcessAlive: () => false }).acquire(workspaceA, "ses_new"))
      .rejects.toBeInstanceOf(WorkspaceLockCorruptError);
  });

  test("workspaceLock.refusesToWriteInsideMuseConfiguration", () => {
    expect(() => new WorkspaceLock({
      stateDirectory: "/home/test/.config/muse/plugin-state",
      env: {},
      homeDirectory: "/home/test",
      platform: "linux",
    })).toThrow(RegistryValidationError);
  });
});
