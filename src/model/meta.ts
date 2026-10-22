import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

export type MetaRequestClass = "title" | "compaction" | "unsupported-generate" | "agent";

interface PromptMessageLike {
  role?: string;
  content?: unknown;
}

const DEFAULT_TITLE = "Muse session";
const MAX_TITLE_CODEPOINTS = 72;
const MAX_DIGEST_CODEPOINTS = 12_000;
const DIGEST_HEADER = "Transcript digest (local heuristic; not semantic):\n";
const DIGEST_OMISSION = "[Omitted earlier content; no facts inferred.]";

function promptMessages(prompt: readonly PromptMessageLike[] | LanguageModelV3Prompt): readonly PromptMessageLike[] {
  return prompt as readonly PromptMessageLike[];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const record = part as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function allText(prompt: readonly PromptMessageLike[] | LanguageModelV3Prompt, role?: string): string {
  return promptMessages(prompt)
    .filter((message) => role === undefined || message.role === role)
    .map((message) => textFromContent(message.content))
    .filter((text) => text.length > 0)
    .join("\n");
}

function detectPromptKind(prompt: readonly PromptMessageLike[] | LanguageModelV3Prompt): "title" | "compaction" | undefined {
  const system = allText(prompt, "system").toLowerCase();
  const user = allText(prompt, "user").toLowerCase();
  if (
    system.includes("title generator")
    || system.includes("generate a short title")
    || system.includes("generate a concise title")
    || system.includes("output only a thread title")
  ) return "title";
  if (
    system.includes("anchored context summarization")
    || system.includes("summarizing, compacting, or merging context")
    || system.includes("tasked with summarizing conversations")
    || system.includes("summarize what was done in this conversation")
    || user.includes("this summary will be the only context available when the conversation continues")
    || user.includes("create a detailed summary for continuing this coding session")
    || user.includes("anchored summary below using the conversation history")
    || user.includes("<previous-summary>")
  ) return "compaction";
  return undefined;
}

/** Prefer the correlated kind; prompt-shape fallback is intentionally narrow. */
export function classifyMetaRequest(
  kind: string | undefined,
  prompt: readonly PromptMessageLike[] | LanguageModelV3Prompt,
): MetaRequestClass {
  if (kind === "title") return "title";
  if (kind === "compaction") return "compaction";
  if (kind === "primary" || kind === "agent") return "agent";
  if (kind === "generate" || kind === undefined || kind.length === 0) {
    const detected = detectPromptKind(prompt);
    if (detected) return detected;
    return "unsupported-generate";
  }
  return "unsupported-generate";
}

/** Local, zero-model-call title from the first user-authored message only. */
export function makeLocalTitle(prompt: readonly PromptMessageLike[] | LanguageModelV3Prompt): string {
  const firstUser = promptMessages(prompt).find((message) => message.role === "user");
  const text = textFromContent(firstUser?.content).replace(/\s+/g, " ").trim();
  if (!text) return DEFAULT_TITLE;
  const points = Array.from(text);
  if (points.length <= MAX_TITLE_CODEPOINTS) return text;
  const clipped = points.slice(0, MAX_TITLE_CODEPOINTS - 1).join("").trimEnd();
  const wordBoundary = clipped.lastIndexOf(" ");
  return `${(wordBoundary > MAX_TITLE_CODEPOINTS / 2 ? clipped.slice(0, wordBoundary) : clipped).trimEnd()}…`;
}

interface DigestMessage {
  role: "user" | "assistant";
  text: string;
}

function digestMessages(prompt: readonly PromptMessageLike[] | LanguageModelV3Prompt): DigestMessage[] {
  return promptMessages(prompt)
    .filter((message): message is PromptMessageLike & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, text: textFromContent(message.content).trim() }))
    .filter((message) => message.text.length > 0);
}

function codepoints(text: string): string[] {
  return Array.from(text);
}

function truncate(text: string, maxCodepoints: number): string {
  const points = codepoints(text);
  if (points.length <= maxCodepoints) return text;
  if (maxCodepoints <= 1) return "…".slice(0, maxCodepoints);
  return `${points.slice(0, maxCodepoints - 1).join("")}…`;
}

function completeExchangePairs(messages: readonly DigestMessage[], initialIndex: number): Array<[DigestMessage, DigestMessage]> {
  const pairs: Array<[DigestMessage, DigestMessage]> = [];
  let user: DigestMessage | undefined;
  for (let index = initialIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      user = message;
    } else if (user) {
      pairs.push([user, message]);
      user = undefined;
    }
  }
  return pairs;
}

/**
 * Deterministic local transcript digest. It is bookkeeping, not synthesis:
 * no tools, system prompts, hidden reasoning, or inferred decisions are added.
 */
export function makeCompactionDigest(
  prompt: readonly PromptMessageLike[] | LanguageModelV3Prompt,
  maxOutputTokens?: number,
): string {
  const tokenBudget = maxOutputTokens === undefined || !Number.isFinite(maxOutputTokens)
    ? 1_024
    : Math.floor(maxOutputTokens);
  const maxCodepoints = Math.min(MAX_DIGEST_CODEPOINTS, tokenBudget);
  const messages = digestMessages(prompt);
  if (maxCodepoints < DIGEST_HEADER.length + DIGEST_OMISSION.length + 8) {
    throw new Error("Compaction output budget is too small for a truthful labeled digest");
  }
  if (messages.length === 0) {
    const empty = `${DIGEST_HEADER}No user/assistant text was available.`;
    if (codepoints(empty).length > maxCodepoints) throw new Error("Compaction output budget is too small for a truthful labeled digest");
    return empty;
  }

  const initialIndex = messages.findIndex((message) => message.role === "user");
  const firstIndex = initialIndex >= 0 ? initialIndex : 0;
  const initial = messages[firstIndex]!;
  const initialBlock = `${initialIndex >= 0 ? "Initial request" : "Initial visible message"}: ${initial.text}`;
  const pairs = completeExchangePairs(messages, firstIndex);
  const completeLines = [initialBlock, ...pairs.map(([user, assistant]) => `User: ${user.text}\nAssistant: ${assistant.text}`)];
  const complete = `${DIGEST_HEADER}${completeLines.join("\n\n")}`;
  if (codepoints(complete).length <= maxCodepoints) return complete;

  const fixedCost = codepoints(DIGEST_HEADER).length + codepoints(DIGEST_OMISSION).length + 2;
  const bodyBudget = maxCodepoints - fixedCost;
  const initialLabel = `${initialIndex >= 0 ? "Initial request" : "Initial visible message"}: `;
  const initialContentBudget = Math.min(codepoints(initial.text).length, Math.max(1, Math.floor(bodyBudget * 0.2)));
  const selected = [initialLabel + truncate(initial.text, initialContentBudget)];
  let remaining = bodyBudget - codepoints(selected[0]!).length;
  const selectedPairs: string[] = [];
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    const [user, assistant] = pairs[index]!;
    const block = `User: ${user.text}\nAssistant: ${assistant.text}`;
    const separatorCost = 2;
    const cost = codepoints(block).length + separatorCost;
    if (cost > remaining) {
      if (selectedPairs.length === 0 && remaining > 32) {
        const prefixCost = codepoints("User: \nAssistant: ").length + separatorCost;
        const textBudget = remaining - prefixCost;
        const userBudget = Math.floor(textBudget / 2);
        const assistantBudget = textBudget - userBudget;
        selectedPairs.unshift(`User: ${truncate(user.text, userBudget)}\nAssistant: ${truncate(assistant.text, assistantBudget)}`);
        remaining = 0;
      }
      break;
    }
    selectedPairs.unshift(block);
    remaining -= cost;
  }
  selected.push(...selectedPairs);
  const result = `${DIGEST_HEADER}${selected.join("\n\n")}\n${DIGEST_OMISSION}`;
  if (codepoints(result).length > maxCodepoints) {
    throw new Error("Compaction output budget is too small for a truthful labeled digest");
  }
  return result;
}
