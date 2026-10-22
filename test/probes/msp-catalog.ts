import { mkdirSync } from "node:fs";
import { MspHost } from "../../src/msp/host.js";

const workspaceRoot = process.env.MUSE_PROBE_WORKSPACE ?? "/tmp/opencode/muse-catalog-probe";
mkdirSync(workspaceRoot, { recursive: true });

let host: MspHost | undefined;
try {
  host = await MspHost.start({
    museBin: process.env.MUSE_BIN ?? "muse",
    args: ["serve", "--provider", "meta", "--disable-shell", "--disable-write"],
    cwd: workspaceRoot,
  });
  const result = await host.request("model/list") as {
    providerId?: string;
    profileId?: string | null;
    source?: string;
    models?: Array<{
      contextLimit?: number | null;
      defaultReasoningEffort?: string;
      displayLabel?: string;
      isActive?: boolean;
      isDefault?: boolean;
      modelId?: string;
      outputLimit?: number | null;
      profileId?: string | null;
      providerId?: string;
      reasoningEffortVariants?: Array<{ tier: string; description?: string }>;
      releaseDate?: string | null;
      variants?: string[] | { kind?: string };
    }>;
  };
  console.log(JSON.stringify({
    status: "MSP_CATALOG_PROBED",
    schemaFingerprint: (host.initializeResult.schema as { fingerprint?: string } | undefined)?.fingerprint ?? null,
    providerId: result.providerId ?? null,
    profileId: result.profileId ?? null,
    source: result.source ?? null,
    models: (result.models ?? []).map((model) => ({
      providerId: model.providerId ?? null,
      profileId: model.profileId ?? null,
      modelId: model.modelId ?? null,
      displayLabel: model.displayLabel ?? null,
      contextLimit: model.contextLimit ?? null,
      outputLimit: model.outputLimit ?? null,
      releaseDate: model.releaseDate ?? null,
      isActive: model.isActive ?? false,
      isDefault: model.isDefault ?? false,
      defaultReasoningEffort: model.defaultReasoningEffort ?? null,
      variants: model.variants ?? null,
      reasoningEffortVariants: model.reasoningEffortVariants ?? [],
    })),
  }));
} catch (error) {
  const failure = error as { name?: string; code?: number; mspCode?: number; mspKind?: string };
  console.log(JSON.stringify({
    status: "MSP_CATALOG_FAILED",
    failure: {
      name: failure.name ?? "Error",
      code: failure.code ?? null,
      mspCode: failure.mspCode ?? null,
      mspKind: failure.mspKind ?? null,
    },
  }));
  process.exitCode = 1;
} finally {
  if (host !== undefined) await host.close();
}
