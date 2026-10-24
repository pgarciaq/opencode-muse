import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifySnapshots, snapshotExport, type SchemaExport, type SchemaSnapshot } from "../../src/msp/schema-diff.js";

function usage(): never {
  console.error("usage:");
  console.error("  msp-schema-diff.ts snapshot --export <dir> --cli-version <v> [--provenance <text>]");
  console.error("  msp-schema-diff.ts diff --export <dir> --ledger <file> [--from-version <v>]");
  process.exit(2);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function loadExport(dir: string): SchemaExport {
  const manifestPath = join(dir, "manifest.json");
  const schemaPath = join(dir, "msp.schema.json");
  if (!existsSync(manifestPath) || !existsSync(schemaPath)) {
    throw new Error(`export directory must contain manifest.json and msp.schema.json: ${dir}`);
  }
  return {
    manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
    schema: JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>,
  };
}

function loadLedger(path: string): { entries: SchemaSnapshot[] } {
  const ledger = JSON.parse(readFileSync(path, "utf8")) as { entries?: SchemaSnapshot[] };
  if (!Array.isArray(ledger.entries) || ledger.entries.length === 0) throw new Error(`ledger has no entries: ${path}`);
  return { entries: ledger.entries };
}

const command = process.argv[2];
try {
  if (command === "snapshot") {
    const dir = flag("--export");
    const cliVersion = flag("--cli-version");
    if (!dir || !cliVersion) usage();
    const entry = snapshotExport(cliVersion!, flag("--provenance") ?? "ad-hoc offline export", loadExport(dir!));
    console.log(JSON.stringify(entry, null, 1));
  } else if (command === "diff") {
    const dir = flag("--export");
    const ledgerPath = flag("--ledger");
    if (!dir || !ledgerPath) usage();
    const { entries } = loadLedger(ledgerPath!);
    const fromVersion = flag("--from-version");
    const base = fromVersion ? entries.find((e) => e.cli_version === fromVersion) : entries[entries.length - 1];
    if (!base) throw new Error(`ledger has no entry for version: ${fromVersion}`);
    const exp = loadExport(dir!);
    const fresh = snapshotExport(`export@${exp.manifest.fingerprint.slice(0, 19)}`, "ephemeral fresh export for diff only", exp);
    const schema = exp.schema;
    const members = {
      ...((schema.methods ?? {}) as Record<string, unknown>),
      ...((schema.requests ?? {}) as Record<string, unknown>),
      ...((schema.notifications ?? {}) as Record<string, unknown>),
    };
    const classification = classifySnapshots(base, fresh, {
      newBodies: { members, defs: (schema.$defs ?? {}) as Record<string, unknown> },
    });
    console.log(JSON.stringify({ ok: classification.ok, base: base.cli_version, findings: classification.findings }, null, 1));
    process.exitCode = classification.ok ? 0 : 1;
  } else {
    usage();
  }
} catch (error) {
  console.error(`msp-schema-diff failed: ${(error as Error).message}`);
  process.exitCode = 2;
}
