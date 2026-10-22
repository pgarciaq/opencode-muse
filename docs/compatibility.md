# Compatibility Record

Updated: 2026-10-22

This file records runtime facts and probe results. It must never contain credentials, prompts, transcripts, raw login output, or unsanitized provider diagnostics.

## Candidate Runtime Pins

| Component | Observed/pinned candidate | Evidence / status |
| --- | --- | --- |
| Muse CLI | `1.4.11` (`1.4.11-R6667.1`) | `muse --version` |
| OpenCode | `2.1.2` | `opencode --version`; session-associated correlation probe passes for `doStream` |
| OpenCode smoke baseline | `2.1.1` | Earlier `seam-smoke` evidence; retain as historical evidence, not the current target |
| `@muse-code/sdk` | `1.4.11` | `npm view @muse-code/sdk version` returned `1.4.11`; package import/runtime compatibility is still to be tested in Task 3/6 |

OpenCode `2.1.2` is the implementation target candidate because it is the installed runtime. The earlier `2.1.1` smoke test does not prove hook metadata reaches V3 call options on `2.1.2`; Task 2 remains a hard gate.

## MSP Schema Exports

Muse documents these offline schema-export commands (`muse schema --help`):

```sh
muse schema generate-json-schema --out <directory>
muse schema generate-json-schema --out <directory> --experimental
muse schema generate-ts --out <directory>
muse schema generate-ts --out <directory> --experimental
```

Exports were generated from Muse CLI `1.4.11-R6667.1` under `/tmp/opencode/`.

| Surface/artifact | SHA-256 / fingerprint |
| --- | --- |
| Stable manifest protocol fingerprint | `sha256:f282ad16e21520d0cda68cb190149b86e2b062eef1dd282749360c05aa3d1082` |
| Stable `msp.schema.json` | `76e5807d78c0522cb4fe55be57520c284a6a03740ff3e817976667adfc45449b` |
| Stable `msp.d.ts` | `65fc505c44031698e374c63021347e64de9b769442e97d50c9f2b5542b064b2e` |
| Experimental manifest protocol fingerprint | `sha256:195aeec21350d8a9a6979eaaa16edb06c7b7017ebc4130e96966ea30ee435614` |
| Experimental `msp.schema.json` | `130ce7bd353612b5644c8e46afa828cd6669ce8e4f7db5c1ba287a2f464ccc8e` |
| Experimental `msp.d.ts` | `e76b5eb1bcdf352bfb2448aebe8ce506660c687a53f75cfe6e37d888803fbdbb` |

`diff -q` confirmed the exported stable declaration exactly matches `/tmp/opencode/muse-schema/msp.d.ts`; the exported experimental declaration exactly matches `/tmp/opencode/muse-schema-exp/msp.d.ts`.

## Schema Facts Relevant to v1

- `TurnInputPartType` is `text | image | skill | video`; the image part carries base64/media type, and the video part carries a receipt from `media/upload`. There is no direct audio or PDF turn part in this schema.
- `turn/start` has no direct `responseFormat`/JSON-schema field. Strict structured output through `muse serve` remains unproven; ordinary JSON text prompts are unaffected.
- `session/fork` without `cutPoint` copies all completed turns; a rewind requires `cutPoint.lastTurnId`.
- `session/tokenUsage.cumulative` is a running session snapshot; never sum it. `session/tokenUsage.usage` is per model completion and `turn/completed.usage` is an optional turn aggregate. The bridge deduplicates per-completion usage by view cursor and prefers the final aggregate; when neither exists, usage counters remain unknown.
- `turn/unqueued` means a queued turn was reclaimed before launch; `turn/started` marks launch.
- `view/subscribe` can replay after an observed cursor; `view/gap` signals a missed range.
- `session/start` and `session/resume` return a view head and attach the connection after it; explicit `view/subscribe({after})` is for replay/reattachment from an older observed cursor.
- Sessions may be durable or ephemeral; restart recovery must verify durability from the target host.
- `session/sideChat` requires a source session and opens a new side session empty; it is not a stateless generation API.
- Durable command methods whose schema defines `commandId` use UUIDv7 idempotency handles. Each `media/upload` chunk has a `commandId` plus the upload's shared `uploadId`; `view/subscribe` uses cursors and has no command ID.

These are schema observations, not all live behavioral probes. Keep the probe outcomes below distinct from static declarations.

## Probe Status

| Gate | Status | Result |
| --- | --- | --- |
| Muse/OpenCode/SDK version pin and schema export | **Recorded** | Versions and hashes above; schema declarations match vendored files exactly |
| OpenCode `model.request` → V3 call-option correlation on OpenCode 2.1.2 | **PASS for session-associated `doStream`** | `bash test/probes/correlation-run.sh` passed on one shared `opencode serve` with two concurrent sessions. Seven calls (title, primary, session `generate`, and compaction) had matching hook/V3 signatures and no session crossover. Variant `minimal` survived. No direct profile field exists on the probed model object; resolve profile from the selected catalog model. |
| OpenCode plugin file extension in project probe | **Observed** | The project plugin loader did not load the `.mjs` probe (model unavailable); renaming the same module to `.js` made it load and the correlation test pass. The shipped bundle entry is `.js`. |
| OpenCode session-scoped `session.generate` route | **Observed** | Invoked `model.request` with kind `generate` and a session ID, used `doStream`, and left OpenCode session messages byte-identical. Do not forward it as an ordinary turn to the live Muse session in v1. |
| OpenCode stateless `/api/experimental/generate` with project-local provider | **Not reached at model boundary** | The route returned `Model unavailable` during base-config resolution before invoking the project-local provider. The opencode-claude reference notes this stateless route bypasses session hooks; v1 general stateless generation remains unsupported. |
| Session-associated `doGenerate` path | **Not observed** | Tested ordinary and session-scoped routes invoked `doStream`; stateless generation did not resolve this project-local provider. `doGenerate` remains required by V3 but must not start an uncorrelated Muse turn. |
| Muse echo session durability, command idempotency, turn lifecycle, cursor replay, and reconnect | **PASS for the exercised protocol subset** | `MUSE_PROBE_PROVIDER=echo ./node_modules/.bin/bun run test/probes/msp-lifecycle.ts`: handshake reported durable; duplicate same-ID `turn/start` returned the same turn and emitted one `turn/started`; `session/start` attached notifications; unsubscribe/subscribe after the start cursor replayed the terminal exactly once; reconnect + `session/resume` returned the same session and replayed the terminal once. The echo turn completed with zero token usage and no assistant text/item deltas, so it does not verify live model output or usage. |
| Muse `model/list` via Muse 1.4.11/Linux Meta host | **PASS** | A sessionless `model/list` returned provider `meta`, profile `tbh`, source `providerCatalog`, and three rows: `muse-wonder-1.0` (default/high), `muse-spark-1.3` (max), and `muse-spark-1.2` (high; described xhigh tier). Limits were 1,007,997 context / 128,000 output, with display labels and release dates. Catalog discovery only; no session or model turn was created. See `test/probes/msp-catalog.ts`. |
| Muse Meta live turn lifecycle on Muse 1.4.11/Linux | **PASS for item lifecycle; streaming/turn usage incomplete** | Two subscription-backed probes through `muse serve --provider meta` completed with `turn/started`, `userMessage` completion, and `agentMessage` start/completion. `session/tokenUsage` reported model usage, but no `item/delta` was observed and `turn/completed.usage` was absent. Probe output contains only event names, item kinds/statuses, opaque-ID hashes, and numeric usage; no prompt or generated text is logged. Contributor mode was not changed. |
| Muse explicit `session/fork.cutPoint` on Muse 1.4.11/Linux echo session | **FAIL — implementation blocker for rewind/fork** | The command returned JSON-RPC `-32603 internal`: `file birth time is unavailable`. The probe workspace, Git directory, and branch ref all reported birth times through OS metadata, so missing birth-time metadata in the test workspace does not explain the failure. Do not implement rewind/fork on this target until Meta fixes the runtime error or a supported runtime passes the probe. |
| Muse `session/rename` on Muse 1.4.11/Linux | **FAIL — optional naming unavailable** | `sessionRename` was granted at initialize, but `session/rename` returned `-32603 internal: session naming is unavailable` on both an isolated echo session (before and after its turn) and a Meta-configured session start. Plugin-created sessions cannot be promised a custom label on this target. |
| Muse live Meta view-gap recovery, cancel/interrupt/unqueue, approvals, and alternate audio/PDF/strict-JSON paths | **Not run** | Meta item lifecycle and combined image/video acceptance are recorded separately, but no view gap or control/approval behavior was induced; no alternate audio/PDF/strict-JSON route is known. Do not change Contributor mode. |
| Muse Meta inline image + video input on Muse 1.4.11/Linux | **PASS for protocol acceptance and completed turn** | A single live turn accepted a 16×16 PNG and a 1-second, 897-byte MP4. `media/upload` accepted one chunk and echoed the same upload receipt; the combined turn completed and emitted an `agentMessage` item. No image/video data or generated text was logged; semantic recognition of the test colors was not asserted. Session usage was reported, while `turn/completed.usage` was absent. |
| Audio/PDF turn parts and strict JSON response format | **No direct stable MSP representation; alternate route not verified** | Stable `TurnInputPartType` is `text | image | skill | video`; `turn/start` has no `responseFormat` field. No audio/PDF/strict-JSON live turn was sent. Treat these as unrepresented on the direct MSP bridge unless a separately verified official path is found; ordinary text asking for JSON remains normal text. |
| OpenCode ordinary sampling settings | **Not represented by stable `turn/start`** | Prompt/options validation reports option names only and ignores `maxOutputTokens`, `temperature`, `topP`, `topK`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed`, and provider options. Strict JSON and required OpenCode-side tools are rejected specifically; a non-empty tool catalog alone is accepted. |
| OpenChamber UI source feasibility (checkout `6491f51db`) | **Inspected; runtime unverified** | Provider auth UI surfaces OAuth/external/key but not plugin command methods; permission UI is generic allow-once/always/reject, not a lossless renderer for Muse choice IDs/labels; generic forms are not proven to cover all MSP user-input schemas. Defer auth button, Muse approvals, and structured user-input UI; use manual `muse login` and fail closed. File restore puts messages/attachments back in the composer; it is not workspace rollback. No OpenChamber source changes were made. |
| OpenChamber runtime catalog/fallback visibility | **Not run** | No browser tab/app was attached to this session. Static provider catalog remains the planned path, but live visibility is not yet verified. |
| Pinned OpenCode 2.1.2 `opencode models` / `provider.list` runtime smoke | **Blocked by environment baseline** | `opencode models --standalone` timed out both with an empty temporary project and with the Muse plugin; direct `provider.list` against isolated `opencode serve` also hung after `/global/health` succeeded. A later `opencode run --standalone` with the Muse model timed out too. The plugin refresh is now non-blocking, but no rows/errors were emitted, so this does not establish a Muse-specific failure. Re-run when this OpenCode provider-list path responds. |

## Credential-Safety Record

For schema discovery, only `muse --version`, `opencode --version`, `muse schema --help`, offline schema export, and `npm view @muse-code/sdk version` were used. Echo lifecycle probes used an isolated Muse home. The live Meta lifecycle and combined image/video probes used the official CLI and the user's existing subscription; no Muse credential/config file was opened and no Contributor-mode setting was changed. Probe logging excludes prompt, media payloads, and generated text.

## Plugin State Path (Task 7)

- Linux/macOS: `$XDG_DATA_HOME/opencode-muse`, falling back to `~/.local/share/opencode-muse`.
- Windows: `%LOCALAPPDATA%\opencode-muse`, falling back to `%USERPROFILE%\AppData\Local\opencode-muse`.
- Session files are named by SHA-256 of the OpenCode session ID, versioned, mode 0600, and atomically replaced under mode-0700 directories. Corrupt or unsupported-version records are quarantined and treated as unmapped; they are never used to resume a Muse session.
- State-directory resolution rejects any configured path inside the Muse configuration directory (including custom `XDG_CONFIG_HOME` roots); the plugin never writes there.
- Stored data is limited to session/host/model IDs, workspace and transcript fingerprints, opaque view cursor, turn ID, command IDs/fingerprints, and timestamps. No prompt text, transcript bodies, workspace paths, credentials, or raw CLI output are persisted.
- Workspace locks use an exclusive-create file keyed by workspace fingerprint and store a PID/owner token/session ID, not the raw path. Dead-PID locks are reclaimed only after owner-token rechecks under an exclusive recovery claim. A stale/corrupt recovery claim fails closed and needs operator cleanup after checking its PID. This coordinates local processes on a shared local filesystem; it is not a distributed lock for multiple machines on network storage.
