import { createHash } from "node:crypto";

export interface VisiblePromptMessage {
  role?: string;
  content?: unknown;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").normalize("NFC");
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytesForFileData(data: unknown): Uint8Array | string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof URL) return data.href;
  return undefined;
}

function visibleParts(content: unknown): Array<Record<string, string>> {
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(parts)) return [];
  const result: Array<Record<string, string>> = [];
  for (const rawPart of parts) {
    if (typeof rawPart !== "object" || rawPart === null) continue;
    const part = rawPart as { type?: unknown; text?: unknown; mediaType?: unknown; data?: unknown };
    if (part.type === "text" && typeof part.text === "string") {
      result.push({ type: "text", digest: hash(normalizeText(part.text)) });
    } else if (part.type === "file" && typeof part.mediaType === "string") {
      const bytes = bytesForFileData(part.data);
      if (bytes !== undefined) result.push({ type: "file", mediaType: part.mediaType, digest: hash(bytes) });
    }
    // Reasoning, tool calls/results, and system boilerplate are not visible
    // user/assistant transcript lineage.
  }
  return result;
}

export function fingerprintTranscript(prompt: readonly VisiblePromptMessage[]): string[] {
  const fingerprints: string[] = [];
  for (const message of prompt) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const parts = visibleParts(message.content);
    if (parts.length === 0) continue;
    fingerprints.push(hash(JSON.stringify({ role: message.role, parts })));
  }
  return fingerprints;
}

export function fingerprintCompactionOutput(summary: string): string {
  return hash(normalizeText(summary));
}

export function promptContainsCompactionFingerprint(
  prompt: readonly VisiblePromptMessage[],
  candidateFingerprint: string,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(candidateFingerprint)) return false;
  for (const message of prompt) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const parts = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
    if (!Array.isArray(parts)) continue;
    for (const rawPart of parts) {
      if (typeof rawPart !== "object" || rawPart === null) continue;
      const part = rawPart as { type?: unknown; text?: unknown };
      if (part.type === "text" && typeof part.text === "string"
        && fingerprintCompactionOutput(part.text) === candidateFingerprint) return true;
    }
  }
  return false;
}

export type TranscriptReconciliation = "same" | "compacted" | "diverged";

export function reconcileTranscript(
  previous: readonly string[],
  current: readonly string[],
  pendingCompactionFingerprints: readonly string[],
  prompt?: readonly VisiblePromptMessage[],
): TranscriptReconciliation {
  if (previous.length <= current.length && previous.every((fingerprint, index) => current[index] === fingerprint)) return "same";
  if (prompt && pendingCompactionFingerprints.some((candidate) => promptContainsCompactionFingerprint(prompt, candidate))) {
    return "compacted";
  }
  return "diverged";
}
