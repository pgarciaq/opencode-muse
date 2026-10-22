import type { Plugin, Provider } from "@opencode/plugin";
import { MspHost } from "./msp/host.js";
import {
  CatalogCache,
  MUSE_PROVIDER_ID,
  type MuseCatalogSnapshot,
} from "./catalog.js";
import { addRequestContextHeaders } from "./model/context.js";

type ProviderEditor = Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0];

export type MuseProviderContext = Pick<Plugin.Context, "provider" | "session"> & {
  location: Pick<Plugin.Context["location"], "directory">;
};

export interface ProviderPluginDependencies {
  fetchCatalog?: (directory: string) => Promise<MuseCatalogSnapshot>;
}

export interface MuseProviderRuntime {
  catalog: CatalogCache;
  refreshTask: Promise<boolean>;
  dispose(): Promise<void>;
}

function providerInfo(moduleUrl: string): Provider.Info {
  return {
    id: MUSE_PROVIDER_ID,
    name: "Muse Code",
    activation: "enabled",
    package: `aisdk:${moduleUrl}`,
    settings: {},
  } as unknown as Provider.Info;
}

async function fetchMuseCatalog(directory: string): Promise<MuseCatalogSnapshot> {
  const host = await MspHost.start({
    args: ["serve", "--provider", "meta", "--disable-shell", "--disable-write"],
    cwd: directory,
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    shutdownTimeoutMs: 5_000,
  });
  try {
    return await host.request<MuseCatalogSnapshot>("model/list");
  } finally {
    await host.close();
  }
}

/** Register the disabled offline row first, then refresh only from a live MSP provider catalog. */
export async function createProviderPlugin(
  ctx: MuseProviderContext,
  moduleUrl: string,
  dependencies: ProviderPluginDependencies = {},
): Promise<MuseProviderRuntime> {
  const catalog = new CatalogCache();
  const registration = await ctx.provider.transform((providers: ProviderEditor) => {
    providers.add({ info: providerInfo(moduleUrl), models: catalog.models });
  });
  let sessionHookRegistration: Awaited<ReturnType<Plugin.Context["session"]["hook"]>>;
  try {
    sessionHookRegistration = await ctx.session.hook("model.request", async (request) => {
      addRequestContextHeaders(request.headers, request, ctx.location.directory);
    }, { providerID: MUSE_PROVIDER_ID });
  } catch (error) {
    await registration.dispose();
    throw error;
  }

  let disposed = false;
  const refreshTask = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
    if (disposed) return false;
    return catalog.refresh(
      () => (dependencies.fetchCatalog ?? fetchMuseCatalog)(ctx.location.directory),
      async () => {
        if (!disposed) await ctx.provider.reload();
      },
    );
  });

  return {
    catalog,
    refreshTask,
    async dispose() {
      disposed = true;
      await refreshTask;
      await Promise.all([registration.dispose(), sessionHookRegistration.dispose()]);
    },
  };
}
