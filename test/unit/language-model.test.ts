import { describe, expect, test } from "bun:test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { createMuseLanguageModel, type MuseLanguageRuntime, type MuseTurnSession } from "../../src/model/language-model.js";
import { addRequestContextHeaders } from "../../src/model/context.js";
import { openCodeModelId } from "../../src/catalog.js";
import type { MuseModelSelection, RequestContext } from "../../src/types.js";
import type { MspNotification } from "../../src/msp/client.js";
import { MspCommandRejectedError } from "../../src/errors.js";

const modelID = openCodeModelId("tbh", "muse-wonder-1.0");
const selection: MuseModelSelection = {
  providerId: "meta",
  profileId: "tbh",
  modelId: "muse-wonder-1.0",
  isActive: false,
  isDefault: true,
  defaultReasoningEffort: "high",
  variantsKnown: true,
  variants: ["low", "high"],
};
const selectionIndex = new Map([[modelID, selection]]);

function event(method: string, params: Record<string, unknown>): MspNotification {
  return { jsonrpc: "2.0", method, params };
}

function callOptions(overrides: Record<string, unknown> = {}): LanguageModelV3CallOptions {
  const headers: Record<string, string> = {};
  addRequestContextHeaders(headers, {
    sessionID: "ses_model_test",
    kind: "primary",
    model: { id: modelID, providerID: "muse", variant: "high" },
    headers,
  }, "/workspace/model-test");
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "Return the probe answer." }] }],
    headers,
    tools: [{ type: "function", name: "shell", inputSchema: { type: "object", properties: {} } }],
    toolChoice: { type: "auto" },
    ...overrides,
  } as unknown as LanguageModelV3CallOptions;
}

function fakeRuntime(options: {
  events?: MspNotification[];
  disposition?: string;
  videoChunkBytes?: number;
  onTurnStart?: () => void;
  backgroundWaitAfterForeground?: Promise<void>;
  failTurnStart?: boolean;
  blockSubscription?: boolean;
  failRecordTurnAccepted?: boolean;
  currentSelection?: Pick<MuseModelSelection, "providerId" | "modelId" | "profileId">;
} = {}) {
  const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  const order: string[] = [];
  let released = 0;
  let subscriptionReturns = 0;
  let markReleased!: () => void;
  const releasedPromise = new Promise<void>((resolve) => { markReleased = resolve; });
  let idCounter = 0;
  const host = {
    mintCommandId: () => `018f4f17-9c2a-7c1a-a0fd-67a19db5c0${String(idCounter++).padStart(2, "0")}`,
    async command(method: string, params: Record<string, unknown>) {
      commands.push({ method, params });
      order.push(method);
      if (method === "turn/start") {
        options.onTurnStart?.();
        if (options.failTurnStart) throw new MspCommandRejectedError(method, -32030, "commandRejected", false);
        return { turnId: "turn-1", disposition: options.disposition ?? "started" };
      }
      if (method === "media/upload") return { uploadId: params.uploadId };
      return { status: "accepted" };
    },
    subscribe(sessionId: string, after?: string, signal?: AbortSignal) {
      order.push(after === undefined ? "subscribe-live" : "subscribe-replay");
      if (options.blockSubscription) {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<MspNotification>>((resolve) => {
                signal?.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
              }),
              async return() {
                subscriptionReturns += 1;
                return { done: true, value: undefined } as IteratorResult<MspNotification>;
              },
            };
          },
        };
      }
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (const notification of options.events ?? []) {
              yield notification;
              if (notification.method === "turn/foregroundCompleted" && options.backgroundWaitAfterForeground) {
                await options.backgroundWaitAfterForeground;
              }
            }
          } finally {
            subscriptionReturns += 1;
          }
        },
      };
    },
  };
  const session = {
    host,
    sessionId: "ses_model_test",
    currentSelection: options.currentSelection ?? {
      providerId: "meta",
      modelId: "muse-wonder-1.0",
      profileId: "tbh",
    },
    previousTranscriptFingerprints: [],
    contextAllowlist: [],
    ...(options.failRecordTurnAccepted ? {
      async recordTurnAccepted() { throw new Error("registry write failed"); },
    } : {}),
    async release() { released += 1; markReleased(); },
  };
  const runtime: MuseLanguageRuntime = {
    selectionIndex,
    videoChunkBytes: options.videoChunkBytes,
    async resolveSession() { return session as unknown as MuseTurnSession; },
  };
  return {
    runtime,
    commands,
    order,
    get released() { return released; },
    releasedPromise,
    get subscriptionReturns() { return subscriptionReturns; },
  };
}

const textEvents = (turnId = "turn-1") => [
  event("turn/started", { sessionId: "ses_model_test", turnId }),
  event("item/started", { sessionId: "ses_model_test", item: { itemId: "msg-1", turnId, kind: "agentMessage" } }),
  event("item/delta", { sessionId: "ses_model_test", itemId: "msg-1", field: "text", delta: "Probe " }),
  event("item/delta", { sessionId: "ses_model_test", itemId: "msg-1", field: "text", delta: "answer" }),
  event("item/completed", { sessionId: "ses_model_test", item: { itemId: "msg-1", turnId, kind: "agentMessage", status: "completed", text: "Probe answer" } }),
  event("turn/foregroundCompleted", { sessionId: "ses_model_test", turnId }),
  event("turn/completed", { sessionId: "ses_model_test", turnId, terminal: "completed", usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 0, cachedTokens: 0 } }),
];

describe("Muse LanguageModelV3 bridge", () => {
  test("languageModel.doStreamEmitsV3TextAndNoOpenCodeToolCalls", async () => {
    const fake = fakeRuntime({ events: textEvents() });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doStream(callOptions());
    const reader = result.stream.getReader();
    const parts: Array<Record<string, unknown>> = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value as unknown as Record<string, unknown>);
    }

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start", "text-start", "text-delta", "text-delta", "text-end", "finish",
    ]);
    expect(parts.filter((part) => String(part.type).startsWith("tool-"))).toEqual([]);
    expect(fake.commands.filter((command) => command.method === "turn/start")).toHaveLength(1);
    expect(fake.commands.find((command) => command.method === "turn/start")?.params).toMatchObject({
      sessionId: "ses_model_test",
      reasoningEffort: "high",
      input: [{ type: "text", text: "Return the probe answer." }],
    });
  });

  test("languageModel.doGenerateCollectsTheSameSingleMuseTurn", async () => {
    const fake = fakeRuntime({ events: textEvents() });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions());

    expect(result.content).toEqual([{ type: "text", text: "Probe answer" }]);
    expect(fake.commands.filter((command) => command.method === "turn/start")).toHaveLength(1);
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.preflightContextAndUnsupportedOptionsFailBeforeSessionResolution", async () => {
    let resolutions = 0;
    const fake = fakeRuntime();
    const runtime = {
      ...fake.runtime,
      async resolveSession(context: RequestContext) { resolutions += 1; return fake.runtime.resolveSession(context); },
    };
    const model = createMuseLanguageModel(runtime, modelID);

    await expect(model.doGenerate({ ...callOptions(), responseFormat: { type: "json", schema: { type: "object" } } } as never))
      .rejects.toThrow(/responseFormat/);
    await expect(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "No context" }] }], headers: {} } as never))
      .rejects.toThrow(/context/);
    expect(resolutions).toBe(0);
  });

  test("languageModel.turnStartRejectionClosesThePrestartedViewSubscription", async () => {
    const fake = fakeRuntime({ failTurnStart: true, blockSubscription: true });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const error = await model.doGenerate(callOptions()).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error?.name).toBe("MspCommandRejectedError");
    expect(fake.subscriptionReturns).toBe(1);
    expect(fake.released).toBe(1);
  });

  test("languageModel.dischargesAnAcceptedTurnIfRecordingItsAckFails", async () => {
    const fake = fakeRuntime({ events: textEvents(), failRecordTurnAccepted: true });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const error = await model.doGenerate(callOptions()).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error?.message).toBe("registry write failed");
    expect(fake.commands.some((command) => command.method === "turn/interrupt")).toBe(true);
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.doesNotTurnSessionGenerateIntoALiveMuseTurn", async () => {
    const fake = fakeRuntime();
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const options = callOptions({
      headers: {
        ...((callOptions() as { headers: Record<string, string> }).headers),
        "x-opencode-muse-kind": "generate",
      },
    });

    await expect(model.doGenerate(options)).rejects.toThrow(/generate/);
    expect(fake.commands.some((command) => command.method === "turn/start")).toBe(false);
  });

  test("languageModel.changesModelProfileBeforeTurnButDoesNotChangeStandingEffort", async () => {
    const fake = fakeRuntime({
      events: textEvents(),
      currentSelection: { providerId: "meta", modelId: "other-model", profileId: null },
    });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    await model.doGenerate(callOptions());

    expect(fake.order.indexOf("session/setModel")).toBeLessThan(fake.order.indexOf("turn/start"));
    expect(fake.commands.find((command) => command.method === "session/setModel")?.params.model)
      .toEqual({ providerId: "meta", profileId: "tbh", modelId: "muse-wonder-1.0" });
    expect(fake.commands.some((command) => command.method === "session/setReasoningEffort")).toBe(false);
  });

  test("languageModel.uploadsVideoChunksWithUniqueIdsAndUsesTheSharedReceipt", async () => {
    const fake = fakeRuntime({ events: textEvents(), videoChunkBytes: 3 });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    await model.doGenerate({
      ...callOptions(),
      prompt: [{
        role: "user",
        content: [
          { type: "text", text: "Analyze the clip." },
          { type: "file", mediaType: "video/mp4", data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7]) },
        ],
      }],
    } as never);
    const uploads = fake.commands.filter((command) => command.method === "media/upload");
    const turn = fake.commands.find((command) => command.method === "turn/start")!;
    const input = turn.params.input as Array<Record<string, unknown>>;

    expect(uploads.map((upload) => upload.params.chunkIndex)).toEqual([0, 1, 2]);
    expect(uploads.map((upload) => upload.params.chunkCount)).toEqual([3, 3, 3]);
    expect(new Set(uploads.map((upload) => upload.params.commandId)).size).toBe(3);
    expect(new Set(uploads.map((upload) => upload.params.uploadId).values()).size).toBe(1);
    expect(input.find((part) => part.type === "video")?.uploadId).toBe(uploads[0]?.params.uploadId);
  });

  test("languageModel.reasonsFromCompletedItemsWhenMuseDoesNotSendDeltas", async () => {
    const fake = fakeRuntime({ events: [
      event("item/started", { sessionId: "ses_model_test", item: { itemId: "msg-1", turnId: "turn-1", kind: "agentMessage" } }),
      event("item/completed", { sessionId: "ses_model_test", item: { itemId: "msg-1", turnId: "turn-1", kind: "agentMessage", status: "completed", text: "whole answer" } }),
      event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-1", terminal: "completed" }),
    ] });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions());
    expect(result.content).toEqual([{ type: "text", text: "whole answer" }]);
  });

  test("languageModel.returnsAnEmptySuccessfulResponseWhenNoAssistantTextWasProduced", async () => {
    const fake = fakeRuntime({ events: [
      event("turn/started", { sessionId: "ses_model_test", turnId: "turn-1" }),
      event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-1", terminal: "completed" }),
    ] });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await model.doGenerate(callOptions());

    expect(result.content).toEqual([]);
    expect(result.finishReason).toMatchObject({ unified: "stop", raw: "completed" });
    expect(result.usage).toMatchObject({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
  });

  test("languageModel.mapsMuseTerminalFailureToSafeTypedError", async () => {
    const fake = fakeRuntime({ events: [
      event("turn/completed", {
        sessionId: "ses_model_test",
        turnId: "turn-1",
        terminal: "failed",
        error: { kind: "providerUnavailable", message: "credential-looking-private-detail", retryable: true },
      }),
    ] });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const error = await model.doGenerate(callOptions()).then(() => undefined, (reason: unknown) => reason as Error);

    expect(error?.name).toBe("MuseTurnFailedError");
    expect(error?.message).toContain("providerUnavailable");
    expect(error?.message).not.toContain("credential-looking-private-detail");
  });

  test("languageModel.emitsAnErrorPartForAnAsyncMuseTurnFailure", async () => {
    const fake = fakeRuntime({ events: [
      event("turn/completed", {
        sessionId: "ses_model_test",
        turnId: "turn-1",
        terminal: "failed",
        error: { kind: "providerUnavailable", message: "private provider detail", retryable: true },
      }),
    ] });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const { stream } = await model.doStream(callOptions());
    const reader = stream.getReader();
    const parts: Array<Record<string, unknown>> = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value as unknown as Record<string, unknown>);
    }

    expect(parts.map((part) => part.type)).toEqual(["stream-start", "error", "finish"]);
    expect(JSON.stringify(parts)).not.toContain("private provider detail");
    expect(parts.at(-1)?.finishReason).toMatchObject({ unified: "error", raw: "failed" });
  });

  test("languageModel.finishesAtForegroundAndKeepsTheWorkspaceLeaseUntilBackgroundTerminal", async () => {
    let finishBackground!: () => void;
    const backgroundWait = new Promise<void>((resolve) => { finishBackground = resolve; });
    const fake = fakeRuntime({ events: textEvents(), backgroundWaitAfterForeground: backgroundWait });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const { stream } = await model.doStream(callOptions());
    const reader = stream.getReader();
    const parts: Array<Record<string, unknown>> = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value as unknown as Record<string, unknown>);
    }

    expect(parts.at(-1)?.finishReason).toMatchObject({ raw: "foregroundCompleted", unified: "stop" });
    expect(fake.released).toBe(0);
    finishBackground();
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.doGenerateReturnsForegroundAnswerWhileTheMonitorKeepsTheLease", async () => {
    let finishBackground!: () => void;
    const backgroundWait = new Promise<void>((resolve) => { finishBackground = resolve; });
    const fake = fakeRuntime({ events: textEvents(), backgroundWaitAfterForeground: backgroundWait });
    const model = createMuseLanguageModel(fake.runtime, modelID);
    const result = await Promise.race([
      model.doGenerate(callOptions()),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("doGenerate waited for background completion")), 30)),
    ]);

    expect(result.content).toEqual([{ type: "text", text: "Probe answer" }]);
    expect(result.finishReason).toMatchObject({ raw: "foregroundCompleted", unified: "stop" });
    expect(fake.released).toBe(0);
    finishBackground();
    await fake.releasedPromise;
    expect(fake.released).toBe(1);
  });

  test("languageModel.abortUnqueuesQueuedTurnAndDoesNotInterruptIt", async () => {
    const fake = fakeRuntime({
      disposition: "queued",
      onTurnStart: () => controller.abort(),
      events: [event("turn/unqueued", { sessionId: "ses_model_test", turnId: "turn-1" })],
    });
    const controller = new AbortController();
    const model = createMuseLanguageModel(fake.runtime, modelID);

    const error = await model.doGenerate(callOptions({ abortSignal: controller.signal }))
      .then(() => undefined, (reason: unknown) => reason as Error);
    expect(error?.name).toBe("MuseTurnUnqueuedError");
    expect(fake.commands.some((command) => command.method === "turn/unqueue")).toBe(true);
    expect(fake.commands.some((command) => command.method === "turn/interrupt")).toBe(false);
  });

  test("languageModel.abortInterruptsRunningTurn", async () => {
    const fake = fakeRuntime({
      disposition: "started",
      onTurnStart: () => controller.abort(),
      events: [event("turn/completed", { sessionId: "ses_model_test", turnId: "turn-1", terminal: "cancelled" })],
    });
    const controller = new AbortController();
    const model = createMuseLanguageModel(fake.runtime, modelID);

    await model.doGenerate(callOptions({ abortSignal: controller.signal }));
    expect(fake.commands.some((command) => command.method === "turn/interrupt")).toBe(true);
    expect(fake.commands.some((command) => command.method === "turn/unqueue")).toBe(false);
  });
});
