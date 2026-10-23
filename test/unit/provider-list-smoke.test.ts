import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repositoryPath } from "../helpers.ts";

function runProviderListProbe(modelRows: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "muse-provider-smoke-test-"));
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);

  const fakeOpenCode = join(binDirectory, "opencode");
  writeFileSync(
    fakeOpenCode,
    '#!/bin/sh\nprintf \'%s\\n\' "$MUSE_TEST_MODEL_ROWS"\n',
  );
  chmodSync(fakeOpenCode, 0o755);

  const result = spawnSync(
    "bash",
    [repositoryPath("test/probes/provider-list-smoke.sh")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        TMPDIR: directory,
        MUSE_TEST_MODEL_ROWS: modelRows.join("\n"),
        OPENCODE_MUSE_MODELS_TIMEOUT: "5s",
      },
      timeout: 10_000,
    },
  );

  return result;
}

test("provider-list smoke rejects OpenRouter Muse model rows without the Muse provider", () => {
  const result = runProviderListProbe(["openrouter/meta/muse-spark-1.2"]);

  expect(result.status).not.toBe(0);
});

test("provider-list smoke accepts rows from the Muse provider", () => {
  const result = runProviderListProbe(["muse/muse-profile-tbh-model-muse-spark-1.3"]);

  expect(result.status).toBe(0);
});
