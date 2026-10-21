// OpenCode 2.1.2 .js plugin probe for model.request -> LanguageModelV3 option correlation.
// It emits a fixed response and records only hashes/allowlisted metadata.
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const PROVIDER_ID = "correlation-probe";
const LOG_PATH = process.env.OPENCODE_MUSE_CORRELATION_LOG ?? "/tmp/opencode/muse-correlation/events.jsonl";
const PREFIX = "x-muse-probe-";

function hash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}

function record(event) {
  try {
    mkdirSync(new URL(".", `file://${LOG_PATH}`).pathname, { recursive: true });
  } catch {
    // The caller creates the log directory; do not surface file paths or data.
  }
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify(event)}\n`);
  } catch {
    // Probe failures are reported by the missing record assertion.
  }
}

function encode(values) {
  return hash(JSON.stringify(values));
}

function readHeader(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(`${PREFIX}${name}`) ?? "";
  const wanted = `${PREFIX}${name}`.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) return String(value ?? "");
  }
  return "";
}

function valuesFromRequest(request, directory) {
  const model = request.model ?? {};
  return {
    sessionID: String(request.sessionID ?? ""),
    directory: String(directory ?? ""),
    kind: String(request.kind ?? ""),
    modelID: String(model.id ?? ""),
    providerID: String(model.providerID ?? PROVIDER_ID),
    profileID: String(model.profileID ?? model.profileId ?? ""),
    variant: String(model.variant ?? ""),
  };
}

function valuesFromCallOptions(headers) {
  return {
    sessionID: readHeader(headers, "session-id"),
    directory: readHeader(headers, "directory"),
    kind: readHeader(headers, "kind"),
    modelID: readHeader(headers, "model-id"),
    providerID: readHeader(headers, "provider-id"),
    profileID: readHeader(headers, "profile-id"),
    variant: readHeader(headers, "variant"),
  };
}

function logModelCall(method, options) {
  const values = valuesFromCallOptions(options.headers);
  const expected = readHeader(options.headers, "signature");
  const observed = encode(values);
  const requiredPresent = Boolean(
    values.sessionID && values.directory && values.kind && values.modelID && values.providerID && values.variant,
  );
  const matched = Boolean(expected && expected === observed && requiredPresent);
  record({
    phase: "model",
    method,
    nonceHash: hash(readHeader(options.headers, "nonce")),
    signatureMatch: matched,
    sessionHash: hash(values.sessionID),
    directoryHash: hash(values.directory),
    kind: values.kind || null,
    modelID: values.modelID || null,
    providerID: values.providerID || null,
    profilePresent: Boolean(values.profileID),
    variant: values.variant || null,
  });
  return matched;
}

function makeModel(modelID) {
  return {
    specVersion: "v3",
    provider: PROVIDER_ID,
    modelId: modelID,
    async doGenerate(options = {}) {
      const matched = logModelCall("doGenerate", options);
      return {
        content: [{ type: "text", text: matched ? "CORRELATION_OK doGenerate" : "CORRELATION_MISSING doGenerate" }],
        finishReason: { unified: "stop" },
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 0 },
        warnings: [],
      };
    },
    async doStream(options = {}) {
      const matched = logModelCall("doStream", options);
      const text = matched ? "CORRELATION_OK doStream" : "CORRELATION_MISSING doStream";
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "corr-0" });
          controller.enqueue({ type: "text-delta", id: "corr-0", delta: text });
          controller.enqueue({ type: "text-end", id: "corr-0" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop" },
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 0 },
          });
          controller.close();
        },
      });
      return { stream };
    },
  };
}

export function createCorrelationProbe() {
  return { languageModel: (modelID) => makeModel(modelID) };
}

export const CorrelationProbePlugin = {
  id: "correlation-probe",
  async setup(ctx) {
    const directory = ctx.location.directory;
    await ctx.provider.transform((providers) => {
      providers.add({
        info: {
          id: PROVIDER_ID,
          name: "Correlation Probe",
          activation: "enabled",
          package: `aisdk:${import.meta.url}`,
          settings: { baseURL: "http://127.0.0.1:1/v1", apiKey: "unused", provider: PROVIDER_ID },
        },
        models: [{
          id: "echo",
          modelID: "echo",
          providerID: PROVIDER_ID,
          name: "Correlation Echo",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [{ id: "minimal", settings: {} }],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 64000, output: 4096 },
        }],
      });
    });

    await ctx.aisdk.hook("sdk", async (input) => {
      if (!input.sdk) input.sdk = createCorrelationProbe(input.options);
    }, { providerID: PROVIDER_ID });

    await ctx.aisdk.hook("language", async (input) => {
      input.language = makeModel(input.model?.id ?? "echo");
    }, { providerID: PROVIDER_ID });

    await ctx.session.hook("model.request", async (request) => {
      const values = valuesFromRequest(request, directory);
      const nonce = randomUUID();
      const signature = encode(values);
      const headers = request.headers ?? (request.headers = {});
      headers[`${PREFIX}session-id`] = values.sessionID;
      headers[`${PREFIX}directory`] = values.directory;
      headers[`${PREFIX}kind`] = values.kind;
      headers[`${PREFIX}model-id`] = values.modelID;
      headers[`${PREFIX}provider-id`] = values.providerID;
      headers[`${PREFIX}profile-id`] = values.profileID;
      headers[`${PREFIX}variant`] = values.variant;
      headers[`${PREFIX}nonce`] = nonce;
      headers[`${PREFIX}signature`] = signature;
      record({
        phase: "hook",
        nonceHash: hash(nonce),
        signature,
        sessionHash: hash(values.sessionID),
        directoryHash: hash(values.directory),
        kind: values.kind || null,
        modelID: values.modelID || null,
        providerID: values.providerID || null,
        profilePresent: Boolean(values.profileID),
        variant: values.variant || null,
      });
    }, { providerID: PROVIDER_ID });
  },
};

export default CorrelationProbePlugin;
