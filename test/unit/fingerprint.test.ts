import { describe, expect, test } from "bun:test";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
  fingerprintCompactionOutput,
  fingerprintTranscript,
  promptContainsCompactionFingerprint,
  reconcileTranscript,
} from "../../src/session/fingerprint.js";

const prompt = (messages: Array<Record<string, unknown>>) => messages as unknown as LanguageModelV3Prompt;
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("transcript fingerprints", () => {
  test("fingerprint.onlyTracksOrderedVisibleUserAndAssistantContent", () => {
    const one = prompt([
      { role: "system", content: "volatile system one" },
      user("hello\r\nworld"),
      assistant("answer"),
      { role: "assistant", content: [{ type: "reasoning", text: "private reasoning" }] },
    ]);
    const two = prompt([
      { role: "system", content: "volatile system two" },
      user("hello\nworld"),
      assistant("answer"),
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "new-id", toolName: "shell", input: "different" }] },
    ]);
    expect(fingerprintTranscript(one)).toEqual(fingerprintTranscript(two));
    expect(fingerprintTranscript(one)).toHaveLength(2);
  });

  test("fingerprint.detectsSameCountEarlierMessageEditsAndRewinds", () => {
    const previous = fingerprintTranscript(prompt([user("old request"), assistant("answer"), user("latest") ]));
    const edited = fingerprintTranscript(prompt([user("edited request"), assistant("answer"), user("new latest") ]));
    const truncated = fingerprintTranscript(prompt([user("old request"), assistant("answer") ]));
    expect(reconcileTranscript(previous, edited, [])).toBe("diverged");
    expect(reconcileTranscript(previous, truncated, [])).toBe("diverged");
  });

  test("fingerprint.acceptsOnlyAnExactObservedCompactionCandidate", () => {
    const candidate = fingerprintCompactionOutput("Transcript digest: preserve this exact summary.");
    const observed = prompt([
      user("Transcript digest: preserve this exact summary."),
      user("Continue from here."),
    ]);
    const changed = prompt([
      user("Transcript digest: preserve this edited summary."),
      user("Continue from here."),
    ]);
    expect(promptContainsCompactionFingerprint(observed, candidate)).toBe(true);
    expect(promptContainsCompactionFingerprint(changed, candidate)).toBe(false);
    expect(reconcileTranscript(["old-prefix"], fingerprintTranscript(observed), [candidate], observed)).toBe("compacted");
    expect(reconcileTranscript(["old-prefix"], fingerprintTranscript(changed), [candidate], changed)).toBe("diverged");
  });

  test("fingerprint.candidateHashDoesNotPersistTheSummaryText", () => {
    const secret = "secret summary text not suitable for registry";
    const fingerprint = fingerprintCompactionOutput(secret);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain(secret);
  });
});
