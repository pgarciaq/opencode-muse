import { describe, expect, test } from "bun:test";
import { createProviderPlugin } from "../../src/provider.js";
import { createMuse } from "../../src/index.js";
import type { MuseCatalogSnapshot } from "../../src/catalog.js";

function liveCatalog(): MuseCatalogSnapshot {
  return {
    providerId: "meta",
    profileId: "tbh",
    source: "providerCatalog",
    models: [{
      providerId: "meta",
      profileId: "tbh",
      modelId: "muse-wonder-1.0",
      displayLabel: "Muse Wonder 1.0",
      contextLimit: 1_007_997,
      outputLimit: 128_000,
      releaseDate: "2026-10-12",
      isActive: false,
      isDefault: true,
      defaultReasoningEffort: "high",
      variants: ["minimal", "low", "medium", "high", "xhigh", "max"],
      reasoningEffortVariants: [],
      cost: null,
    }],
  };
}

function fakeContext() {
  let transform: ((editor: { add(input: { info: Record<string, unknown>; models: readonly Record<string, unknown>[] }): void }) => void) | undefined;
  const registrations: Array<{ info: Record<string, unknown>; models: readonly Record<string, unknown>[] }> = [];
  let reloads = 0;
  return {
    context: {
      location: { directory: "/tmp/opencode/muse-plugin-test" },
      provider: {
        async transform(callback: typeof transform extends undefined ? never : NonNullable<typeof transform>) {
          transform = callback as typeof transform;
          callback({ add: (input) => { registrations.push(input); } });
          return { dispose: async () => {} };
        },
        async reload() {
          reloads += 1;
          transform?.({ add: (input) => { registrations.push(input); } });
        },
      },
    },
    registrations,
    get reloads() { return reloads; },
  };
}

describe("Muse OpenCode provider registration", () => {
  test("provider.registersAisdkFileFactoryAndRefreshesAfterCacheUpdate", async () => {
    const fake = fakeContext();
    const runtime = await createProviderPlugin(fake.context as never, "file:///plugin/dist/index.js", {
      fetchCatalog: async () => liveCatalog(),
    });
    await runtime.refreshTask;

    expect(fake.registrations[0]?.info).toMatchObject({
      id: "muse",
      name: "Muse Code",
      package: "aisdk:file:///plugin/dist/index.js",
    });
    expect(fake.registrations[0]?.models[0]?.enabled).toBe(false);
    expect(fake.reloads).toBe(1);
    expect(fake.registrations.at(-1)?.models[0]?.id).toContain("muse-wonder-1.0");
    expect(runtime.catalog.hasLiveCatalog).toBe(true);
    await runtime.dispose();
  });

  test("provider.keepsTheFallbackWhenMuseDiscoveryFails", async () => {
    const fake = fakeContext();
    const runtime = await createProviderPlugin(fake.context as never, "file:///plugin/dist/index.js", {
      fetchCatalog: async () => { throw new Error("discovery failure"); },
    });
    await runtime.refreshTask;

    expect(fake.reloads).toBe(0);
    expect(fake.registrations[0]?.models[0]).toMatchObject({ enabled: false });
    expect(runtime.catalog.hasLiveCatalog).toBe(false);
    await runtime.dispose();
  });

  test("provider.createMuseProvidesANamedLanguageHookDriftDiagnostic", () => {
    const provider = createMuse();
    expect(() => provider.languageModel("setup-required")).toThrow(/opencode-muse: language hook did not engage/);
  });

  test("provider.setupReturnsBeforeCatalogNetworkDiscoveryFinishes", async () => {
    const fake = fakeContext();
    let finishFetch!: (value: MuseCatalogSnapshot) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const setup = createProviderPlugin(fake.context as never, "file:///plugin/dist/index.js", {
      fetchCatalog: () => {
        markFetchStarted();
        return new Promise((resolve) => { finishFetch = resolve; });
      },
    });
    await fetchStarted;
    const returnedBeforeFetch = await Promise.race([
      setup.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    const runtime = await setup;

    expect(returnedBeforeFetch).toBe(true);
    expect(runtime.catalog.hasLiveCatalog).toBe(false);
    expect(fake.reloads).toBe(0);
    finishFetch(liveCatalog());
    await runtime.refreshTask;
    expect(runtime.catalog.hasLiveCatalog).toBe(true);
    expect(fake.reloads).toBe(1);
    await runtime.dispose();
  });
});
