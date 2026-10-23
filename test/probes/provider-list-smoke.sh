#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMP_BASE="${TMPDIR:-/tmp}"
mkdir -p "$TEMP_BASE"
RUN_ROOT="$(mktemp -d "$TEMP_BASE/muse-provider-list.XXXXXX")"
trap 'rm -rf "$RUN_ROOT"' EXIT
PROJECT="$RUN_ROOT/project"
mkdir -p "$PROJECT/.opencode/plugins"

ENTRY_URL="file://$(realpath "$ROOT/dist/index.js")"
cat >"$PROJECT/.opencode/plugins/muse-plugin.js" <<EOF
export { default } from "$ENTRY_URL";
EOF

cd "$PROJECT"
set +e
timeout "${OPENCODE_MUSE_MODELS_TIMEOUT:-30s}" opencode models --standalone >"$RUN_ROOT/models.stdout" 2>/dev/null
status=$?
set -e
if [[ "$status" == 124 ]]; then
  echo '{"status":"OPEN_CODE_MODELS_TIMEOUT"}'
  exit 2
elif [[ "$status" != 0 ]]; then
  echo '{"status":"OPEN_CODE_MODELS_FAILED"}'
  exit "$status"
fi

node - "$RUN_ROOT/models.stdout" <<'NODE'
const fs = require("node:fs");
const output = fs.readFileSync(process.argv[2], "utf8");
const lines = output.split(/\r?\n/).filter((line) => line.trim().startsWith("muse/"));
if (lines.length === 0) throw new Error("OpenCode did not list a model from the Muse provider");
console.log(JSON.stringify({ status: "PROVIDER_LIST_OK", museProviderRows: lines.length }));
NODE
