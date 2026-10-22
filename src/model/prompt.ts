import { createHash } from "node:crypto";
import type { LanguageModelV3FilePart, LanguageModelV3Prompt } from "@ai-sdk/provider";

export interface ContextFragment {
  label: string;
  text: string;
}

export type ExtractedTurnPart =
  | { type: "text"; text: string }
  | { type: "image"; base64Data: string; mediaType: string }
  | { type: "video"; base64Data: string; mediaType: "video/mp4" | "video/quicktime"; totalBytes: number };

export interface ExtractedTurnInput {
  parts: ExtractedTurnPart[];
  nextTranscriptFingerprints: string[];
}

export type PromptInputErrorCode =
  | "transcript-diverged"
  | "no-new-user-input"
  | "invalid-context"
  | "invalid-media"
  | "remote-media"
  | "unsupported-media"
  | "media-too-large"
  | "aborted"
  | "unsupported-response-format"
  | "required-opencode-tool"
  | "unsupported-generation-option";

export interface PromptInputError {
  type: "prompt-error";
  code: PromptInputErrorCode;
  field?: string;
  mediaType?: string;
}

export type ExtractTurnInputResult =
  | ({ ok: true } & ExtractedTurnInput)
  | { ok: false; error: PromptInputError };

export interface ExtractTurnInputOptions {
  maxMediaBytes?: number;
  maxInlineImageBytes?: number;
  signal?: AbortSignal;
}

export interface ModelOptionsInput {
  responseFormat?: { type?: string; [key: string]: unknown };
  toolChoice?: string | { type?: string; toolName?: string; [key: string]: unknown };
  tools?: readonly unknown[];
  [key: string]: unknown;
}

export type ModelOptionsResult =
  | { ok: true; options: { toolsIgnored: boolean; ignoredOptions: string[] } }
  | { ok: false; error: PromptInputError };

export const DEFAULT_MAX_MEDIA_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_INLINE_IMAGE_BYTES = 7 * 1024 * 1024;

function inputError(code: PromptInputErrorCode, fields: { field?: string; mediaType?: string } = {}): PromptInputError {
  return { type: "prompt-error", code, ...fields };
}

function safeMediaType(value: string): string {
  const normalized = value.toLowerCase();
  return /^[a-z0-9.+*-]+\/[a-z0-9.+*-]+$/.test(normalized) ? normalized : "unknown";
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\r\n?/g, "\n").normalize("NFC");
}

function fingerprintMessage(message: LanguageModelV3Prompt[number]): string | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const parts: Array<Record<string, string>> = [];
  for (const part of message.content) {
    if (part.type === "text") {
      parts.push({ type: "text", digest: digestBytes(Buffer.from(normalizeVisibleText(part.text), "utf8")) });
    } else if (part.type === "file") {
      const data = part.data instanceof URL ? part.data.href : part.data;
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      parts.push({ type: "file", mediaType: part.mediaType, digest: digestBytes(bytes) });
    }
    // Reasoning and tool traffic are not user-visible transcript lineage.
  }
  if (parts.length === 0) return undefined;
  return digestBytes(Buffer.from(JSON.stringify({ role: message.role, parts }), "utf8"));
}

function visibleMessages(prompt: LanguageModelV3Prompt): Array<{ message: LanguageModelV3Prompt[number]; fingerprint: string }> {
  const result: Array<{ message: LanguageModelV3Prompt[number]; fingerprint: string }> = [];
  for (const message of prompt) {
    const fingerprint = fingerprintMessage(message);
    if (fingerprint) result.push({ message, fingerprint });
  }
  return result;
}

export function fingerprintVisibleTranscript(prompt: LanguageModelV3Prompt): string[] {
  return visibleMessages(prompt).map((entry) => entry.fingerprint);
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
  const bytes = Buffer.from(value, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  return canonical === value.replace(/=+$/, "") ? bytes : undefined;
}

function fileBytes(part: LanguageModelV3FilePart): { bytes: Uint8Array; mediaType: string } | PromptInputError {
  let data: Uint8Array | string | URL = part.data;
  if (data instanceof URL) {
    if (data.protocol !== "data:") return inputError("remote-media", { mediaType: safeMediaType(part.mediaType) });
    data = data.href;
  }
  if (typeof data !== "string") return { bytes: data, mediaType: part.mediaType };
  if (/^https?:\/\//i.test(data)) return inputError("remote-media", { mediaType: safeMediaType(part.mediaType) });

  let encoded = data;
  let mediaType = part.mediaType;
  if (data.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(data);
    if (!match) return inputError("invalid-media", { mediaType: safeMediaType(part.mediaType) });
    if (match[1] !== part.mediaType && part.mediaType !== "*/*") {
      return inputError("invalid-media", { mediaType: safeMediaType(part.mediaType) });
    }
    mediaType = match[1]!;
    encoded = match[2]!;
  }
  const bytes = decodeBase64(encoded);
  if (!bytes || bytes.byteLength === 0) return inputError("invalid-media", { mediaType: safeMediaType(mediaType) });
  return { bytes, mediaType };
}

function extractFilePart(
  part: LanguageModelV3FilePart,
  limits: { maxMediaBytes: number; maxInlineImageBytes: number },
): ExtractedTurnPart | PromptInputError {
  const mediaType = part.mediaType.toLowerCase();
  if (mediaType.startsWith("audio/") || mediaType === "application/pdf") {
    return inputError("unsupported-media", { mediaType: safeMediaType(mediaType) });
  }
  const decoded = fileBytes(part);
  if ("type" in decoded) return decoded;
  if (decoded.bytes.byteLength > limits.maxMediaBytes) return inputError("media-too-large", { mediaType: safeMediaType(mediaType) });

  if (mediaType.startsWith("image/")) {
    if (!new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]).has(mediaType)) {
      return inputError("unsupported-media", { mediaType: safeMediaType(mediaType) });
    }
    if (decoded.bytes.byteLength > limits.maxInlineImageBytes) return inputError("media-too-large", { mediaType: safeMediaType(mediaType) });
    return { type: "image", base64Data: Buffer.from(decoded.bytes).toString("base64"), mediaType };
  }

  if (mediaType === "video/mp4" || mediaType === "video/quicktime") {
    return {
      type: "video",
      base64Data: Buffer.from(decoded.bytes).toString("base64"),
      mediaType,
      totalBytes: decoded.bytes.byteLength,
    };
  }

  if (mediaType.startsWith("text/")) {
    return { type: "text", text: Buffer.from(decoded.bytes).toString("utf8") };
  }
  return inputError("unsupported-media", { mediaType: safeMediaType(mediaType) });
}

export function extractTurnInput(
  prompt: LanguageModelV3Prompt,
  previousTranscriptFingerprints: readonly string[],
  contextAllowlist: readonly ContextFragment[],
  options: ExtractTurnInputOptions = {},
): ExtractTurnInputResult {
  if (options.signal?.aborted) return { ok: false, error: inputError("aborted") };
  const current = visibleMessages(prompt);
  const currentFingerprints = current.map((entry) => entry.fingerprint);
  let newMessages = current;

  if (previousTranscriptFingerprints.length > 0) {
    if (previousTranscriptFingerprints.length > currentFingerprints.length
      || previousTranscriptFingerprints.some((fingerprint, index) => currentFingerprints[index] !== fingerprint)) {
      return { ok: false, error: inputError("transcript-diverged") };
    }
    newMessages = current.slice(previousTranscriptFingerprints.length);
  } else {
    // On first use in an existing OpenCode session, send only the final user
    // turn; never replay its previous transcript into a new Muse session.
    let lastUserIndex = -1;
    for (let index = 0; index < current.length; index += 1) {
      if (current[index]!.message.role === "user") lastUserIndex = index;
    }
    if (lastUserIndex >= 0) newMessages = current.slice(lastUserIndex);
    else newMessages = [];
  }

  const currentUserMessages = newMessages.filter((entry) => entry.message.role === "user");
  if (currentUserMessages.length === 0) return { ok: false, error: inputError("no-new-user-input") };

  const parts: ExtractedTurnPart[] = [];
  for (const fragment of contextAllowlist) {
    if (options.signal?.aborted) return { ok: false, error: inputError("aborted") };
    if (!fragment.label.trim() || !fragment.text.trim()) return { ok: false, error: inputError("invalid-context") };
    parts.push({ type: "text", text: `[${fragment.label.trim()}]\n${fragment.text}` });
  }

  const limits = {
    maxMediaBytes: options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES,
    maxInlineImageBytes: options.maxInlineImageBytes ?? DEFAULT_MAX_INLINE_IMAGE_BYTES,
  };
  for (const entry of currentUserMessages) {
    if (entry.message.role !== "user") continue;
    for (const part of entry.message.content) {
      if (options.signal?.aborted) return { ok: false, error: inputError("aborted") };
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
      } else if (part.type === "file") {
        const mapped = extractFilePart(part, limits);
        if ("code" in mapped) return { ok: false, error: mapped };
        parts.push(mapped);
      }
    }
  }

  if (options.signal?.aborted) return { ok: false, error: inputError("aborted") };
  if (parts.length === 0) return { ok: false, error: inputError("no-new-user-input") };
  return { ok: true, parts, nextTranscriptFingerprints: currentFingerprints };
}

export function validateModelOptions(options: ModelOptionsInput): ModelOptionsResult {
  if (options.responseFormat?.type === "json") {
    return { ok: false, error: inputError("unsupported-response-format", { field: "responseFormat" }) };
  }
  if (options.responseFormat !== undefined && options.responseFormat.type !== "text") {
    return { ok: false, error: inputError("unsupported-response-format", { field: "responseFormat" }) };
  }
  const toolChoice = options.toolChoice;
  if (typeof toolChoice === "object" && toolChoice !== null
    && (toolChoice.type === "tool" || toolChoice.type === "required")) {
    return { ok: false, error: inputError("required-opencode-tool", { field: "toolChoice" }) };
  }
  if (toolChoice === "required") return { ok: false, error: inputError("required-opencode-tool", { field: "toolChoice" }) };
  const samplingOptions = [
    "maxOutputTokens", "temperature", "topP", "topK", "presencePenalty", "frequencyPenalty", "stopSequences", "seed", "providerOptions",
  ];
  const ignoredOptions = samplingOptions.filter((name) => options[name] !== undefined);
  return {
    ok: true,
    options: { toolsIgnored: (options.tools?.length ?? 0) > 0, ignoredOptions },
  };
}
