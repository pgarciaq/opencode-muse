export type MuseRequestKind = "primary" | "title" | "compaction" | "generate";

export interface MuseModelSelection {
  providerId: string;
  modelId: string;
  profileId: string | null;
  isActive: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  variantsKnown: boolean;
  variants: string[];
}

export interface RequestContext {
  sessionID: string;
  directory: string;
  kind: MuseRequestKind;
  modelID: string;
  providerID: string;
  variant?: string;
  effort?: string;
  museSelection: MuseModelSelection;
}

export interface ContextError {
  type: "context-error";
  code: "missing" | "invalid" | "unknown-model" | "unsupported-variant";
  field: string;
}

export type MuseErrorKind = "credentials" | "billing" | "unsupported" | "protocol" | "unknown";
