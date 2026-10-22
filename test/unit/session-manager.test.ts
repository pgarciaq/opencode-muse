import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../../src/session/registry.js";
import { WorkspaceLock } from "../../src/session/workspace-lock.js";
import { MuseSessionManager } from "../../src/session/manager.js";
import { MspCommandTimeoutError, WorkspaceBusyError, MuseRecoveryChoiceRequiredError } from "../../src/errors.js";
import type { RequestContext } from "../../src/types.js";

const roots: string[] = [];
const workspaceFingerprint = (directory: string) => createHash("sha256").update(directory).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-muse-manager-"));
  roots.push(path);
  return path;
}

function context(sessionID: string, directory: string): RequestContext {
  return {
    sessionID,
    directory,
    kind: "primary",
    modelID: "muse-profile-tbh-model-wonder",
    providerID: "muse",
    museSelection: {
      providerId: "meta",
      profileId: "tbh",
      modelId: "wonder",
      isActive: false,
      isDefault: true,
      defaultReasoningEffort: "high",
      variantsKnown: true,
      variants: ["high"],
    },
  };
}

function managerAt(root: string, failSetModel = false, resumeActiveTurn = false) {
  let id = 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const hosts: Array<{ closeCount: number }> = [];
  const manager = new MuseSessionManager({
    stateDirectory: root,
    registry: new SessionRegistry({ stateDirectory: root }),
    workspaceLock: new WorkspaceLock({ stateDirectory: root }),
    async createHost(options) {
      const record = { closeCount: 0 };
      hosts.push(record);
      return {
        initializeResult: { sessionDurability: "durable" },
        mintCommandId: () => `018f4f17-9c2a-7c1a-a0fd-67a19db5d1${String(id++).padStart(2, "0")}`,
        async command(method: string, params: Record<string, unknown>) {
          calls.push({ method, params });
          if (failSetModel && method === "session/setModel") {
            throw new MspCommandTimeoutError(method, 10);
          }
          if (method === "session/start") {
            return { session: { sessionId: `ses_muse_${calls.length}`, activeTurnId: null }, viewCursor: "head-1" };
          }
          if (method === "session/resume") {
            return {
              session: { sessionId: params.sessionId, activeTurnId: resumeActiveTurn ? "turn_unknown" : null },
              viewCursor: "resumed-head",
            };
          }
          if (method === "session/setModel") return { commandId: params.commandId, status: "accepted" };
          return {};
        },
        async request() { return {}; },
        subscribe() { return { async *[Symbol.asyncIterator]() {} }; },
        async close() { record.closeCount += 1; },
        options,
      } as never;
    },
  });
  return { manager, calls, hosts };
}

describe("MuseSessionManager", () => {
  test("sessionManager.createsOneHostAndMuseSessionPerOpenCodeSession", async () => {
    const root = tempRoot();
    const { manager, calls } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.commitTranscriptFingerprints?.(["d".repeat(64)]);
    await first.release?.();
    const second = await manager.resolveSession(context("ses_oc_1", directory));

    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    expect(second.sessionId).toBe(first.sessionId);
    expect(calls[0]?.params).toMatchObject({
      providerId: "meta",
      modelId: "wonder",
      workspaceRoot: directory,
    });
    expect(await new SessionRegistry({ stateDirectory: root }).get("ses_oc_1", workspaceFingerprint(directory))).toMatchObject({
      museSessionId: first.sessionId,
      providerId: "meta",
      profileId: "tbh",
      modelId: "wonder",
      transcriptFingerprints: ["d".repeat(64)],
    });
    expect(second.previousTranscriptFingerprints).toEqual(["d".repeat(64)]);
    await second.release?.();
    await manager.close();
  });

  test("sessionManager.rejectsSecondOpenCodeWriterForSameWorkspace", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = await manager.resolveSession(context("ses_oc_1", directory));

    await expect(manager.resolveSession(context("ses_oc_2", directory))).rejects.toBeInstanceOf(WorkspaceBusyError);
    await first.release?.();
    await manager.close();
  });

  test("sessionManager.requiresUserChoiceForAnUnreconciledPendingCommand", async () => {
    const root = tempRoot();
    const registry = new SessionRegistry({ stateDirectory: root });
    await registry.put({
      openCodeSessionId: "ses_oc_1",
      museSessionId: "ses_muse_existing",
      hostId: "host_old",
      workspaceFingerprint: workspaceFingerprint(join(root, "project")),
      providerId: "meta",
      profileId: "tbh",
      modelId: "wonder",
      transcriptFingerprints: [],
      compactionFingerprints: [],
      pendingCommands: {
        "018f4f17-9c2a-7c1a-a0fd-67a19db5d1f1": { method: "turn/start", fingerprint: "b".repeat(64) },
      },
    });
    const { manager, calls } = managerAt(root);

    await expect(manager.resolveSession(context("ses_oc_1", join(root, "project"))))
      .rejects.toBeInstanceOf(MuseRecoveryChoiceRequiredError);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
    await manager.close();
  });

  test("sessionManager.resumesOnlyAStoredDurableSessionAtItsObservedCursor", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = managerAt(root);
    const binding = await first.manager.resolveSession(context("ses_oc_1", directory));
    await binding.release?.();
    await first.manager.close();

    const restarted = managerAt(root);
    const resumed = await restarted.manager.resolveSession(context("ses_oc_1", directory));

    const resumeCall = restarted.calls.find((call) => call.method === "session/resume");
    expect(resumeCall?.params).toMatchObject({ sessionId: binding.sessionId, cursor: "head-1" });
    expect(restarted.calls.some((call) => call.method === "session/start")).toBe(false);
    expect(resumed.sessionId).toBe(binding.sessionId);
    await resumed.release?.();
    await restarted.manager.close();
  });

  test("sessionManager.doesNotResumeWhenMuseReportsAnUnmappedActiveTurn", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = managerAt(root);
    const binding = await first.manager.resolveSession(context("ses_oc_1", directory));
    await binding.release?.();
    await first.manager.close();

    const restarted = managerAt(root, false, true);
    await expect(restarted.manager.resolveSession(context("ses_oc_1", directory)))
      .rejects.toBeInstanceOf(MuseRecoveryChoiceRequiredError);
    expect(restarted.calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(restarted.calls.some((call) => call.method === "session/start")).toBe(false);
    await restarted.manager.close();
  });

  test("sessionManager.appliesProfileAndModelChangesToTheExistingMuseSession", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager, calls } = managerAt(root);
    const first = await manager.resolveSession(context("ses_oc_1", directory));
    await first.release?.();
    const changed = context("ses_oc_1", directory);
    changed.museSelection = {
      ...changed.museSelection,
      providerId: "meta",
      profileId: "other-profile",
      modelId: "spark",
    };
    const second = await manager.resolveSession(changed);

    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "session/setModel")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "session/setModel").at(-1)?.params.model).toEqual({
      providerId: "meta",
      profileId: "other-profile",
      modelId: "spark",
    });
    expect(second.sessionId).toBe(first.sessionId);
    await second.release?.();
    await manager.close();
  });

  test("sessionManager.neverRepeatsAModelSwitchAfterItsOutcomeBecomesUnknown", async () => {
    const root = tempRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const { manager, calls } = managerAt(root, true);

    await expect(manager.resolveSession(context("ses_oc_1", directory))).rejects.toBeInstanceOf(MspCommandTimeoutError);
    await expect(manager.resolveSession(context("ses_oc_1", directory))).rejects.toBeInstanceOf(MuseRecoveryChoiceRequiredError);
    expect(calls.filter((call) => call.method === "session/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "session/setModel")).toHaveLength(1);
    await manager.close();
  });

  test("sessionManager.rejectsWorkspaceChangeForAnExistingOpenCodeSession", async () => {
    const root = tempRoot();
    const { manager } = managerAt(root);
    const directoryA = join(root, "project-a");
    const directoryB = join(root, "project-b");
    mkdirSync(directoryA);
    mkdirSync(directoryB);
    const first = await manager.resolveSession(context("ses_oc_1", directoryA));
    await first.release?.();

    await expect(manager.resolveSession(context("ses_oc_1", directoryB)))
      .rejects.toThrow(/different workspace/);
    await manager.close();
  });
});
