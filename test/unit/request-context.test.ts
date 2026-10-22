import { describe, expect, test } from "bun:test";
import {
  MUSE_CONTEXT_HEADERS,
  addRequestContextHeaders,
  readRequestContext,
} from "../../src/model/context.js";
import { openCodeModelId } from "../../src/catalog.js";
import type { MuseModelSelection } from "../../src/types.js";

const modelId = openCodeModelId("tbh", "muse-wonder-1.0");
const selection: MuseModelSelection = {
  providerId: "meta",
  profileId: "tbh",
  modelId: "muse-wonder-1.0",
  isActive: false,
  isDefault: true,
  defaultReasoningEffort: "high",
  variantsKnown: true,
  variants: ["minimal", "high", "max"],
};
const index = new Map([[modelId, selection]]);

describe("request context", () => {
  test("context.stampsNamespacedHeadersAndResolvesProfileFromCatalog", () => {
    const headers: Record<string, string> = { authorization: "untouched" };
    const request = {
      sessionID: "ses_one",
      kind: "primary",
      model: { id: modelId, providerID: "muse", variant: "max" },
      headers,
    };

    expect(addRequestContextHeaders(headers, request, "/workspace/project")).toBe(true);
    expect(headers.authorization).toBe("untouched");
    const context = readRequestContext({ headers }, index);
    expect(context).toMatchObject({
      sessionID: "ses_one",
      directory: "/workspace/project",
      kind: "primary",
      modelID: modelId,
      providerID: "muse",
      variant: "max",
      museSelection: { providerId: "meta", profileId: "tbh", modelId: "muse-wonder-1.0" },
      effort: "max",
    });
  });

  test("context.doesNotMutateHeadersForOtherProviders", () => {
    const headers: Record<string, string> = { "x-existing": "kept" };
    const handled = addRequestContextHeaders(headers, {
      sessionID: "ses_other",
      kind: "primary",
      model: { id: "model", providerID: "openai" },
      headers,
    }, "/workspace");

    expect(handled).toBe(false);
    expect(headers).toEqual({ "x-existing": "kept" });
  });

  test("context.returnsErrorsInsteadOfGuessingMissingMetadata", () => {
    const result = readRequestContext({ headers: undefined }, index);
    expect(result).toMatchObject({ type: "context-error", code: "missing", field: "headers" });
  });

  test("context.rejectsUnknownModelAndUnadvertisedVariant", () => {
    const unknownHeaders = {
      [MUSE_CONTEXT_HEADERS.sessionID]: "ses_one",
      [MUSE_CONTEXT_HEADERS.directory]: "/workspace",
      [MUSE_CONTEXT_HEADERS.kind]: "primary",
      [MUSE_CONTEXT_HEADERS.modelID]: "not-in-catalog",
      [MUSE_CONTEXT_HEADERS.providerID]: "muse",
    };
    expect(readRequestContext({ headers: unknownHeaders }, index)).toMatchObject({ code: "unknown-model" });

    const variantHeaders = { ...unknownHeaders, [MUSE_CONTEXT_HEADERS.modelID]: modelId, [MUSE_CONTEXT_HEADERS.variant]: "ultra" };
    expect(readRequestContext({ headers: variantHeaders }, index)).toMatchObject({ code: "unsupported-variant" });
  });

  test("context.acceptsMetaRequestKindsAndIsolatesConcurrentSessions", () => {
    const makeHeaders = (sessionID: string, kind: string) => ({
      [MUSE_CONTEXT_HEADERS.sessionID]: sessionID,
      [MUSE_CONTEXT_HEADERS.directory]: `/workspace/${sessionID}`,
      [MUSE_CONTEXT_HEADERS.kind]: kind,
      [MUSE_CONTEXT_HEADERS.modelID]: modelId,
      [MUSE_CONTEXT_HEADERS.providerID]: "muse",
    });
    const first = readRequestContext({ headers: makeHeaders("ses_a", "title") }, index);
    const second = readRequestContext({ headers: makeHeaders("ses_b", "compaction") }, index);

    expect(first).toMatchObject({ sessionID: "ses_a", kind: "title" });
    expect(second).toMatchObject({ sessionID: "ses_b", kind: "compaction" });
  });

  test("context.contextFreeGenerateDoesNotAttachToALatestSession", () => {
    const result = readRequestContext({ headers: {} }, index);
    expect(result).toMatchObject({ type: "context-error", code: "missing" });
    expect(MUSE_CONTEXT_HEADERS.sessionID).toContain("x-opencode-muse-");
  });
});
