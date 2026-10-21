# Compatibility Record

Updated: 2026-10-22

This file records runtime facts and probe results. It must never contain credentials, prompts, transcripts, raw login output, or unsanitized provider diagnostics.

## Candidate Runtime Pins

| Component | Observed/pinned candidate | Evidence / status |
| --- | --- | --- |
| Muse CLI | `1.4.11` (`1.4.11-R6667.1`) | `muse --version` |
| OpenCode | `2.1.2` | `opencode --version`; correlation gate has not yet run on this version |
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
- Sessions may be durable or ephemeral; restart recovery must verify durability from the target host.
- `session/sideChat` requires a source session and opens a new side session empty; it is not a stateless generation API.
- Durable command methods whose schema defines `commandId` use UUIDv7 idempotency handles; non-command operations such as `media/upload` and `view/subscribe` use their own upload IDs/cursors and must not be assigned invented command IDs.

These are schema observations, not all live behavioral probes. Keep the probe outcomes below distinct from static declarations.

## Probe Status

| Gate | Status | Result |
| --- | --- | --- |
| Muse/OpenCode/SDK version pin and schema export | **Recorded** | Versions and hashes above; schema declarations match vendored files exactly |
| OpenCode `model.request` → V3 call-option correlation on OpenCode 2.1.2 | **Not run** | Hard gate; if absent/racy, revise to local-proxy architecture |
| Muse session durability, cursor replay, command idempotency, turn lifecycle | **Not run against target CLI** | Live turn checks require working inference access; use subscription-backed Contributor mode as requested or configured PAYG |
| Image/video/audio/PDF/strict-JSON through `muse serve` | **Not run** | Probe per format; do not infer MSP support from direct Model API docs |
| OpenChamber auth/approval/user-input UI feasibility | **Not run** | Conditional feature gate; no OpenChamber source changes in v1 |

## Credential-Safety Record

For the version/schema discovery above, only `muse --version`, `opencode --version`, `muse schema --help`, offline schema export, and `npm view @muse-code/sdk version` were used. No Muse credential/config file was opened, and no model turn was sent.
