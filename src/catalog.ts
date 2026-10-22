import type { Model } from "@opencode/plugin";

export const MUSE_PROVIDER_ID = "muse";

export interface MuseCatalogRow {
  providerId: string;
  profileId: string | null;
  modelId: string;
  displayLabel: string;
  contextLimit: number | null;
  outputLimit: number | null;
  releaseDate: string | null;
  isActive: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  variants?: string[] | "unknown";
  reasoningEffortVariants?: Array<{ tier: string; description?: string }>;
  cost: {
    cached: string;
    currency: string | null;
    input: string;
    output: string;
  } | null;
}

export interface MuseCatalogSnapshot {
  providerId: string;
  profileId: string | null;
  source: string;
  models: MuseCatalogRow[];
}

export interface MuseModelSelection {
  providerId: string;
  profileId: string | null;
  modelId: string;
  isActive: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  variantsKnown: boolean;
  variants: string[];
}

const FALLBACK_ID = "setup-required";

export const fallbackCatalog: Model.Info[] = [
  {
    id: FALLBACK_ID,
    modelID: FALLBACK_ID,
    providerID: MUSE_PROVIDER_ID,
    name: "Muse setup required — run muse login, then refresh providers",
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "deprecated",
    enabled: false,
    limit: { context: 1, output: 1 },
  } as unknown as Model.Info,
];

export function openCodeModelId(profileId: string | null, modelId: string): string {
  const profileKey = profileId === null ? "no-profile" : `profile-${encodeURIComponent(profileId)}`;
  return `muse-${profileKey}-model-${encodeURIComponent(modelId)}`;
}

function parseCost(value: string): number | undefined {
  if (!/^(?:\d+)(?:\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function releasedAt(releaseDate: string | null): number {
  if (releaseDate === null) return 0;
  const timestamp = Date.parse(releaseDate);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
}

function costInfo(row: MuseCatalogRow): Model.Info["cost"] {
  if (!row.cost || row.cost.currency !== "USD") return [];
  const input = parseCost(row.cost.input);
  const output = parseCost(row.cost.output);
  const cached = parseCost(row.cost.cached);
  if (input === undefined || output === undefined || cached === undefined) return [];
  return [{ input, output, cache: { read: cached, write: 0 } }] as unknown as Model.Info["cost"];
}

function modelInfo(row: MuseCatalogRow): Model.Info {
  const limitsKnown = Number.isInteger(row.contextLimit)
    && row.contextLimit !== null
    && row.contextLimit > 0
    && Number.isInteger(row.outputLimit)
    && row.outputLimit !== null
    && row.outputLimit > 0;
  const effortVariants = Array.isArray(row.variants) ? row.variants : [];
  return {
    id: openCodeModelId(row.profileId, row.modelId),
    modelID: row.modelId,
    providerID: MUSE_PROVIDER_ID,
    name: limitsKnown ? row.displayLabel : `${row.displayLabel} (limits unavailable)`,
    capabilities: {
      tools: true,
      input: ["text", "image", "video"],
      output: ["text"],
    },
    variants: effortVariants.map((id) => ({ id, settings: {} })),
    time: { released: releasedAt(row.releaseDate) },
    cost: costInfo(row),
    status: limitsKnown ? "active" : "deprecated",
    enabled: limitsKnown,
    limit: {
      context: limitsKnown ? row.contextLimit! : 1,
      output: limitsKnown ? row.outputLimit! : 1,
    },
  } as unknown as Model.Info;
}

export function buildOpenCodeCatalog(
  museCatalog: MuseCatalogSnapshot | undefined,
  fallback: readonly Model.Info[] = fallbackCatalog,
): Model.Info[] {
  if (museCatalog?.source !== "providerCatalog" || museCatalog.models.length === 0) return [...fallback];
  const rows = museCatalog.models.filter((row) => row.providerId.length > 0 && row.modelId.length > 0 && row.displayLabel.length > 0);
  if (rows.length === 0) return [...fallback];
  return rows.map(modelInfo);
}

export function buildMuseModelIndex(museCatalog: MuseCatalogSnapshot): Map<string, MuseModelSelection> {
  const result = new Map<string, MuseModelSelection>();
  if (museCatalog.source !== "providerCatalog") return result;
  for (const row of museCatalog.models) {
    if (!row.providerId || !row.modelId || !row.displayLabel) continue;
    result.set(openCodeModelId(row.profileId, row.modelId), {
      providerId: row.providerId,
      profileId: row.profileId,
      modelId: row.modelId,
      isActive: row.isActive,
      isDefault: row.isDefault,
      ...(row.defaultReasoningEffort !== undefined ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
      variantsKnown: Array.isArray(row.variants),
      variants: Array.isArray(row.variants) ? [...row.variants] : [],
    });
  }
  return result;
}

export class CatalogCache {
  private currentModels: Model.Info[];
  private currentSelectionIndex = new Map<string, MuseModelSelection>();
  private live = false;

  constructor(private readonly fallback: readonly Model.Info[] = fallbackCatalog) {
    this.currentModels = [...fallback];
  }

  get models(): Model.Info[] {
    return this.currentModels;
  }

  get selectionIndex(): ReadonlyMap<string, MuseModelSelection> {
    return this.currentSelectionIndex;
  }

  get hasLiveCatalog(): boolean {
    return this.live;
  }

  async refresh(fetchCatalog: () => Promise<MuseCatalogSnapshot>, reload: () => Promise<void>): Promise<boolean> {
    let snapshot: MuseCatalogSnapshot;
    try {
      snapshot = await fetchCatalog();
    } catch {
      return false;
    }
    if (snapshot.source !== "providerCatalog" || snapshot.models.length === 0) return false;

    let models: Model.Info[];
    let index: Map<string, MuseModelSelection>;
    try {
      models = buildOpenCodeCatalog(snapshot, this.fallback);
      index = buildMuseModelIndex(snapshot);
    } catch {
      return false;
    }
    if (index.size === 0 || models.length === this.fallback.length && models.every((model) => model.id === FALLBACK_ID)) {
      return false;
    }

    const previousModels = this.currentModels;
    const previousIndex = this.currentSelectionIndex;
    const previousLive = this.live;
    // Transform callbacks read this cache, so mutate it before provider.reload().
    this.currentModels = models;
    this.currentSelectionIndex = index;
    this.live = true;
    try {
      await reload();
      return true;
    } catch {
      this.currentModels = previousModels;
      this.currentSelectionIndex = previousIndex;
      this.live = previousLive;
      return false;
    }
  }
}
