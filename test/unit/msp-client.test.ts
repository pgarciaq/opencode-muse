import { afterEach, describe, expect, test } from "bun:test";
import { Connection } from "@muse-code/sdk";
import { MspClient } from "../../src/msp/client.js";
import { MspProtocolError, MspTransportError } from "../../src/errors.js";
import { FakeMspTransport } from "../helpers/fake-msp.ts";

const activeClients: MspClient[] = [];

afterEach(async () => {
  await Promise.all(activeClients.splice(0).map((client) => client.close()));
});

function clientWith(transport = new FakeMspTransport()) {
  const client = new MspClient(new Connection(transport), { commandTimeoutMs: 250 });
  activeClients.push(client);
  return { client, transport };
}

describe("MspClient", () => {
  test("mspClient.commandUsesTheCommandIdEmbeddedInParams", async () => {
    const { client, transport } = clientWith();
    const commandId = "018f4f17-9c2a-7c1a-a0fd-67a19db5c004";

    const result = await client.command("turn/start", {
      commandId,
      sessionId: "ses_probe",
      input: [{ type: "text", text: "probe" }],
    });

    const request = transport.requests.find((item) => item.method === "turn/start");
    expect(request?.params?.commandId).toBe(commandId);
    expect(result).toEqual({});
  });

  test("mspClient.sanitizesCommandIdPayloadMismatchErrors", async () => {
    const { client, transport } = clientWith();
    const commandId = "018f4f17-9c2a-7c1a-a0fd-67a19db5c020";
    await client.command("turn/start", { commandId, sessionId: "ses_probe", input: [{ type: "text", text: "first" }] });

    await expect(client.command("turn/start", {
      commandId,
      sessionId: "ses_probe",
      input: [{ type: "text", text: "different" }],
    })).rejects.toBeInstanceOf(MspProtocolError);
    expect(transport.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  });

  test("mspClient.replaysAfterCursorAndFiltersNotificationsBySession", async () => {
    const { client, transport } = clientWith(new FakeMspTransport((request) =>
      request.method === "view/subscribe" ? { viewCursor: "head" } : {},
    ));
    const iterator = client.subscribe("ses_a", "cursor-1")[Symbol.asyncIterator]();
    const first = iterator.next();
    await transport.waitForRequest((request) => request.method === "view/subscribe");
    transport.notify("future/additiveEvent", { sessionId: "ses_other", value: 1 });
    transport.notify("future/additiveEvent", { sessionId: "ses_a", value: 2 });
    transport.notify("turn/completed", { sessionId: "ses_a", turnId: "turn-1" });

    const event = await first;
    const next = await iterator.next();
    expect(transport.requests.find((request) => request.method === "view/subscribe")?.params).toEqual({
      sessionId: "ses_a",
      after: "cursor-1",
    });
    expect(event.value).toEqual({
      jsonrpc: "2.0",
      method: "future/additiveEvent",
      params: { sessionId: "ses_a", value: 2 },
    });
    expect(next.value?.method).toBe("turn/completed");
    await iterator.return?.();
  });

  test("mspClient.startAttachedSubscriptionDoesNotSendRedundantSubscribe", async () => {
    const { client, transport } = clientWith();
    const iterator = client.subscribe("ses_a")[Symbol.asyncIterator]();
    const next = iterator.next();
    transport.notify("turn/started", { sessionId: "ses_a", turnId: "turn-1" });

    expect((await next).value?.method).toBe("turn/started");
    expect(transport.requests.some((request) => request.method === "view/subscribe")).toBe(false);
    await iterator.return?.();
  });

  test("mspClient.abortStopsOnlyThatSubscription", async () => {
    const { client, transport } = clientWith();
    const abort = new AbortController();
    const iterator = client.subscribe("ses_a", undefined, abort.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    abort.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    transport.notify("turn/started", { sessionId: "ses_a", turnId: "turn-2" });
    expect(client.isClosed).toBe(false);
  });

  test("mspClient.validatesMalformedFramesWithoutExposingTheirContents", async () => {
    const { client, transport } = clientWith();
    transport.deliverRaw('{"jsonrpc":"2.0","method":,"secret":"do-not-log"}');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(client.protocolFailure).toBeInstanceOf(MspProtocolError);
    expect(client.protocolFailure?.message).not.toContain("do-not-log");
    expect(client.isClosed).toBe(true);
    await expect(client.subscribe("ses_a")[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(MspProtocolError);
  });

  test("mspClient.reusesTypedCommandIdsForSessionLifecycleCommands", async () => {
    const { client, transport } = clientWith();
    const methods = ["session/start", "session/resume", "session/fork"];

    for (const [index, method] of methods.entries()) {
      await client.command(method, {
        commandId: `018f4f17-9c2a-7c1a-a0fd-67a19db5c00${index}`,
        sessionId: "ses_probe",
      });
    }

    expect(transport.requests.filter((request) => methods.includes(request.method)).map((request) => request.params?.commandId))
      .toEqual([
        "018f4f17-9c2a-7c1a-a0fd-67a19db5c000",
        "018f4f17-9c2a-7c1a-a0fd-67a19db5c001",
        "018f4f17-9c2a-7c1a-a0fd-67a19db5c002",
      ]);
  });

  test("mspClient.rejectsMissingOrNonStringCommandIdsBeforeSending", async () => {
    const { client, transport } = clientWith();
    await expect(client.command("turn/start", { commandId: 42 } as unknown as { commandId: string } & Record<string, unknown>))
      .rejects.toBeInstanceOf(MspProtocolError);
    expect(transport.requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  test("mspClient.closeSanitizesUnderlyingTransportErrors", async () => {
    const connection = {
      command: async () => ({}),
      request: async () => ({}),
      mintCommandId: () => "018f4f17-9c2a-7c1a-a0fd-67a19db5c025",
      onNotification() {},
      onProtocolError() {},
      async close() { throw new Error("credential-looking-value"); },
    };
    const client = new MspClient(connection);

    const error = await client.close().then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(MspTransportError);
    expect((error as Error).message).not.toContain("credential-looking-value");
  });
});
