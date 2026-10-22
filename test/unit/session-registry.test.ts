import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../../src/session/registry.js";
import { RegistryValidationError, RegistryWorkspaceMismatchError } from "../../src/errors.js";

const roots: string[] = [];
const workspaceA = "a".repeat(64);
const workspaceB = "b".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-muse-registry-"));
  roots.push(root);
  return root;
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    openCodeSessionId: "ses_opencode_1",
    museSessionId: "ses_muse_1",
    hostId: "host_1",
    workspaceFingerprint: workspaceA,
    providerId: "meta",
    modelId: "flint-40b-free",
    viewCursor: "opaque-cursor-value",
    activeTurnId: "turn_1",
    transcriptFingerprints: ["1".repeat(64), "2".repeat(64)],
    compactionFingerprints: ["3".repeat(64)],
    pendingCommands: {
      "018f4f17-9c2a-7c1a-a0fd-67a19db5c020": {
        method: "turn/start",
        fingerprint: "4".repeat(64),
      },
    },
    ...overrides,
  };
}

describe("SessionRegistry", () => {
  test("sessionRegistry.writesVersionedPrivateAtomicStateAndReloads", async () => {
    const root = makeRoot();
    const registry = new SessionRegistry({ stateDirectory: root });
    const value = entry();
    await registry.put(value);

    const files = readdirSync(join(root, "sessions"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("ses_opencode_1");
    expect(statSync(join(root, "sessions"), { throwIfNoEntry: false })?.mode! & 0o777).toBe(0o700);
    expect(statSync(join(root, "sessions", files[0]!)).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(readFileSync(join(root, "sessions", files[0]!), "utf8")) as { version?: number };
    expect(persisted.version).toBe(1);
    expect(await new SessionRegistry({ stateDirectory: root }).get("ses_opencode_1", workspaceA)).toMatchObject(value);
    expect(readdirSync(join(root, "sessions")).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("sessionRegistry.rejectsAWorkspaceFingerprintMismatch", async () => {
    const registry = new SessionRegistry({ stateDirectory: makeRoot() });
    await registry.put(entry());

    await expect(registry.get("ses_opencode_1", workspaceB)).rejects.toBeInstanceOf(RegistryWorkspaceMismatchError);
  });

  test("sessionRegistry.updatesCursorAndPendingCommandByExactId", async () => {
    const registry = new SessionRegistry({ stateDirectory: makeRoot() });
    await registry.put(entry({ pendingCommands: {} }));
    await registry.updateCursor("ses_opencode_1", workspaceA, "cursor-2");
    await registry.recordPendingCommand("ses_opencode_1", workspaceA, {
      commandId: "018f4f17-9c2a-7c1a-a0fd-67a19db5c021",
      method: "turn/start",
      fingerprint: "5".repeat(64),
    });
    await registry.clearPendingCommand("ses_opencode_1", workspaceA, "018f4f17-9c2a-7c1a-a0fd-67a19db5c021");

    const loaded = await registry.get("ses_opencode_1", workspaceA);
    expect(loaded?.viewCursor).toBe("cursor-2");
    expect(loaded?.pendingCommands).toEqual({});
  });

  test("sessionRegistry.persistsOnlyThePendingCompactionOutputFingerprint", async () => {
    const root = makeRoot();
    const registry = new SessionRegistry({ stateDirectory: root });
    await registry.put(entry());
    const candidate = "6".repeat(64);

    await registry.recordCompactionCandidate("ses_opencode_1", candidate);
    expect(await registry.get("ses_opencode_1", workspaceA)).toMatchObject({ compactionFingerprints: [candidate] });
    await registry.clearCompactionCandidate("ses_opencode_1", candidate);
    expect(await registry.get("ses_opencode_1", workspaceA)).toMatchObject({ compactionFingerprints: [] });
  });

  test("sessionRegistry.rejectsPromptOrUnknownFieldsBeforePersistence", async () => {
    const root = makeRoot();
    const registry = new SessionRegistry({ stateDirectory: root });

    await expect(registry.put(entry({ prompt: "do-not-persist-this" }))).rejects.toBeInstanceOf(RegistryValidationError);
    expect(existsSync(join(root, "sessions"))).toBe(false);
  });

  test("sessionRegistry.quarantinesCorruptEntryWithoutLoggingItsContents", async () => {
    const root = makeRoot();
    const sessions = join(root, "sessions");
    await new SessionRegistry({ stateDirectory: root }).put(entry());
    const filename = readdirSync(sessions).find((name) => name.endsWith(".json"))!;
    const file = join(sessions, filename);
    writeFileSync(file, "{ malformed prompt secret", { mode: 0o600 });

    expect(await new SessionRegistry({ stateDirectory: root }).get("ses_opencode_1", workspaceA)).toBeUndefined();
    expect(readdirSync(sessions).some((name) => name.startsWith(`${filename}.corrupt-`))).toBe(true);
    await new SessionRegistry({ stateDirectory: root }).put(entry());
    expect(await new SessionRegistry({ stateDirectory: root }).get("ses_opencode_1", workspaceA)).toMatchObject(entry());
  });

  test("sessionRegistry.resolvesStateDirectoryUsingXdgAndPlatformDefaults", () => {
    expect(SessionRegistry.resolveStateDirectory({
      env: { XDG_DATA_HOME: "/custom/data" },
      homeDirectory: "/home/test",
      platform: "linux",
    })).toBe("/custom/data/opencode-muse");
    expect(SessionRegistry.resolveStateDirectory({
      env: {},
      homeDirectory: "/home/test",
      platform: "linux",
    })).toBe("/home/test/.local/share/opencode-muse");
    expect(SessionRegistry.resolveStateDirectory({
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      homeDirectory: "C:\\Users\\test",
      platform: "win32",
    })).toBe("C:\\Users\\test\\AppData\\Local\\opencode-muse");
  });

  test("sessionRegistry.refusesToWriteInsideMuseConfiguration", () => {
    expect(() => new SessionRegistry({
      stateDirectory: "/home/test/.config/muse/plugin-state",
      env: {},
      homeDirectory: "/home/test",
      platform: "linux",
    })).toThrow(RegistryValidationError);
    expect(() => new SessionRegistry({
      stateDirectory: "/custom/config/muse/plugin-state",
      env: { XDG_CONFIG_HOME: "/custom/config" },
      homeDirectory: "/home/test",
      platform: "linux",
    })).toThrow(RegistryValidationError);
  });
});
