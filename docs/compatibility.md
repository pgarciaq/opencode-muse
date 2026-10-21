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
- `session/tokenUsage.cumulative` is a running session snapshot; `turn/completed.usage` is the per-turn aggregate.
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
| Muse explicit `session/fork.cutPoint` on Muse 1.4.11/Linux echo session | **FAIL — implementation blocker for rewind/fork** | The command returned JSON-RPC `-32603 internal`: `file birth time is unavailable`. The probe workspace, Git directory, and branch ref all reported birth times through OS metadata, so missing birth-time metadata in the test workspace does not explain the failure. Do not implement rewind/fork on this target until Meta fixes the runtime error or a supported runtime passes the probe. |
| Muse `session/rename` on Muse 1.4.11/Linux | **FAIL — optional naming unavailable** | `sessionRename` was granted at initialize, but `session/rename` returned `-32603 internal: session naming is unavailable` on both an isolated echo session (before and after its turn) and a Meta-configured session start. Plugin-created sessions cannot be promised a custom label on this target. |
| Muse live Meta lifecycle, view-gap recovery, cancel/interrupt/unqueue, approvals, media, and strict JSON | **BLOCKED / not run** | Echo does not generate assistant text or exercise approval/media/model behavior. A live Meta probe needs the user's working Muse inference access; do not change Contributor mode. |
| Image/video/audio/PDF/strict-JSON through `muse serve` | **Not run live** | MSP declarations establish representable shapes, not runtime/model acceptance; probe each format with an authorized live model before implementing those paths. |
| OpenChamber auth/approval/user-input UI feasibility | **Not run** | Conditional feature gate; no OpenChamber source changes in v1 |

## Credential-Safety Record

For schema discovery, only `muse --version`, `opencode --version`, `muse schema --help`, offline schema export, and `npm view @muse-code/sdk version` were used. The lifecycle probe used an isolated Muse home and the local `echo` provider; no Muse credential/config file was opened, no Contributor-mode setting was changed, and no live Meta inference was sent.
