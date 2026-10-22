# OpenCode Muse TDD Test Plan

> **For agentic workers:** Follow this test plan alongside [`2026-10-21-opencode-muse.md`](2026-10-21-opencode-muse.md). Use the approved execution method and keep every implementation slice Red → Green → Refactor. Do not weaken a failing assertion to make the implementation pass; if a pinned protocol/UI gate disproves an assumption, update the design and implementation plan first.

**Goal:** Give every v1 behavior in the Muse plugin an observable failing test before implementation, with fast fake-MSP feedback and a small set of opt-in real-runtime checks.

**Architecture:** Most tests use pure functions, a deterministic fake MSP host, and a pinned OpenCode process with no live model access. Live PAYG probes validate only behaviors the fake cannot prove: CLI schema/runtime compatibility, media/JSON capability, auth flow, durable sessions, and the OpenChamber UI. Approval and structured-user-input tests are conditional on the UI feasibility gate.

**Tech Stack:** Bun test runner, TypeScript strict mode, `@opencode/plugin`/OpenCode v2, pinned `@muse-code/sdk` and Muse CLI schema, fake MSP transport, opt-in PAYG probes.

**Specs:** [`docs/design.md`](../design.md) v1.3 and [`2026-10-21-opencode-muse.md`](2026-10-21-opencode-muse.md).

## Global Test Constraints

- Default test suite uses fake MSP and never needs live Meta inference.
- Live tests are opt-in and use only the official Muse CLI with the user's selected auth mode; never print, inspect, or persist credential values.
- Keep Contributor mode enabled for the user's subscription-backed live tests; tests must not toggle account settings.
- Pin OpenCode, Muse CLI, exported stable/experimental MSP schema, and SDK versions before interpreting protocol results.
- No test may read `~/.config/muse`; test auth behavior through CLI/MSP boundaries and instrumented filesystem/process interfaces.
- For MSP methods whose schema defines `commandId`, every exact retry reuses that ID and payload. Each `media/upload` chunk carries a UUIDv7 `commandId` and the upload's shared `uploadId`; `view/subscribe` uses cursors without a `commandId`. Never invent IDs or automatically replay an ambiguous side-effecting turn.
- Test model capability and MSP bridge capability separately. Map supported media; assert narrow errors only for unsupported bridge paths.
- Tests must not assert filesystem rollback on rewind; the plugin explicitly does not perform it.

## Review Focus

- Two concurrent OpenCode sessions must never share correlation metadata, Muse sessions, or workspace write access.
- A disconnect at any point around `turn/start` must not duplicate a Muse turn or lose already-delivered view events.
- Compaction, a same-count transcript edit, and a true rewind must produce three distinct outcomes.
- Image/video data must be mapped without lossy stripping; audio/PDF/strict JSON behavior must match the pinned protocol probe.
- Muse approval choices and user-input questions must fail closed if the OpenChamber UI cannot faithfully represent them.

---

## Test Architecture

### Test layers

1. **Pure unit tests:** prompt/context parsing, media mapping, model catalog conversion, errors, fingerprints, and compaction digest. No processes or network.
2. **Fake-MSP component tests:** deterministic host that records commands, returns configured acknowledgements, emits ordered notifications/cursor gaps, and can disconnect/crash at named points.
3. **Pinned OpenCode adapter tests:** real pinned OpenCode runtime plus a local/fake Muse host. These prove hook order, session-associated correlation headers, V3 `doStream`/`doGenerate` behavior, and provider discovery without a Meta inference call. Session-scoped `session.generate` and stateless `/api/experimental/generate` are tested separately because their context/history semantics differ.
4. **Opt-in live Muse tests:** require configured access only for model-turn behavior; assert protocol/events, not exact model prose. Keep these small and never run them as part of ordinary `bun test`.
5. **Manual OpenChamber checks:** auth-method visibility, approval-choice UI, structured input UI, and file restore behavior. Record screenshots/results without secrets in `docs/compatibility.md`.

### Required Red–Green–Refactor cycle

For each slice below:

1. Add one behavior-focused failing test with the expected observable result.
2. Run that exact test and record the expected failure before writing implementation.
3. Implement the smallest change that satisfies it.
4. Re-run the focused test, then the owning test file and `npm run build`.
5. Refactor names/duplication only while tests remain green; rerun the focused and full unit suite.
6. Commit the independently testable slice after focused and full tests pass. Do not combine a red test and its implementation into one unverified edit.

The compatibility probes in Tasks 1, 2, 4, and 5 of the implementation plan are **discovery gates**, not TDD cycles: they answer whether the real interfaces support the design. Task 3 only bootstraps the test/build harness and remains test-first; bridge behavior begins after the gates.

## TDD Slices

### Slice 1: Test harness and fake MSP contract

**Files:** `test/helpers/fake-msp.ts`, `test/helpers/fake-opencode.ts`, `test/run.ts`.

- **Red:** Add `fakeMsp.recordsCommandsAndEmitsOrderedEvents` and assert command order, exact params/IDs, and notification order; run `bun test test/unit/fake-msp.test.ts` and observe failure.
- **Green:** Implement a deterministic fake that can configure ack results, notification sequences, cursor replay/gaps, and crash points. It must not import Muse auth or make network calls.
- **Refactor:** Split command scripting from event scripting; verify existing assertions still pass.
- **Verification:** `bun test test/unit/fake-msp.test.ts`; fake tests run without `muse` installed or credentials.

### Slice 2: Request correlation and plugin seam

**Files:** `test/probes/correlation-plugin.js`, `test/probes/correlation-run.sh`, `test/integration/request-correlation.test.ts`.

- **Probe first:** Run the implementation-plan correlation probe against pinned OpenCode. Require session ID, directory, request kind, selected model/provider, and variant to arrive in `doStream` options. The runtime probe did not expose a direct `profileID` field on `request.model`; profile selection must be resolved from the selected catalog model unless a supported field is discovered. Test correlated `doGenerate` metadata only if a session-hooked path invokes it.
- **Probe generate paths:** Verify `/api/session/:sessionID/generate` (session-scoped) and `/api/experimental/generate` (stateless) separately. Session-scoped generate was observed to carry `kind="generate"` and a session ID through `doStream`, while leaving OpenCode history unchanged; do not send it as a normal turn to the live Muse session. The stateless route did not resolve the project-local provider in this probe; keep it unsupported in v1 unless a global-provider test establishes a safe route.
- **Red:** Add `correlation.isolatesConcurrentSessionsAndMetaRequests`; assert two overlapping sessions and title/compaction calls never observe one another's headers.
- **Green:** Implement a typed correlation decoder that returns `ContextError` for missing/invalid metadata; never use global “latest request” state.
- **Refactor:** Centralize namespaced header encode/decode and keep header strings out of user prompts.
- **Verification:** `bun test test/integration/request-correlation.test.ts` and pinned OpenCode probe. If the carrier fails, stop the in-process architecture and revise to the local proxy before continuing.

### Slice 3: MSP command IDs, view subscription, and host lifecycle

**Files:** `src/msp/client.ts`, `src/msp/host.ts`, `test/unit/msp-client.test.ts`, `test/unit/msp-host.test.ts`.

- **Red:** Add `msp.startAndResumeAttachAtReturnedHead`, `msp.viewSubscribeReplaysAfterObservedCursor`, `msp.replaysGaplessEvents`, `msp.retriesSameCommandIdAndPayload`, `msp.rejectsSchemaFingerprintMismatch`, `msp.malformedFramesFailClosed`, `host.boundsStartupAndCommand`, and `host.closesChildOnShutdown`; assert exact command IDs, event order, no raw diagnostic leakage, and no retry after an ambiguous timeout.
- **Green:** Implement the pinned SDK wrapper and per-OpenCode-session stdio process with bounded startup/command timeouts, exact schema fingerprint enforcement, SDK JSON-RPC/frame validation, cursor-aware subscriptions, sanitized diagnostics, and graceful close. Preserve unknown notification methods for feature consumers to safely ignore.
- **Refactor:** Separate process lifecycle from typed MSP command methods; keep both covered through the fake transport.
- **Verification:** `bun test test/unit/msp-client.test.ts test/unit/msp-host.test.ts`; no test reads Muse config or needs a live model.

**Pinned-runtime gate note:** Muse 1.4.11/Linux echo passes durable-session start, same-command deduplication, cursor replay, and reconnect resume, but explicit `session/fork.cutPoint` fails with `-32603 internal: file birth time is unavailable`; `session/rename` also fails despite a granted capability. Keep rewind/fork implementation blocked until the fork probe passes on a supported target; the user approved proceeding without it and tracking restoration in #20. Two authorized Meta probes confirmed `userMessage`/`agentMessage` item lifecycle and session token usage, but observed no `item/delta` and no `turn/completed.usage`. A third live Meta probe accepted a small inline image and one-chunk video upload in a completed turn. Audio/PDF/strict-JSON alternate routes, streaming deltas, and per-turn usage behavior remain unresolved. Contributor mode was left unchanged.

### Slice 4: Durable registry and workspace lock

**Files:** `src/session/registry.ts`, `src/session/workspace-lock.ts`, `test/unit/session-registry.test.ts`, `test/unit/workspace-lock.test.ts`.

- **Red:** Add tests `registry.writesVersionedPrivateAtomicStateAndReloads`, `registry.rejectsAWorkspaceFingerprintMismatch`, `registry.rejectsPromptOrUnknownFieldsBeforePersistence`, `registry.quarantinesCorruptEntry`, `lock.concurrentSameWorkspaceGetsOneOwner`, `lock.independentWorkspacesDoNotBlock`, and `lock.recoversDeadOwner`; assert persisted state contains only IDs/hashes/cursors/command fingerprints.
- **Green:** Implement versioned atomic persistence with restrictive permissions and a single-writer lock; implement a workspace-scoped lock with explicit `BusyError` and stale-owner recovery.
- **Refactor:** Put persistence behind a small adapter so corruption/concurrency cases remain deterministic.
- **Verification:** `bun test test/unit/session-registry.test.ts test/unit/workspace-lock.test.ts`; check directory/file modes and instrument filesystem paths to assert no `~/.config/muse` access. Unknown registry versions are quarantined (no legacy registry has been released to migrate).

### Slice 5: Catalog and OpenCode provider registration

**Files:** `src/catalog.ts`, `src/provider.ts`, `src/index.ts`, `test/unit/catalog.test.ts`, `test/integration/provider-registration.test.ts`.

- **Red:** Add `catalog.mapsMuseProfileModelLimitsAndEffortSidecar`, `catalog.keepsDisabledSetupFallback`, `catalog.retainsLastGoodCatalogOnFetchOrReloadFailure`, `provider.registersMuseViaFileFactory`, and `provider.setupReturnsBeforeCatalogNetworkDiscoveryFinishes`.
- **Green:** Convert `model/list` rows to OpenCode model entries; preserve profile/default/active metadata in a sidecar because `Model.Info` lacks those fields; register `muse`, the disabled setup fallback, `aisdk:file://` factory, and named language-hook drift diagnostic. Refresh cache before calling `provider.reload()` and do not block plugin setup on catalog network discovery. The real `language` hook is implemented in Slice 8.
- **Refactor:** Keep Muse-to-OpenCode mapping pure and provider wiring thin.
- **Verification:** `bun test test/unit/catalog.test.ts test/integration/provider-registration.test.ts`, `npm run build`, live `muse model/list` probe, and pinned OpenCode provider-list smoke test. The latter is currently blocked because `opencode models` and `provider.list` hang on an empty project without the plugin.

### Slice 6: Prompt/context extraction and input capability mapping

**Files:** `src/model/prompt.ts`, `src/model/context.ts`, `src/types.ts`, `test/unit/prompt.test.ts`, `test/unit/request-context.test.ts`.

- **Red:** Add tests for per-call correlation headers/selection lookup, missing and invalid context, concurrent session isolation, ordered transcript fingerprints, same-length divergence rejection, first-use history without replay, allowlisted context only, image/video byte mapping, remote URL rejection, and generation-option validation.
- **Red from probe outcomes:** Audio/PDF and strict JSON have no direct stable MSP shape; assert precise bridge-only errors for requested unsupported representations. Plain user text asking for JSON remains valid. Non-empty OpenCode tool catalogs do not fail validation; only an explicitly required OpenCode tool is unsupported. Ordinary sampling options are reported by name as ignored, never logged with values.
- **Green:** Map supported inline image bytes to MSP `image` parts and video to uploadable bytes for Task 10's `media/upload` chunker. Do not fetch remote URLs or forward old transcript messages; keep only fingerprint lineage and use a clear error on divergence.
- **Refactor:** Keep input normalization and OpenCode option validation pure; make errors identify the unsupported representation, not model capability.
- **Verification:** `bun test test/unit/prompt.test.ts test/unit/request-context.test.ts`; fake MSP asserts no turn starts after preflight validation failure.

### Slice 7: LanguageModelV3 event bridge

**Files:** `src/model/language-model.ts`, `src/model/stream.ts`, `src/session/manager.ts`, `src/provider.ts`, `src/index.ts`, `src/errors.ts`, `test/unit/stream-mapping.test.ts`, `test/unit/language-model.test.ts`, `test/unit/session-manager.test.ts`, `test/integration/turn-bridge.test.ts`.

- **Red:** Add `stream.emitsTextStartDeltaEndAndFinish`, `stream.usesObjectFinishReasonAndPerCallUsageFallback`, `stream.emitsTypedErrorForAsyncFailure`, `stream.emitsNoOpenCodeToolCalls`, `languageModel.doGenerateUsesOneMuseTurn`, `languageModel.uploadsVideoWithStableReceipt`, and `sessionManager.createsAndResolvesOneSessionPerOpenCodeSession`.
- **Green:** Implement shared Muse transaction for `doStream`/`doGenerate`; map agent items to V3 parts, reconcile completed text against streamed deltas, finish the OpenCode response at `turn/foregroundCompleted`, and continue the monitor through `turn/completed` before clearing the active-turn marker/releasing the lock. Prefer `turn/completed.usage`; otherwise sum deduplicated `session/tokenUsage` per-call counters (never cumulative snapshots); leave unknown usage unknown.
- **Red/Green disposition tests:** Assert `turn/start` disposition and `turnId` are authoritative; queued/unqueue events are not treated as started turns. Abort interrupts a running turn or unqueues a queued turn, never silently upgrades one operation to the other.
- **Refactor:** Deduplicate stream/generate collection without hiding cancellation or error behavior.
- **Verification:** `bun test test/unit/stream-mapping.test.ts test/unit/language-model.test.ts test/unit/session-manager.test.ts test/integration/turn-bridge.test.ts`; 108 package tests, build, and strict test type-check pass. The external pinned OpenCode runtime smoke is separately blocked because its empty-project CLI/provider-list baseline times out.

### Slice 8: Model routing, effort, and failure UX

**Files:** `src/model/context.ts`, `src/model/language-model.ts`, `src/errors.ts`, `test/unit/model-routing.test.ts`, `test/unit/errors.test.ts`.

- **Red:** Add `routing.startsWithSelectedProviderAndModel`, `routing.appliesProfileWithSetModel`, `routingPassesEffortOnTurnStart`, `errors.mapsOnlyVerifiedBillingFailure`, and `errors.preservesUnknownModelError`.
- **Green:** Use `session/start` for provider/model, `session/setModel` for later/full profile selections, and `turn/start.reasoningEffort` for per-turn variants; map only verified auth/billing errors to special copy.
- **Refactor:** Centralize route comparison so equivalent selections do not issue redundant model-change commands.
- **Verification:** `bun test test/unit/model-routing.test.ts test/unit/errors.test.ts`; fake MSP verifies exact command payloads and no standing-effort mutation.

### Slice 9: Local title, compaction digest, and lineage

**Files:** `src/model/meta.ts`, `src/session/fingerprint.ts`, `src/session/registry.ts`, `src/session/manager.ts`, `src/model/prompt.ts`, `src/model/language-model.ts`, `src/provider.ts`, `test/unit/meta-request.test.ts`, `test/unit/fingerprint.test.ts`.

- **Red:** Add `meta.titleUsesFirstUserOrFallback`, `meta.classifiesOnlyNarrowUnhookedShapes`, `meta.unknownStatelessGenerateDoesNotStartMuse`, `compaction.digestIsBoundedAndDeterministic`, `lineage.fingerprintsVisibleOrderedMessages`, `lineage.commitsCompactionOnlyAfterObserved`, `lineage.rejectsSameCountEdit`, and local-hook tests that observe no Muse turn.
- **Green:** Implement local title and bounded transcript digest; persist only the pending compaction output hash, never its text; continue a Muse session only when that exact candidate is observed in a later prompt, and clear the candidate after that turn reaches terminal completion.
- **Refactor:** Separate prompt-shape detection from summary construction and use canonical fingerprint helpers in rewind logic.
- **Verification:** focused pure tests plus provider hook/LanguageModel local-route tests; run the bounded pinned OpenCode compaction smoke if the CLI provider-list baseline responds (currently times out even in an empty project).

### Slice 10: Session recovery, rewind, and workspace safety

**Files:** `src/session/manager.ts`, `src/session/registry.ts`, `src/session/workspace-lock.ts`, `src/model/language-model.ts`, `test/integration/session-recovery.test.ts`, `test/integration/rewind-fork.test.ts`.

- **Red:** Add recovery tests for command pending before ack, accepted turn before view completion, persisted mid-stream cursor, foreground-complete/background-pending, and `view/gap`; assert no new command ID is used for an ambiguous side effect.
- **Red:** Add `recovery.rejectsAmbiguousPendingCommand`, `recovery.resumesDurableIdleSessionAtCursor`, `recovery.rejectsActiveSnapshotTurn`, `rewind.failsClearlyWhileForkGateIsBlocked`, `fork.startsASeparateMuseSession`, and `rewind.doesNotRollbackFilesystem`.
- **Green:** Reuse a pending ID only inside the SDK's exact in-process command retry. After restart, if the exact command payload is not persisted/reconstructable, require explicit user recovery choice. Resume only confirmed durable idle sessions; explicitly cut forks remain excluded from v1 and tracked by #20.
- **Green:** Acquire a workspace lock before the Muse turn and retain it through terminal completion/pending approval/background activity.
- **Refactor:** Keep registry transitions atomic and session manager as the sole owner of host/lock lifetimes.
- **Verification:** `bun test test/integration/session-recovery.test.ts test/integration/rewind-fork.test.ts` plus focused fake-MSP gap recovery; prior echo probe established the exercised durable idle resume/cursor subset. No PAYG probe is authorized by this task; Contributor mode remains unchanged.

### Slice 11: Approvals, narration, and structured input (conditional)

**Gate result:** OpenChamber UI inspection found only generic allow-once/always/reject controls, not Muse's exact dynamic choice labels/scopes. Do not create the approval/narration adapter.

- **Fail-closed verification:** The session manager initializes MSP with `userInputDialogs:false`; an unregistered Muse server request is rejected by the SDK as method-not-found. Tests assert no fabricated answer or approval decision.
- **No persistent authority:** No local auto-allow cache or choice ID synthesis exists. OpenCode tool-call parts remain suppressed; synthetic narration and file diffs are not claimed.
- **Verification:** host capability and default server-request behavior tests run in `test/unit/msp-host.test.ts`; no live PAYG approval probe is run because the UI gate failed and Contributor mode remains unchanged.

### Slice 12: Authentication UX and credential isolation

**Gate result:** OpenChamber source inspection found no plugin command-auth flow and no exact pinned billing failure was verified. Do not add an auth subprocess relay or infer sign-in from an empty session list.

- **No relay:** Adding an unavailable sign-in card/process path would violate the failed UI gate; no `src/auth.ts` is created.
- **Manual fallback:** README documents `muse login` in a terminal; auth remains in the official CLI and generic typed errors remain generic.
- **Verification:** source review and regression tests show no Muse config/credential reads or raw prompt/media/error logging. No live auth/billing probe was run.

### Slice 13: Final integration and package acceptance

**Files:** `test/integration/e2e-payg.test.ts`, `README.md`, `docs/compatibility.md`.

- **Red:** Add acceptance assertions for provider visibility, one text turn, selected model/effort, supported media/strict JSON cases from the pinned probe, cancellation, compaction, restart replay, rewind behavior, and zero OpenCode tool-call parts.
- **Green:** Wire the minimal missing behavior only; do not relax unsupported-feature assertions.
- **Refactor:** Remove duplicate protocol translation and ensure all diagnostics are sanitized.
- **Verification:** Run `npm run build`, `bun test`, `npm pack --dry-run`, clean-profile OpenCode smoke, then opt-in PAYG tests. Record CLI/schema/SDK/OpenCode versions and exact supported media/JSON behavior in `docs/compatibility.md`.
- **Release gate:** Re-check Meta terms before public release; do not claim unverified media, auth, approval, or resume behavior.

## Probe Gates Before Red–Green Product Cycles

- Pin the actual CLI/schema/SDK/OpenCode versions and compare them with the vendored schema.
- Prove request correlation for session-associated model calls; if absent or racy, revise to the local proxy before implementing the bridge. Probe stateless `doGenerate` separately and keep it context-free.
- Prove durable-session and cursor replay behavior before claiming restart recovery.
- Probe image/video/audio/PDF/strict-JSON capability through `muse serve`, rather than inferring MSP support from direct model/API documentation.
- Prove OpenChamber's approval/auth UI surface; if it cannot express Muse's protocol, defer the feature and keep it fail-closed.

## Questions, Risks, and Highlights to Discuss

- **No unresolved product decision is required to start the fake-MSP/TDD harness.** The correlation, target schema, media/JSON routes, durable-session behavior, and UI affordances remain hard technical probes.
- **PAYG availability:** live inference/approval tests require working inference access; the fake suite does not. The user's subscription-backed tests should keep Contributor mode enabled as requested, while normal code must never toggle it.
- **Multimodal scope:** the current vendored MSP schema has image/video parts but no direct audio/PDF turn parts. The plan intentionally probes these instead of calling the models incapable; if the exact pinned CLI has no route, those formats remain narrow v1 limitations.
- **Strict JSON:** ordinary text requests for JSON work as prompts; strict schema-constrained output depends on a `muse serve`/MSP control and is not yet proven.
- **Potential stale documentation:** `README.md` still describes the repository as being in the spike phase; update it with the implementation-status slice before public release.
