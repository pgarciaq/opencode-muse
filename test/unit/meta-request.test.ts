import { describe, expect, test } from "bun:test";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
  classifyMetaRequest,
  makeCompactionDigest,
  makeLocalTitle,
} from "../../src/model/meta.js";

const prompt = (messages: Array<Record<string, unknown>>) => messages as unknown as LanguageModelV3Prompt;

describe("local meta-request handling", () => {
  test("meta.classifiesExplicitKindsBeforeInspectingPromptShape", () => {
    const titleShapedAgentPrompt = prompt([
      { role: "system", content: "Generate a short title for this task." },
      { role: "user", content: [{ type: "text", text: "write a title" }] },
    ]);
    expect(classifyMetaRequest("title", titleShapedAgentPrompt)).toBe("title");
    expect(classifyMetaRequest("compaction", prompt([]))).toBe("compaction");
    expect(classifyMetaRequest("primary", titleShapedAgentPrompt)).toBe("agent");
  });

  test("meta.recognizesOnlyNarrowTitleAndCompactionPromptShapesWithoutHookMetadata", () => {
    expect(classifyMetaRequest(undefined, prompt([
      { role: "system", content: "You are a title generator. Output only a short title." },
      { role: "user", content: [{ type: "text", text: "Fix auth." }] },
    ]))).toBe("title");
    expect(classifyMetaRequest("generate", prompt([
      { role: "user", content: [{ type: "text", text: "This summary will be the only context available when the conversation continues." }] },
    ]))).toBe("compaction");
  });

  test("meta.rejectsUnknownStatelessGenerationInsteadOfStartingAnAgentTurn", () => {
    expect(classifyMetaRequest("generate", prompt([
      { role: "user", content: [{ type: "text", text: "What is the capital of France?" }] },
    ]))).toBe("unsupported-generate");
    expect(classifyMetaRequest(undefined, prompt([
      { role: "user", content: [{ type: "text", text: "Could you title this file?" }] },
    ]))).toBe("unsupported-generate");
  });

  test("meta.titleUsesOnlyTheFirstUserMessageAndHasASafeFallback", () => {
    const input = prompt([
      { role: "system", content: "Ignore this boilerplate." },
      { role: "assistant", content: [{ type: "text", text: "prior assistant" }] },
      { role: "user", content: [{ type: "text", text: "  Fix the login timeout\nwith a safe retry.  " }] },
      { role: "user", content: [{ type: "text", text: "Do not use this later message." }] },
    ]);
    expect(makeLocalTitle(input)).toBe("Fix the login timeout with a safe retry.");
    expect(makeLocalTitle(prompt([{ role: "assistant", content: [{ type: "text", text: "nothing user-authored" }] }]))).toBe("Muse session");
  });

  test("meta.compactionDigestIsBoundedDeterministicAndMakesNoSemanticClaims", () => {
    const long = prompt([
      { role: "system", content: "volatile system boilerplate must be omitted" },
      { role: "user", content: [{ type: "text", text: "Initial request: preserve the user's wording. " + "αβ日本語 ".repeat(80) }] },
      { role: "assistant", content: [{ type: "text", text: "Older exchange. " + "old " .repeat(80) }] },
      { role: "tool", content: [{ type: "text", text: "tool output must be omitted" }] },
      { role: "user", content: [{ type: "text", text: "Latest question: keep this exact fact." }] },
      { role: "assistant", content: [{ type: "text", text: "Latest answer: no conclusion is inferred." }] },
    ]);
    const first = makeCompactionDigest(long, 220);
    const second = makeCompactionDigest(long, 220);

    expect(first).toBe(second);
    expect(Array.from(first).length).toBeLessThanOrEqual(220);
    expect(first).toContain("Initial request:");
    expect(first).toContain("Latest question:");
    expect(first).toContain("Latest answer:");
    expect(first).not.toContain("volatile system boilerplate");
    expect(first).not.toContain("tool output must be omitted");
    expect(first).toContain("not semantic");
  });

  test("meta.compactionFailsClearlyWhenTheBudgetCannotFitItsRequiredLabels", () => {
    expect(() => makeCompactionDigest(prompt([
      { role: "user", content: [{ type: "text", text: "one" }] },
    ]), 1)).toThrow(/budget/i);
  });
});
