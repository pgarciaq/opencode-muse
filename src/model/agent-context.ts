import type { ContextFragment } from "./prompt.js";

export interface AgentContextResult {
  supported: boolean;
  fragments: ContextFragment[];
}

const STOCK_AGENT_PROMPT = /^\s*You are (?:an AI agent running in OpenCode|OpenCode|opencode)\b/i;
const MODEL_IDENTITY_HEADING = /^# Your Model[\t ]*$/im;
const KNOWN_BUILTIN_AGENTS = new Set(["build", "plan", "general", "explore"]);

function systemText(systemParts: readonly unknown[]): string {
  return systemParts
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Forward only a custom agent's bounded prompt prefix. Stock OpenCode prompts,
 * tool catalogs, and unknown system layouts are never copied into Muse input.
 */
export function extractAllowedAgentContext(agent: string, systemParts: readonly unknown[]): AgentContextResult {
  const system = systemText(systemParts);
  const identity = MODEL_IDENTITY_HEADING.exec(system);
  if (identity) {
    const prefix = system.slice(0, identity.index).trim();
    if (!prefix || STOCK_AGENT_PROMPT.test(prefix)) return { supported: true, fragments: [] };
    return {
      supported: true,
      fragments: [{ label: "OpenCode agent instructions", text: prefix }],
    };
  }

  if (STOCK_AGENT_PROMPT.test(system) || KNOWN_BUILTIN_AGENTS.has(agent)) {
    return { supported: true, fragments: [] };
  }
  return { supported: false, fragments: [] };
}
