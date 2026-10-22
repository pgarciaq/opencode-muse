import { describe, expect, test } from "bun:test";
import { Connection, EXPECTED_SCHEMA_FINGERPRINT, type MspHandshake } from "@muse-code/sdk";
import { MspHost } from "../../src/msp/host.js";
import { MspCommandTimeoutError, MspSchemaMismatchError, MspStartupTimeoutError, MspTransportError } from "../../src/errors.js";
import { FakeMspTransport } from "../helpers/fake-msp.ts";

function fakeHandshake(
  transport: FakeMspTransport,
  initialized: Record<string, unknown> = { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } },
  exited: Promise<unknown> = new Promise(() => {}),
) {
  let closeCount = 0;
  const connection = new Connection(transport);
  return {
    get closeCount() { return closeCount; },
    handshake: {
      async initialize(params: Parameters<MspHandshake["initialize"]>[0]) {
        const result = await connection.request("initialize", { clientInfo: params.clientInfo, capabilities: params.capabilities });
        return {
          connection,
          initializeResult: Object.keys(result).length > 0 ? result : initialized,
          params,
          exited,
          async close() {
            closeCount += 1;
            await connection.close();
          },
        };
      },
      async close() {
        closeCount += 1;
      },
    },
  };
}

describe("MspHost", () => {
  test("mspHost.initializesThePinnedSdkConnectionBeforeReturning", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ cwd: "/workspace", startupTimeoutMs: 250 }, {
      createHandshake: () => fake.handshake,
    });

    const clientInfo = transport.requests.find((request) => request.method === "initialize")?.params?.clientInfo as { name?: string; version?: string };
    expect(clientInfo).toEqual({ name: "opencode_muse", version: "0.1.0" });
    expect(clientInfo.name).toMatch(/^[a-z0-9_]+$/);
    expect(host.initializeResult).toEqual({ schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } });
    await host.close();
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.mintsCommandIdsFromItsOwnSdkConnection", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    const commandId = host.mintCommandId();

    expect(commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await host.close();
  });

  test("mspHostCanExplicitlyDeclineUnsupportedStructuredUserInputDialogs", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ capabilities: { userInputDialogs: false } }, {
      createHandshake: () => fake.handshake,
    });
    const initialize = transport.requests.find((request) => request.method === "initialize");

    expect(initialize?.params?.capabilities).toMatchObject({ userInputDialogs: false });
    await host.close();
  });

  test("mspHost.startTimeoutClosesTheHalfStartedHandshake", async () => {
    let closeCount = 0;
    const hostPromise = MspHost.start({ startupTimeoutMs: 10 }, {
      createHandshake: () => ({
        initialize: () => new Promise(() => {}),
        async close() { closeCount += 1; },
      }),
    });

    await expect(hostPromise).rejects.toBeInstanceOf(MspStartupTimeoutError);
    expect(closeCount).toBe(1);
  });

  test("mspHost.commandTimeoutPoisonsAndClosesTheAmbiguousHost", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : new Promise(() => {}));
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({ commandTimeoutMs: 10 }, { createHandshake: () => fake.handshake });

    await expect(host.command("turn/start", {
      commandId: "018f4f17-9c2a-7c1a-a0fd-67a19db5c004",
      sessionId: "ses_probe",
      input: [{ type: "text", text: "probe" }],
    })).rejects.toBeInstanceOf(MspCommandTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.isClosed).toBe(true);
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.forwardsStartResumeAndForkWithTheirExactCommandIds", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    const ids = [
      "018f4f17-9c2a-7c1a-a0fd-67a19db5c010",
      "018f4f17-9c2a-7c1a-a0fd-67a19db5c011",
      "018f4f17-9c2a-7c1a-a0fd-67a19db5c012",
    ];

    await host.command("session/start", { commandId: ids[0]!, workspaceRoot: "/workspace" });
    await host.command("session/resume", { commandId: ids[1]!, sessionId: "ses_probe" });
    await host.command("session/fork", { commandId: ids[2]!, sessionId: "ses_probe", cutPoint: { lastTurnId: "turn-1" } });

    expect(transport.requests.filter((request) => ["session/start", "session/resume", "session/fork"].includes(request.method))
      .map((request) => request.params?.commandId)).toEqual(ids);
    await host.close();
  });

  test("mspHost.closeIsIdempotent", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    await Promise.all([host.close(), host.close(), host.close()]);
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.exposesOnlySanitizedChildExitFields", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport, { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }, Promise.resolve({
      kind: "crash",
      exitCode: 3,
      exitSignal: null,
      stderrTail: ["credential-looking-value"],
    }));
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    const exit = await host.exited;

    expect(exit).toEqual({ kind: "crash", exitCode: 3, exitSignal: null });
    expect(JSON.stringify(exit)).not.toContain("credential-looking-value");
    expect(host.isClosed).toBe(true);
  });

  test("mspHost.rejectsAChangedServedSchemaAndClosesTheRuntime", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: "sha256:changed" } }
      : {});
    const fake = fakeHandshake(transport);

    await expect(MspHost.start({}, { createHandshake: () => fake.handshake }))
      .rejects.toBeInstanceOf(MspSchemaMismatchError);
    expect(fake.closeCount).toBe(1);
  });

  test("mspHost.closeReportsFailureWithoutLeakingRuntimeText", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const connection = new Connection(transport);
    const host = await MspHost.start({}, {
      createHandshake: () => ({
        async initialize(params: Parameters<MspHandshake["initialize"]>[0]) {
          const initializeResult = await connection.request("initialize", {
            clientInfo: params.clientInfo,
            capabilities: params.capabilities,
          });
          return {
            connection,
            initializeResult,
            async close() { throw new Error("credential-looking-value"); },
          };
        },
        async close() {},
      }),
    });

    await expect(host.close()).rejects.toBeInstanceOf(MspTransportError);
    expect(host.isClosed).toBe(true);
  });

  test("mspHost.closesTheChildAfterAProtocolViolation", async () => {
    const transport = new FakeMspTransport((request) => request.method === "initialize"
      ? { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT } }
      : {});
    const fake = fakeHandshake(transport);
    const host = await MspHost.start({}, { createHandshake: () => fake.handshake });
    transport.deliverRaw("not-json");

    for (let attempt = 0; attempt < 20 && !host.isClosed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(host.isClosed).toBe(true);
    expect(fake.closeCount).toBe(1);
  });
});
