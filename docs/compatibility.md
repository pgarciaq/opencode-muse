# Compatibility Record

Updated: 2026-10-23

This file records runtime facts and probe results. It must never contain credentials, prompts, transcripts, raw login output, or unsanitized provider diagnostics.

## Candidate Runtime Pins

| Component | Observed/pinned candidate | Evidence / status |
| --- | --- | --- |
| Muse CLI | `1.4.12` (`1.4.12-R6909.1`) | `muse --version`; current stable schema fingerprint is recorded below |
| OpenCode | `2.1.3` (current CLI; implementation target was `2.1.2`) | `opencode --version`; correlation probe `CORRELATION_OK` re-run on `2.1.3`; provider-list and live-turn bridge smoke pass on `2.1.3` |
| OpenChamber embedded OpenCode | `2.0.32` | Embedded binary at `/tmp/.mount_OpenChoLGwRI/resources/opencode-cli/opencode`; project-local plugin shim passed provider listing, request correlation, and a live no-variant bridge turn. This is a direct embedded-CLI smoke, not a full OpenChamber UI acceptance test. |
| OpenCode smoke baseline | `2.1.1` | Earlier `seam-smoke` evidence; retain as historical evidence, not the current target |
| `@muse-code/sdk` | `1.4.12` | `npm view @muse-code/sdk@1.4.12 version`; its expected fingerprint matches the Muse 1.4.12 served stable fingerprint |

The current OpenChamber test host embeds OpenCode `2.0.32`; system-wide OpenCode is `2.1.3`. The earlier `2.1.1` smoke test remains historical evidence only.

## MSP Schema Exports

Muse documents these offline schema-export commands (`muse schema --help`):

```sh
muse schema generate-json-schema --out <directory>
muse schema generate-json-schema --out <directory> --experimental
muse schema generate-ts --out <directory>
muse schema generate-ts --out <directory> --experimental
```

Current exports were generated offline from Muse CLI `1.4.12-R6909.1` under `/tmp/opencode/`. The 1.4.11 hashes are superseded for the current candidate; 1.4.11 runtime probes below remain historical observations.

| Surface/artifact | SHA-256 / fingerprint |
| --- | --- |
| Stable manifest protocol fingerprint | `sha256:cfdb6d2525601b9bac76584ccb0610ab3a5539b5e4f51141f079b99b39fcb4e0` |
| Stable `msp.schema.json` | `4ca7d1800ac66cae664529d59efeb1e17c63b3fedd0a53ddfc4b747758551737` |
| Stable `msp.d.ts` | `4af85979529e7221193c45a4e758487d2955495cb9044cbc42eb93ce93c9b1ec` |
| Experimental manifest protocol fingerprint | `sha256:c37d9b6db138c4f079e38da665815619a3a4337702568aacee62de7252690fc1` |
| Experimental `msp.schema.json` | `f900a7e81fc194773cedb2d5be8805138aeb75bf76fcc03645084792935b2056` |
| Experimental `msp.d.ts` | `1cd4fb62ec9dc2448dd27873715e85d34bfdb8335f301d63f7c73d3499a67ff9` |

The SDK 1.4.12 `EXPECTED_SCHEMA_FINGERPRINT` exactly matches the stable fingerprint served by Muse CLI 1.4.12. The generated declaration diff from the 1.4.11 SDK is additive (new approval/CUA and background-terminal/checkpoint data and optional fields); the strict runtime fingerprint check remains enabled until a separate policy issue is resolved.

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
| Muse/OpenCode/SDK version pin and schema export | **Updated for 1.4.12** | Muse CLI and `@muse-code/sdk` are both 1.4.12; SDK expected fingerprint matches the CLI-served stable fingerprint. |
| Muse 1.4.12 handshake and `model/list` | **PASS** | Sanitized `test/probes/msp-catalog.ts` returned `MSP_CATALOG_PROBED`, stable fingerprint `sha256:cfdb6d2525601b9bac76584ccb0610ab3a5539b5e4f51141f079b99b39fcb4e0`, and three Meta models. Before the SDK update, the 1.4.12 CLI failed the exact handshake against the 1.4.11 SDK fingerprint; no guard was weakened. |
| Muse 1.4.12 schema delta vs 1.4.11 | **Initial diff: additive declarations observed** | Exported stable declarations add approval/CUA and background-terminal/checkpoint data and optional fields; no removed exported declarations were found in the initial textual diff. The fingerprint remains exact-match because additive source shape alone does not prove semantic compatibility. Follow-up policy: #21. |
| OpenCode `model.request` → V3 call-option correlation on OpenCode 2.1.2 | **PASS for session-associated `doStream`** | `bash test/probes/correlation-run.sh` passed on one shared `opencode serve` with two concurrent sessions. Seven calls (title, primary, session `generate`, and compaction) had matching hook/V3 signatures and no session crossover. Variant `minimal` survived. No direct profile field exists on the probed model object; resolve profile from the selected catalog model. |
| OpenCode plugin file extension in project probe | **Observed** | The project plugin loader did not load the `.mjs` probe (model unavailable); renaming the same module to `.js` made it load and the correlation test pass. The shipped bundle entry is `.js`. |
| OpenCode session-scoped `session.generate` route | **Observed** | Invoked `model.request` with kind `generate` and a session ID, used `doStream`, and left OpenCode session messages byte-identical. Do not forward it as an ordinary turn to the live Muse session in v1. |
| OpenCode stateless `/api/experimental/generate` with project-local provider | **Not reached at model boundary** | The route returned `Model unavailable` during base-config resolution before invoking the project-local provider. The opencode-claude reference notes this stateless route bypasses session hooks; v1 general stateless generation remains unsupported. |
| OpenCode local title/compaction hooks and prompt-shape fallback | **Fake-context tests pass; runtime unverified** | The plugin hooks `session.title` and `session.compaction` and also recognizes narrow title/summary prompt signatures in V3. No pinned OpenCode hook execution smoke ran because its CLI/provider-list baseline hangs on an empty project. |
| OpenCode custom agent context | **Narrow allowlist; runtime hook execution unverified** | The `session.context` hook forwards only an identifiable custom-agent prompt prefix before `# Your Model`, labeled as agent instructions. Stock prompt/tool catalogs and other host-only system content are not forwarded; unknown custom layouts fail closed. Muse relies on its own workspace rules for project context. |
| Local compaction digest budget | **Deterministic character cap; tokenizer guarantee unavailable** | The digest obeys a conservative codepoint cap derived from `maxOutputTokens` and a hard cap; the plugin has no provider tokenizer. It fails if the labeled minimum will not fit and never invokes any model. |
| Session-associated `doGenerate` path | **Not observed** | Tested ordinary and session-scoped routes invoked `doStream`; stateless generation did not resolve this project-local provider. `doGenerate` remains required by V3 but must not start an uncorrelated Muse turn. |
| Muse echo session durability, command idempotency, turn lifecycle, cursor replay, and reconnect | **PASS for the exercised protocol subset** | `MUSE_PROBE_PROVIDER=echo ./node_modules/.bin/bun run test/probes/msp-lifecycle.ts`: handshake reported durable; duplicate same-ID `turn/start` returned the same turn and emitted one `turn/started`; `session/start` attached notifications; unsubscribe/subscribe after the start cursor replayed the terminal exactly once; reconnect + `session/resume` returned the same session and replayed the terminal once. The echo turn completed with zero token usage and no assistant text/item deltas, so it does not verify live model output or usage. |
| Muse 1.4.12 echo lifecycle/replay probe | **PASS for exercised subset** | `MUSE_PROBE_PROVIDER=echo ./node_modules/.bin/bun run test/probes/msp-lifecycle.ts` with SDK 1.4.12 reported durable sessions, duplicate same-ID `turn/start` returning the same turn with one start, cursor replay terminal once, and resume/replay terminal once. No text delta was emitted; this does not cover view gaps, control dispositions, or live Meta behavior. The probe used an isolated Muse home. |
| Muse 1.4.12 echo explicit fork and session rename | **FAIL / unavailable** | Explicit `session/fork` still returns internal `file birth time is unavailable` on Linux; `session/rename` remains runtime-unavailable despite the capability. Keep rewind/fork disabled and custom naming best-effort; see #20. |
| Muse `model/list` via Muse 1.4.11/Linux Meta host | **PASS** | A sessionless `model/list` returned provider `meta`, profile `tbh`, source `providerCatalog`, and three rows: `muse-wonder-1.0` (default/high), `muse-spark-1.3` (max), and `muse-spark-1.2` (high; described xhigh tier). Limits were 1,007,997 context / 128,000 output, with display labels and release dates. Catalog discovery only; no session or model turn was created. See `test/probes/msp-catalog.ts`. |
| Muse Meta live turn lifecycle on Muse 1.4.11/Linux | **PASS for item lifecycle; streaming/turn usage incomplete** | Two subscription-backed probes through `muse serve --provider meta` completed with `turn/started`, `userMessage` completion, and `agentMessage` start/completion. `session/tokenUsage` reported model usage, but no `item/delta` was observed and `turn/completed.usage` was absent. Probe output contains only event names, item kinds/statuses, opaque-ID hashes, and numeric usage; no prompt or generated text is logged. Contributor mode was not changed. |
| Muse explicit `session/fork.cutPoint` on Muse 1.4.11/Linux echo session | **FAIL — implementation blocker for rewind/fork** | The command returned JSON-RPC `-32603 internal`: `file birth time is unavailable`. The probe workspace, Git directory, and branch ref all reported birth times through OS metadata, so missing birth-time metadata in the test workspace does not explain the failure. Do not implement rewind/fork on this target until Meta fixes the runtime error or a supported runtime passes the probe. |
| Muse `session/rename` on Muse 1.4.11/Linux | **FAIL — optional naming unavailable** | `sessionRename` was granted at initialize, but `session/rename` returned `-32603 internal: session naming is unavailable` on both an isolated echo session (before and after its turn) and a Meta-configured session start. Plugin-created sessions cannot be promised a custom label on this target. |
| Muse live Meta view-gap recovery, cancel/interrupt/unqueue, approvals, and alternate audio/PDF/strict-JSON paths | **Not run** | Meta item lifecycle and combined image/video acceptance are recorded separately, but no view gap or control/approval behavior was induced; no alternate audio/PDF/strict-JSON route is known. Do not change Contributor mode. |
| Muse Meta inline image + video input on Muse 1.4.11/Linux | **PASS for protocol acceptance and completed turn** | A single live turn accepted a 16×16 PNG and a 1-second, 897-byte MP4. `media/upload` accepted one chunk and echoed the same upload receipt; the combined turn completed and emitted an `agentMessage` item. No image/video data or generated text was logged; semantic recognition of the test colors was not asserted. Session usage was reported, while `turn/completed.usage` was absent. |
| Audio/PDF turn parts and strict JSON response format | **No direct stable MSP representation; alternate route not verified** | Stable `TurnInputPartType` is `text | image | skill | video`; `turn/start` has no `responseFormat` field. No audio/PDF/strict-JSON live turn was sent. Treat these as unrepresented on the direct MSP bridge unless a separately verified official path is found; ordinary text asking for JSON remains normal text. |
| OpenCode ordinary sampling settings | **Not represented by stable `turn/start`** | Prompt/options validation reports option names only and ignores `maxOutputTokens`, `temperature`, `topP`, `topK`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed`, and provider options. Strict JSON and required OpenCode-side tools are rejected specifically; a non-empty tool catalog alone is accepted. |
| OpenChamber UI source feasibility (checkout `6491f51db`) | **Inspected; runtime unverified** | Provider auth UI surfaces OAuth/external/key but not plugin command methods; permission UI is generic allow-once/always/reject, not a lossless renderer for Muse choice IDs/labels; generic forms are not proven to cover all MSP user-input schemas. Defer auth button, Muse approvals, and structured user-input UI; use manual `muse login` and fail closed. File restore puts messages/attachments back in the composer; it is not workspace rollback. No OpenChamber source changes were made. |
| Plugin behavior when Muse requests approval or structured user input | **Fail closed / no UI integration** | Plugin initialize advertises `userInputDialogs:false`; the pinned SDK's default server-request handling rejects unhandled requests as method-not-found. No approval choice, user-input answer, auto-allow, or transcript narration is synthesized. |
| OpenChamber-managed model picker and live text turn after restart | **User-confirmed PASS on Muse 1.4.12 / embedded OpenCode 2.0.32** | The user reports that, after fully quitting and relaunching OpenChamber, Muse models appeared and a prompt returned the fixed token `OPENCHAMBER_MUSE_OK`. This confirms one app-managed text path; it is user-reported, not an independently captured UI trace. Other UI and lifecycle gates remain separate. |
| Pinned OpenCode 2.1.3 `opencode models` / `provider.list` runtime smoke | **Historical pass with Muse 1.4.11** | `bash test/probes/provider-list-smoke.sh` (project-local shim) returned `PROVIDER_LIST_OK` with 3 `muse/` rows (`muse-spark-1.2`, `muse-spark-1.3`, `muse-wonder-1.0`; profile `tbh`). The earlier 2.1.2 empty-project CLI hang did not reproduce on `2.1.3`; plain `opencode models` also responds without any Muse plugin installed. The correlation probe also re-ran clean on `2.1.3` (`CORRELATION_OK`, 2 sessions, 7 `doStream` calls, no session crossover). The 1.4.12 provider-list result is recorded against embedded 2.0.32 below. |
| OpenCode 2.1.3 end-to-end Muse bridge turn (subscription-backed, Contributor unchanged) | **Historical pass with Muse 1.4.11** | A project-local shim plus `opencode run --standalone --model muse/muse-profile-tbh-model-muse-spark-1.3` completed a real text turn through `muse serve` and returned the scripted token exactly once. Verified both with the explicit `#minimal` variant and after the default-variant fix below. No prompt text, media payloads, or generated prose is recorded here. |
| OpenCode 2.1.3 default-variant behavior | **Observed; plugin fixed** | OpenCode's default `build` agent sends the synthetic variant `default` on primary requests (title/meta requests carry `minimal`) when the user chose no explicit variant. The plugin previously failed closed with `unsupported-variant`, which rejected every no-variant `opencode run`. `readRequestContext` now resolves `default` to the catalog row's `defaultReasoningEffort` when declared, and otherwise treats it as an unspecified-effort turn; arbitrary unknown variant names still fail closed. Unit tests pin both paths; the live no-variant turn was verified on the prior Muse 1.4.11 pin. |
| OpenChamber embedded OpenCode 2.0.32 provider listing with project-local shim | **PASS on Muse 1.4.12** | Ran `test/probes/provider-list-smoke.sh` with `PATH` pointing to the embedded 2.0.32 binary; project-local `.opencode/plugins/*.js` shim returned `PROVIDER_LIST_OK` with 3 Muse rows. |
| OpenChamber embedded OpenCode 2.0.32 request correlation | **PASS** | Ran `test/probes/correlation-run.sh` through the embedded 2.0.32 binary; `CORRELATION_OK` (2 sessions, 7 `doStream` calls, no crossover). |
| OpenChamber embedded OpenCode 2.0.32 live bridge turn | **PASS on Muse 1.4.12** | Project-local shim and a no-variant `opencode run --standalone --model muse/…-muse-spark-1.3` completed through `muse serve` and returned the scripted token. This verifies the embedded CLI/plugin seam but does not exercise OpenChamber's app-managed plugin discovery or UI. |
| OpenCode global plugin-directory model visibility | **PASS on embedded OpenCode 2.0.32** | The global shim, without a project-local shim, returned three Muse rows and completed a live no-variant turn when OpenCode ran from a temporary Git project. It also returned three rows from the plugin repository. An empty, unmarked temporary directory returned none; OpenCode's project/location context matters. |
| OpenCode 2.1.3 plugin loading surfaces | **Observed (pin 2.1.3)** | Project-local `.opencode/plugins/*.js` loads in `models`/`run` --standalone paths (provider rows plus live turns above). A shim placed in the global `~/.config/opencode/plugins/` directory loads (`loading plugin` log), but model visibility from that surface is not established. Previous tests using the singular `plugin` config key do not establish behavior for the documented plural `plugins` key. |
| Package contents | **PASS for dry-run inventory only** | `npm pack --dry-run --json` lists 36 files including compiled `dist/` modules (including the agent-context allowlist), package metadata, and README. No tarball was published or installed into a clean OpenCode profile; that runtime smoke remains blocked above. |

## Credential-Safety Record

For schema discovery, only `muse --version`, `opencode --version`, `muse schema --help`, offline schema export, and `npm view @muse-code/sdk version` were used. Echo lifecycle probes used an isolated Muse home. The live Meta lifecycle and combined image/video probes used the official CLI and the user's existing subscription; no Muse credential/config file was opened and no Contributor-mode setting was changed. Probe logging excludes prompt, media payloads, and generated text.

## Plugin State Path (Task 7)

- Linux/macOS: `$XDG_DATA_HOME/opencode-muse`, falling back to `~/.local/share/opencode-muse`.
- Windows: `%LOCALAPPDATA%\opencode-muse`, falling back to `%USERPROFILE%\AppData\Local\opencode-muse`.
- Session files are named by SHA-256 of the OpenCode session ID, versioned, mode 0600, and atomically replaced under mode-0700 directories. Corrupt or unsupported-version records are quarantined and treated as unmapped; they are never used to resume a Muse session.
- State-directory resolution rejects any configured path inside the Muse configuration directory (including custom `XDG_CONFIG_HOME` roots); the plugin never writes there.
- Stored data is limited to session/host/model IDs, workspace and transcript fingerprints, pending compaction-output fingerprints, opaque view cursors, turn IDs, command IDs/fingerprints, and timestamps. No prompt text, transcript bodies, compaction summaries, workspace paths, credentials, or raw CLI output are persisted.
- Workspace locks use an exclusive-create file keyed by workspace fingerprint and store a PID/owner token/session ID, not the raw path. Dead-PID locks are reclaimed only after owner-token rechecks under an exclusive recovery claim. A stale/corrupt recovery claim fails closed and needs operator cleanup after checking its PID. This coordinates local processes on a shared local filesystem; it is not a distributed lock for multiple machines on network storage.
