export interface RequestContext {
  sessionID: string;
  directory: string;
  kind: string;
  modelID: string;
  providerID: string;
  variant?: string;
}

export interface MuseModelSelection {
  providerId: string;
  modelId: string;
  profileId?: string;
  effort?: string;
}

export type MuseErrorKind = "credentials" | "billing" | "unsupported" | "protocol" | "unknown";
