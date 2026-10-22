import { describe, expect, test } from "bun:test";
import { extractAllowedAgentContext } from "../../src/model/agent-context.js";

describe("OpenCode agent context allowlist", () => {
  test("context.extractsOnlyTheSelectedCustomAgentPreamble", () => {
    const result = extractAllowedAgentContext("security-reviewer", [
      { type: "text", text: "Check for data leaks and cite exact files." },
      { type: "text", text: "# Your Model\nModel selection metadata follows." },
      { type: "text", text: "# Code Mode\n## Available tools\n- shell" },
    ]);

    expect(result).toEqual({
      supported: true,
      fragments: [{ label: "OpenCode agent instructions", text: "Check for data leaks and cite exact files." }],
    });
    expect(JSON.stringify(result)).not.toContain("Available tools");
  });

  test("context.doesNotForwardTheStockOpenCodeAgentPrompt", () => {
    const result = extractAllowedAgentContext("build", [
      { type: "text", text: "You are an AI agent running in OpenCode. Use workspace tools." },
      { type: "text", text: "# Your Model\nprovider metadata" },
    ]);

    expect(result).toEqual({ supported: true, fragments: [] });
  });

  test("context.rejectsAnUnknownAgentWhenItsInstructionBoundaryCannotBeIdentified", () => {
    const result = extractAllowedAgentContext("custom-with-unknown-layout", [
      { type: "text", text: "secret custom instructions mixed with host boilerplate" },
    ]);
    expect(result).toEqual({ supported: false, fragments: [] });
    expect(JSON.stringify(result)).not.toContain("secret custom instructions");
  });

  test("context.recognizesKnownBuiltInAgentWithoutAHeading", () => {
    expect(extractAllowedAgentContext("plan", [{ type: "text", text: "Stock planner prompt without an identity heading." }]))
      .toEqual({ supported: true, fragments: [] });
  });
});
