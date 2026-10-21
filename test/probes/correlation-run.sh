#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_ROOT="$(mktemp -d /tmp/opencode/muse-correlation.XXXXXX)"
PROJECT="$RUN_ROOT/project"
mkdir -p "$PROJECT/.opencode/plugins" "$RUN_ROOT/logs"
cp "$ROOT/test/probes/correlation-plugin.js" "$PROJECT/.opencode/plugins/correlation-plugin.js"
export OPENCODE_MUSE_CORRELATION_LOG="$RUN_ROOT/logs/events.jsonl"

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
SERVER_URL="http://127.0.0.1:$PORT"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$PROJECT"
opencode serve --hostname 127.0.0.1 --port "$PORT" >"$RUN_ROOT/server.stdout" 2>"$RUN_ROOT/server.stderr" &
SERVER_PID=$!

ready=0
for _ in $(seq 1 50); do
  if curl --silent --fail "$SERVER_URL/global/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" != 1 ]]; then
  echo "OpenCode server did not become ready; sanitized server logs: $RUN_ROOT/server.stderr" >&2
  exit 1
fi

set +e
opencode run --server "$SERVER_URL" --model correlation-probe/echo#minimal --format json "Correlation probe session A" >"$RUN_ROOT/run-a.stdout" 2>"$RUN_ROOT/run-a.stderr" &
run_a=$!
opencode run --server "$SERVER_URL" --model correlation-probe/echo#minimal --format json "Correlation probe session B" >"$RUN_ROOT/run-b.stdout" 2>"$RUN_ROOT/run-b.stderr" &
run_b=$!
wait "$run_a"
status_a=$?
wait "$run_b"
status_b=$?
set -e

if [[ "$status_a" != 0 || "$status_b" != 0 ]]; then
  echo "OpenCode probe runs failed (A=$status_a, B=$status_b); inspect sanitized logs under $RUN_ROOT" >&2
  exit 1
fi

SESSION_A="$(node -e 'const fs=require("node:fs");const e=fs.readFileSync(process.argv[1],"utf8").trim().split(/\r?\n/).map(JSON.parse);process.stdout.write(e.find(x=>x.sessionID)?.sessionID??"")' "$RUN_ROOT/run-a.stdout")"
if [[ -z "$SESSION_A" ]]; then
  echo "Could not extract the test session ID; inspect sanitized run output under $RUN_ROOT" >&2
  exit 1
fi
opencode api --server "$SERVER_URL" GET "/api/session/$SESSION_A/message" >"$RUN_ROOT/messages-before-generate.json"
opencode api --server "$SERVER_URL" session.generate --param "sessionID=$SESSION_A" --data '{"prompt":"Session-scoped generate correlation probe."}' >"$RUN_ROOT/session-generate.json"
opencode api --server "$SERVER_URL" GET "/api/session/$SESSION_A/message" >"$RUN_ROOT/messages-after-generate.json"
cmp "$RUN_ROOT/messages-before-generate.json" "$RUN_ROOT/messages-after-generate.json"

COMPACT_ID="msg_$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
opencode api --server "$SERVER_URL" session.compact --param "sessionID=$SESSION_A" --data "{\"id\":\"$COMPACT_ID\"}" >"$RUN_ROOT/session-compact.json"
compact_seen=0
for _ in $(seq 1 50); do
  if grep -q '"kind":"compaction"' "$OPENCODE_MUSE_CORRELATION_LOG"; then compact_seen=1; break; fi
  sleep 0.2
done
if [[ "$compact_seen" != 1 ]]; then
  echo "No compaction request reached the probe model; inspect sanitized artifacts under $RUN_ROOT" >&2
  exit 1
fi

node - "$OPENCODE_MUSE_CORRELATION_LOG" "$RUN_ROOT/session-generate.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const generateFile = process.argv[3];
const events = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const hooks = new Map(events.filter((event) => event.phase === "hook").map((event) => [event.nonceHash, event]));
const models = events.filter((event) => event.phase === "model" && event.method === "doStream");
if (models.length < 2) throw new Error(`expected >=2 doStream calls, got ${models.length}`);
for (const model of models) {
  const hook = hooks.get(model.nonceHash);
  if (!hook) throw new Error(`no matching model.request hook for ${model.nonceHash}`);
  if (!model.signatureMatch) throw new Error(`correlation header mismatch for ${model.nonceHash}`);
  if (hook.sessionHash !== model.sessionHash || hook.directoryHash !== model.directoryHash) {
    throw new Error(`session/directory crossed for ${model.nonceHash}`);
  }
}
const sessions = new Set(models.map((event) => event.sessionHash));
if (sessions.size < 2) throw new Error(`expected two distinct sessions, got ${sessions.size}`);
if (!models.some((event) => event.kind === "generate")) throw new Error("session.generate did not reach the model with kind=generate");
if (!models.some((event) => event.kind === "compaction")) throw new Error("forced compaction did not reach the model with kind=compaction");
const generateResult = JSON.parse(fs.readFileSync(generateFile, "utf8"));
if (!String(generateResult?.data?.text ?? "").includes("CORRELATION_OK doStream")) {
  throw new Error("session.generate did not receive the correlated V3 stream result");
}
console.log(JSON.stringify({
  status: "CORRELATION_OK",
  sessionCount: sessions.size,
  doStreamCount: models.length,
  kinds: [...new Set(models.map((event) => event.kind))],
  variants: [...new Set(models.map((event) => event.variant))],
  profileMetadataPresent: models.some((event) => hooks.get(event.nonceHash)?.profilePresent),
  sessionGenerateDidNotMutateHistory: true,
  log: file,
}));
NODE

echo "Probe artifacts (test prompts and sanitized metadata only): $RUN_ROOT"
