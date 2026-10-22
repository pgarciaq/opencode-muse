import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, EXPECTED_SCHEMA_FINGERPRINT, type MspHandshake } from "@muse-code/sdk";
import { MspHost } from "../../src/msp/host.js";
import { MuseRecoveryChoiceRequiredError } from "../../src/errors.js";
import { SessionRegistry } from "../../src/session/registry.js";
import { WorkspaceLock } from "../../src/session/workspace-lock.js";
import { MuseSessionManager } from "../../src/session/manager.js";
import { FakeMspTransport } from "../helpers/fake-msp.ts";
import { MspCommandTimeoutError, WorkspaceBusyError } from "../../src/errors.js";
import { createMuseLanguageModel } from "../../src/model/language-model.js";
import { addRequestContextHeaders } from "../../src/model/context.js";
import { openCodeModelId } from "../../src/catalog.js";
import type { MuseModelSelection, RequestContext } from "../../src/types.js";
import type { MuseSessionHost } from "../../src/session/manager.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-muse-recovery-"));
  roots.push(root);
  return root;
}

function requestContext(sessionID: string, directory: string): RequestContext {
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

function createManager(root: string, turnIsActive = false) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let hostCount = 0;
  let museId = 0;
  const registry = new SessionRegistry({ stateDirectory: root });
  const workspaceLock = new WorkspaceLock({ stateDirectory: root });
  const manager = new MuseSessionManager({
    stateDirectory: root,
    registry,
    workspaceLock,
    async createHost({ cwd, args }) {
      hostCount += 1;
      const transport = new FakeMspTransport((request) => {
        calls.push({ method: request.method, params: request.params ?? {} });
        if (request.method === "initialize") {
          return {
            experimentalApi: false,
            grantedCapabilities: [],
            museHome: "/fake/muse-home",
            platformFamily: "unix",
            platformOs: "linux",
            schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT, version: 1 },
            serverInfo: { name: "muse", version: "1.4.11" },
            sessionDurability: "durable",
            userAgent: "fake",
          };
        }
        if (request.method === "session/start") {
          return {
            commandId: request.params?.commandId,
            session: { sessionId: `ses_muse_${++museId}`, activeTurnId: null },
            viewCursor: "cursor-start",
          };
        }
        if (request.method === "session/resume") {
          return {
            commandId: request.params?.commandId,
            session: { sessionId: request.params?.sessionId, activeTurnId: turnIsActive ? "turn-active" : null },
            viewCursor: "cursor-resume",
            history: { mode: "none" },
            pendingRequests: [],
          };
        }
        return { commandId: request.params?.commandId, status: "accepted" };
      });
      const connection = new Connection(transport);
      const handshake = {
        async initialize(params: Parameters<MspHandshake["initialize"]>[0]) {
          const initializeResult = await connection.request("initialize", {
            clientInfo: params.clientInfo,
            capabilities: params.capabilities,
          });
          return {
            connection,
            initializeResult,
            async close() { await connection.close(); },
          };
        },
        async close() { await connection.close(); },
      };
      return MspHost.start({ cwd, args }, { createHandshake: () => handshake });
    },
  });
  return { manager, registry, calls, get hostCount() { return hostCount; }, get museId() { return museId; } };
}

describe("Muse session crash recovery", () => {
  test("sessionRecovery.persistedActiveTurnRequiresUserChoiceAfterRestart", async () => {
    const root = makeRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = createManager(root);
    const binding = await first.manager.resolveSession(requestContext("ses_oc_recovery", directory));
    await binding.recordTurnAccepted?.("018f4f17-9c2a-7c1a-a0fd-67a19db5d1f1", "turn-uncertain");
    await binding.updateCursor?.("cursor-mid-stream");
    await binding.release?.();
    await first.manager.close();

    const restarted = createManager(root);
    await expect(restarted.manager.resolveSession(requestContext("ses_oc_recovery", directory)))
      .rejects.toBeInstanceOf(MuseRecoveryChoiceRequiredError);
    expect(restarted.hostCount).toBe(0);
    expect(restarted.calls.some((call) => call.method === "session/start" || call.method === "turn/start")).toBe(false);
    await restarted.manager.close();
  });

  test("sessionRecovery.reusesDurableIdleSessionWithItsLastObservedCursor", async () => {
    const root = makeRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const first = createManager(root);
    const binding = await first.manager.resolveSession(requestContext("ses_oc_idle", directory));
    await binding.updateCursor?.("cursor-last-observed");
    const museSessionId = binding.sessionId;
    await binding.release?.();
    await first.manager.close();

    const restarted = createManager(root);
    const resumed = await restarted.manager.resolveSession(requestContext("ses_oc_idle", directory));

    expect(resumed.sessionId).toBe(museSessionId);
    expect(restarted.calls.find((call) => call.method === "session/resume")?.params)
      .toMatchObject({ sessionId: museSessionId, cursor: "cursor-last-observed" });
    expect(restarted.calls.some((call) => call.method === "session/start")).toBe(false);
    await resumed.release?.();
    await restarted.manager.close();
  });

  test("sessionRecovery.newOpenCodeForkStartsAnIndependentMuseSessionWithoutReplay", async () => {
    const root = makeRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const manager = createManager(root);
    const parent = await manager.manager.resolveSession(requestContext("ses_oc_parent", directory));
    const parentMuseSession = parent.sessionId;
    await parent.release?.();
    const child = await manager.manager.resolveSession(requestContext("ses_oc_child", directory));

    expect(child.sessionId).not.toBe(parentMuseSession);
    expect(manager.calls.filter((call) => call.method === "session/start")).toHaveLength(2);
    expect(manager.calls.some((call) => call.method === "session/fork")).toBe(false);
    expect(manager.calls.some((call) => call.method === "turn/start")).toBe(false);
    await child.release?.();
    await manager.manager.close();
  });

  test("sessionRecovery.ambiguousTurnStartKeepsWorkspaceLockedAndIsNotReplayed", async () => {
    const root = makeRoot();
    const directory = join(root, "project");
    mkdirSync(directory);
    const registry = new SessionRegistry({ stateDirectory: root });
    const workspaceLock = new WorkspaceLock({ stateDirectory: root });
    let hostCreations = 0;
    let turnStarts = 0;
    const host = {
      initializeResult: { sessionDurability: "durable" },
      mintCommandId: () => `018f4f17-9c2a-7c1a-a0fd-67a19db5d200`,
      async command(method: string, params: Record<string, unknown>) {
        if (method === "session/start") return { session: { sessionId: "ses_muse_uncertain", activeTurnId: null }, viewCursor: "cursor-start" };
        if (method === "session/setModel") return { commandId: params.commandId, status: "accepted" };
        if (method === "turn/start") {
          turnStarts += 1;
          throw new MspCommandTimeoutError(method, 5);
        }
        return { commandId: params.commandId, status: "accepted" };
      },
      async request() { return {}; },
      subscribe(_sessionId: string, _after?: string, signal?: AbortSignal) {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<never>>((resolve) => {
                signal?.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
              }),
              async return() { return { done: true, value: undefined } as IteratorResult<never>; },
            };
          },
        };
      },
      async close() {},
    } as unknown as MuseSessionHost;
    const manager = new MuseSessionManager({
      registry,
      workspaceLock,
      async createHost() { hostCreations += 1; return host; },
    });
    manager.setContextForSession("ses_oc_timeout", { supported: true, fragments: [] });
    const modelId = openCodeModelId("tbh", "wonder");
    const selection: MuseModelSelection = {
      providerId: "meta",
      modelId: "wonder",
      profileId: "tbh",
      isActive: true,
      isDefault: true,
      defaultReasoningEffort: "high",
      variantsKnown: true,
      variants: ["high"],
    };
    const headers: Record<string, string> = {};
    addRequestContextHeaders(headers, {
      sessionID: "ses_oc_timeout",
      kind: "primary",
      model: { id: modelId, providerID: "muse", variant: "high" },
      headers,
    }, directory);
    const model = createMuseLanguageModel({
      selectionIndex: new Map([[modelId, selection]]),
      resolveSession: (ctx) => manager.resolveSession(ctx),
    }, modelId);

    await expect(model.doGenerate({
      headers,
      prompt: [{ role: "user", content: [{ type: "text", text: "Potential side effect." }] }],
    } as never)).rejects.toBeInstanceOf(MspCommandTimeoutError);
    await expect(manager.resolveSession(requestContext("ses_oc_other", directory))).rejects.toBeInstanceOf(WorkspaceBusyError);
    expect((await registry.get("ses_oc_timeout", (await registry.getForOpenCodeSession("ses_oc_timeout"))!.workspaceFingerprint))?.pendingCommands)
      .toHaveProperty("018f4f17-9c2a-7c1a-a0fd-67a19db5d200");

    await manager.close();
    const restarted = new MuseSessionManager({
      registry,
      workspaceLock,
      async createHost() { hostCreations += 1; return host; },
    });
    await expect(restarted.resolveSession(requestContext("ses_oc_timeout", directory)))
      .rejects.toBeInstanceOf(MuseRecoveryChoiceRequiredError);
    expect(hostCreations).toBe(1);
    expect(turnStarts).toBe(1);
    await restarted.close();
  });
});
