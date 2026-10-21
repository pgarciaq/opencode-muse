# OpenCode Muse Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task, according to the approved execution method. Do not begin implementation until this plan is approved. The initial probe tasks are gates; stop and revise the design if a gate fails.

**Goal:** Build `opencode-muse`, an OpenCode plugin that bridges OpenCode model requests to Muse-native agent turns through `muse serve` without reading or handling Muse credentials.

**Architecture:** The plugin registers a static/fallback Muse provider catalog and supplies a `LanguageModelV3` through the verified `aisdk:` hook. A per-OpenCode-session `muse serve` host owns one durable Muse session; MSP view subscriptions and persisted cursors carry output, approvals, and recovery. OpenCode transcript history is a projection, not Muse's source of truth.

**Tech Stack:** TypeScript ES modules; `@opencode/plugin` v2 API; `@muse-code/sdk` pinned to the verified Muse CLI schema; `@ai-sdk/provider` V3 types; `tsc`; Bun test runner; npm-compatible package metadata. Match the strict TypeScript and ESM conventions in `opencode-claude` unless the initial compatibility probe requires otherwise.

**Spec:** [`docs/design.md`](../design.md), v1.3.

## Global Constraints

- Muse auth and inference stay inside `muse serve` over stdio JSON-RPC via `@muse-code/sdk`.
- The plugin must never open, parse, copy, cache, log, or transmit `~/.config/muse` or Muse credential values.
- No OpenChamber source changes in v1; verify UI surfaces before promising auth/approval UI.
- Pin and test against exact OpenCode and Muse CLI/schema versions; schema declarations not matched to the binary are provisional.
- One `muse serve` process and one Muse session per OpenCode session in v1.
- V1 maps image/video through verified MSP parts; probe audio/PDF/strict JSON paths and report only bridge-specific limits. General stateless `generate` remains unsupported, and the plugin never fabricates `userInput/*` answers.
- Muse approval decisions use only currently offered `choiceId` + `requirementId`; no plugin-side persistent auto-allow.
- No automatic transcript rehydration or filesystem rollback on rewind; ambiguous side-effecting turns are never replayed automatically. Rewind/fork implementation stays blocked until explicit `session/fork.cutPoint` succeeds on a supported target runtime.
- Use the user's existing official-CLI Muse access for live probes (subscription-backed Contributor mode is preferred; configured PAYG is also acceptable); never require or extract credentials.
- Keep Contributor mode enabled for the user's subscription-backed live tests; the plugin and test harness must not toggle this account setting.

## Review Focus

- Missing or misrouted request metadata must not attach a Muse turn to the wrong OpenCode session; test concurrent sessions and the correlation fallback gate.
- Restart after `turn/start` acceptance must not duplicate file-changing work; test cursor replay, command IDs, and ambiguous outcomes.
- Compaction, same-length transcript edits, and rewind must not be conflated; test multiple compactions and explicit Muse fork cut points.
- Staged approvals and structured user-input prompts must fail closed when the UI cannot represent them; test stale requirement IDs and unsupported UI.
- Model/API capability must be mapped through MSP rather than rejected broadly; test image/video mapping, audio/PDF and strict-JSON protocol support, plus precise errors for genuinely unsupported requests.

---

## Planned File Structure

Create focused modules; adjust names only to match actual pinned SDK exports, and update this plan before changing responsibilities.

- `package.json`, lockfile, `tsconfig.json`: package/build/test metadata.
- `src/index.ts`: OpenCode v2 plugin entry and setup wiring.
- `src/provider.ts`, `src/catalog.ts`: provider registration, static fallback, live Muse model mapping/refresh.
- `src/msp/host.ts`, `src/msp/client.ts`: one child process and typed MSP connection per OpenCode session; command IDs and view subscriptions.
- `src/session/registry.ts`, `src/session/workspace-lock.ts`: durable mapping/recovery state and cross-process workspace exclusion.
- `src/model/context.ts`, `src/model/prompt.ts`: request metadata, role-aware context allowlist, supported input validation.
- `src/model/language-model.ts`, `src/model/stream.ts`, `src/model/meta.ts`: V3 `doStream`/`doGenerate`, event conversion, local title/compaction.
- `src/errors.ts`: safe typed Muse/OpenCode error mapping.
- `src/approvals.ts`, `src/narration.ts`: optional UI bridge and synthetic activity entries.
- `src/auth.ts`: `muse login` relay and verified wire-level state probe; no config-file access.
- `test/unit/**`, `test/integration/**`, `test/probes/**`: fake MSP/OpenCode tests and opt-in live probes.
- `docs/compatibility.md`: pinned version/schema fingerprints and probe outcomes, never credentials or raw sensitive output.

## Tasks

### Task 1: Pin the runtime and protocol contract

**Files:**
- Create: `docs/compatibility.md`
- No product code in this task.

**Interfaces:** Produces the exact Muse CLI version, exported MSP schema fingerprint, `@muse-code/sdk` version, and OpenCode version used by later tasks.

- [x] Record `muse --version` and `opencode --version`; record the SDK package version selected for the probe.
- [x] Use `muse schema --help` to identify the supported stable/experimental schema export commands; export both surfaces and record hashes plus the command used.
- [x] Compare the exported schema with vendored declarations for session durability/fork/cursors/command IDs, model selection, approval/user-input events, `TurnInputPart` media types and `media/upload`, and any structured-output control.
- [x] For any live protocol probe, use only the user's existing Muse login or a PAYG key configured through the official CLI; verify logs and artifacts contain no credential values. (No live model call was needed for Task 1.)
- [x] If the target schema differs in a way that changes v1 behavior, stop and update `docs/design.md` before proceeding. (No MSP schema drift found; OpenCode 2.1.2 target and the older 2.1.1 smoke baseline are recorded.)

**Verification:** `docs/compatibility.md` contains versions, hashes, and differences; secret scan/manual review finds no auth-file contents, tokens, API keys, or raw login output.

### Task 2: Probe OpenCode request correlation (hard stop gate)

**Files:**
- Create: `test/probes/correlation-plugin.js`
- Create: `test/probes/correlation-run.sh`
- Update: `docs/compatibility.md`

**Interfaces:** Probe a provider registered with the proven `aisdk:file://` factory and a custom LanguageModelV3. The test model records only sanitized metadata fields and outputs a fixed string.

- [x] Write the probe asserting `model.request` adds namespaced session ID, directory, kind, model ID/provider, and variant headers. Record whether profile ID is present directly; if not, resolve it through the selected catalog model mapping.
- [x] Run a session-associated request and assert those fields arrive intact in `doStream` options. Session-associated routes tested here invoked `doStream`; no session-associated `doGenerate` caller was observed.
- [x] Exercise `/api/session/:sessionID/generate` and `/api/experimental/generate` separately; session.generate correlated and left OpenCode history unchanged. The stateless route did not resolve the project-local provider at the model boundary, so it remains unsupported in v1; never attach context-free calls to a guessed Muse session.
- [x] Exercise two overlapping OpenCode sessions plus concurrent title/primary/compaction/generate calls on one server; assert context signatures match and sessions remain distinct.
- [x] Observe `session.generate` calls `doStream` in the pinned runtime; confirm the selected v1 behavior does not mutate Muse history or use the live Muse session.
- [x] Record sanitized output and PASS results in `docs/compatibility.md`, including catalog-based profile resolution and the context-free generate limitation.

**Gate:** If in-process request metadata is absent, incomplete, or racy, stop. Revise the design to the local-proxy architecture before writing the session bridge; do not use global “most recent request” state.

### Task 3: Create the TypeScript plugin scaffold and test harness

**Files:**
- Create: `package.json`, lockfile, `tsconfig.json`
- Create: `src/index.ts`, `src/types.ts`
- Create: `test/run.ts`, `test/helpers.ts`
- Modify: `README.md`

**Interfaces:** Export the OpenCode v2 plugin entry from `src/index.ts`; use the versions pinned in Task 1. `src/types.ts` owns internal types for `RequestContext`, `MuseModelSelection`, and error categories.

- [ ] Bootstrap `package.json`, `tsconfig.json`, and the Bun test script so tests/build can run; do not add bridge behavior in this step.
- [ ] Add a failing test asserting the package entry exports the OpenCode v2 plugin shape and strict TypeScript mode is enabled.
- [ ] Run the test and build to verify they fail for the missing plugin entry.
- [ ] Implement the ESM plugin entry and minimal setup that registers no provider until later tasks wire it.
- [ ] Add an npm-compatible published entry and only the pinned dependencies required by later tasks; follow `opencode-claude` conventions without unrelated dependencies.
- [ ] Run `npm run build` and `bun test`; verify both pass.

### Task 4: Probe Muse session durability and event recovery (hard stop gate)

**Files:**
- Create: `test/probes/msp-lifecycle.ts`
- Update: `docs/compatibility.md`

**Interfaces:** Use the pinned `@muse-code/sdk` connection to `muse serve`; record only IDs, event names, cursors, terminal kinds, and sanitized usage counts.

- [x] Echo probe: start a Muse session with an isolated workspace and record durability (`durable` from initialize).
- [x] Echo probe: verify start auto-attaches at the returned view cursor and a `turn/start` command retry with the same ID/payload returns the same turn with one `turn/started`; the local echo provider emitted no assistant text/item deltas and reported zero usage, so live response/usage verification remains pending.
- [x] Echo probe: disconnect and resume the same session; `view/subscribe` after the prior cursor replayed the terminal once, both before and after reconnect. `view/gap` recovery remains pending because no gap was induced.
- [ ] Live authorized turn: verify model-generated item/text lifecycle and nonzero or otherwise model-authored per-turn usage; keep Contributor mode unchanged.
- [x] Echo probe: re-submit `turn/start` with the exact same `commandId` and payload; the host returned the same turn and did not create a duplicate start event. Result is recoverable from the view; same-command replay did not create a second turn.
- [ ] Probe cancel vs interrupt vs unqueue, `turn/start` dispositions beyond `started`, approval park/resolution, and `view/gap` recovery.
- [x] Probe explicit `session/fork.cutPoint` and `session/rename`: on Muse 1.4.11/Linux, fork returned internal `file birth time is unavailable`; rename capability was granted but rename returned internal `session naming is unavailable`. Rewind/fork is therefore blocked on this target; custom names are best-effort only.
- [ ] Probe a small inline image, a video upload, audio/PDF input paths, and strict structured-JSON output through `muse serve`; record exactly which are accepted by the pinned protocol and which are not.
- [ ] Verify whether a successful fork cut at Muse turn N excludes all later completed turns and whether it changes workspace files (it must not be treated as a filesystem rollback); blocked until the explicit fork call succeeds on a supported target.

**Gate:** Restart resume is supported only for a matching runtime that reports durable sessions and passes cursor replay; the isolated echo host passed this subset, but a live Meta host remains unverified. The Muse 1.4.11/Linux fork failure is a hard stop for rewind/fork implementation: do not implement or advertise rewind until the runtime error is fixed or the explicit-cut probe passes on a supported target. Live model/media/UI-dependent work remains gated on the corresponding probes.

### Task 5: Probe OpenChamber UI and approval feasibility

**Files:**
- Create: `test/probes/openchamber-ui.md`
- Update: `docs/compatibility.md`

**Interfaces:** Use a test plugin against the user's OpenChamber/OpenCode runtime; do not alter OpenChamber source.

- [ ] Confirm a provider with a fallback model is visible when Muse is missing or logged out.
- [ ] Confirm `ctx.integration` auth methods are visible and can launch the `muse login` flow without logging raw stdout/stderr.
- [ ] Check whether the permission UI can display Muse's dynamic available-choice labels/scopes and return a specific choice; also test a changed approval stage/stale requirement.
- [ ] Check whether any available UI can collect the complete structured `userInput/requested` schema (single/multiple selection and free text). If not, record it as unsupported in v1.
- [ ] Verify whether OpenChamber detects/undoes files changed by Muse outside OpenCode-native tools. Record observed behavior; do not infer it from file watching alone.

**Gate:** If auth methods are not surfaced, use the documented manual `muse login` fallback. If dynamic approvals cannot be represented, defer the approval UI rather than mapping to generic allow/deny. Do not implement structured user input without a matching UI.

### Task 6: Build the fake MSP host and protocol adapter

**Files:**
- Create: `src/msp/client.ts`, `src/msp/host.ts`, `src/errors.ts`
- Create: `test/unit/msp-client.test.ts`, `test/unit/msp-host.test.ts`, `test/helpers/fake-msp.ts`

**Interfaces:** `MspHost.start(options) -> Promise<MspHost>`; `MspHost.command(method, paramsWithCommandId) -> Promise<result>`; `MspHost.subscribe(sessionId, after?) -> AsyncIterable<MspNotification>`; `MspHost.close() -> Promise<void>`. The UUIDv7 `commandId` is part of the typed params, not a second independent argument. Adapt exact SDK signatures from Task 1 rather than inventing wire shapes.

- [ ] Write fake-host tests for initialize, session start/resume/fork, view subscribe/replay, command IDs, notification ordering, child exit, malformed messages, and abort.
- [ ] Run tests and verify failures expose the missing wrapper behavior, not SDK/network access.
- [ ] Implement a stdio child lifecycle with bounded startup/command timeouts, stderr-only sanitized diagnostics, graceful close, and exit-code classification.
- [ ] Implement one MSP connection per OpenCode session; validate incoming events against the pinned SDK schema and ignore unknown additive notifications safely.
- [ ] Run `bun test test/unit/msp-client.test.ts test/unit/msp-host.test.ts` and `npm run build`.

### Task 7: Implement durable session registry and workspace lock

**Files:**
- Create: `src/session/registry.ts`, `src/session/workspace-lock.ts`
- Create: `test/unit/session-registry.test.ts`, `test/unit/workspace-lock.test.ts`

**Interfaces:** `SessionRegistry.get(opencodeSessionId, workspaceFingerprint)`, `put(entry)`, `updateCursor(...)`, `recordPendingCommand(...)`, `clearPendingCommand(...)`; `WorkspaceLock.acquire(workspaceFingerprint) -> LockLease | BusyError`, `LockLease.release()`.

- [ ] Write tests for atomic persistence, schema versioning, restart load, corrupt-file recovery, wrong-workspace rejection, concurrent writers, and stale lock recovery.
- [ ] Assert persisted records contain IDs, hashes, cursors, and command fingerprints only—no prompt bodies, transcripts, Muse config values, or raw CLI output.
- [ ] Run the tests red, implement versioned atomic state under the selected OpenCode user data/state directory with restrictive permissions and a single-writer lock, then run green.
- [ ] Test a second OpenCode session on the same workspace receives a clear busy result; test different workspaces proceed independently.
- [ ] Document platform paths and the lock strategy in `docs/compatibility.md`.

### Task 8: Register the provider and resilient catalog

**Files:**
- Create: `src/provider.ts`, `src/catalog.ts`
- Create: `test/unit/catalog.test.ts`, `test/integration/provider-registration.test.ts`
- Modify: `src/index.ts`

**Interfaces:** `buildOpenCodeCatalog(museCatalog, fallbackCatalog) -> ModelInfo[]`; `createProviderPlugin(ctx) -> Promise<void>`. Register provider ID `muse`, package `aisdk:${import.meta.url}`, and `createMuse` factory; apply live catalog refresh through `ctx.provider.reload()` only after replacing the cached catalog.

- [ ] Test mapping of Muse `providerId`, `profileId`, `modelId`, labels, context/output limits, release date, active/default status, and known effort variants.
- [ ] Run the catalog mapping tests and verify they fail for the unimplemented mapping.
- [ ] Test a logged-out/empty Muse catalog retains a clearly stale or disabled static catalog; ensure no fake model appears runnable without explanation.
- [ ] Test refresh preserves the last good catalog on failure and that provider reload actually re-runs discovery on the pinned OpenCode build.
- [ ] Implement registration with the proven `aisdk:file://` seam and a named drift diagnostic. Keep the npm `aisdk:@ai-sdk/openai-compatible` path documented as fallback, not a second untested primary.
- [ ] Run unit/integration tests, `npm run build`, and a live `opencode models`/provider-list smoke test.

### Task 9: Implement request context, input validation, and selection routing

**Files:**
- Create: `src/model/context.ts`, `src/model/prompt.ts`
- Create: `test/unit/request-context.test.ts`, `test/unit/prompt.test.ts`

**Interfaces:** `readRequestContext(callOptions) -> RequestContext | ContextError`; `extractTurnInput(prompt, previousFingerprint, contextAllowlist) -> TurnInput`; `validateModelOptions(options) -> SupportedOptions | UnsupportedOptionError`.

- [ ] Test correlation header parsing, missing/invalid metadata, concurrent session isolation, and context-free `doGenerate` handling for stateless generation; test correlated `doGenerate` only if the pinned runtime exposes that path.
- [ ] Test only new user content is sent; system/agent/project context follows §6.4 allowlist; tool catalogs and volatile system boilerplate are excluded.
- [ ] Test image data maps to MSP image parts; video chunks use UUIDv7 `commandId`s plus one shared `uploadId`, preserve chunk order, and yield a usable receipt; audio/PDF use a verified official path or produce a precise bridge-limitation error.
- [ ] Test ordinary user text requesting JSON remains a normal prompt; map strict OpenCode `responseFormat` if the pinned MSP/CLI supports it, otherwise reject only that strict constraint. Do not fail merely because OpenCode supplied tool definitions; reject only an explicitly required OpenCode-side tool that cannot be represented.
- [ ] Test remote media references are not fetched implicitly and size/cancellation errors occur before an unintended Muse turn.
- [ ] Test OpenCode model/provider/profile and effort map to `session/start`/`session/setModel` and `turn/start.reasoningEffort`; no standing effort change occurs for a per-turn variant.
- [ ] Run tests red, implement pure parsers/validators, then run green.

### Task 10: Implement LanguageModelV3 streaming and generation

**Files:**
- Create: `src/model/language-model.ts`, `src/model/stream.ts`
- Create: `test/unit/language-model.test.ts`, `test/unit/stream-mapping.test.ts`, `test/integration/turn-bridge.test.ts`

**Interfaces:** `createMuseLanguageModel(runtime) -> LanguageModelV3`; shared `runMuseTurn(context, input, options) -> AsyncIterable<MspNotification>`; adapters implement `doStream` and `doGenerate` using the same turn lifecycle.

- [ ] Write fake-MSP tests for text start/delta/end, reasoning if present, retry notifications, cancellation, successful terminal, typed failure, zero-text response, and unknown terminal values.
- [ ] Run the tests against the empty adapter and confirm they fail for missing behavior.
- [ ] Assert V3 `finishReason` is object form, usage uses flat number keys, and no OpenCode tool-call parts are emitted; strict JSON/forced OpenCode tool behavior matches the capability result from Task 4.
- [ ] Test `turn/start` dispositions and authoritative `turnId`; queued/unqueue events must not be treated as a running turn.
- [ ] Implement V3 stream-start/text/reasoning/error/finish mapping; reject before stream creation for startup failures and emit the V3 error part for asynchronous failures.
- [ ] Test `doGenerate` collects the same response and usage without creating a second Muse turn; assert `abortSignal` targets only the active turn.
- [ ] Run unit/integration tests and the pinned OpenCode echo-to-Muse bridge smoke test.

### Task 11: Add local title, compaction, and history lineage

**Files:**
- Create: `src/model/meta.ts`, `src/session/fingerprint.ts`
- Create: `test/unit/meta-request.test.ts`, `test/unit/fingerprint.test.ts`

**Interfaces:** `classifyMetaRequest(kind, prompt) -> "title" | "compaction" | "unsupported-generate" | "agent"`; `makeLocalTitle(prompt) -> string`; `makeCompactionDigest(prompt, maxOutputTokens) -> string`; `fingerprintTranscript(prompt) -> Fingerprint`.

- [ ] Test title detection via `kind` and unhooked prompt shape; no-session unknown generation returns the explicit unsupported error, never starts a Muse session.
- [ ] Test bounded transcript digest preserves initial request/recent exchanges, never claims inferred decisions, and is deterministic under repeated compaction and multilingual content.
- [ ] Test compaction candidate is committed only after the exact output hash appears in a subsequent prompt; cancellation/unpersisted output does not update the ledger.
- [ ] Test same-count earlier-message edits and genuine rewind diverge; exact observed compaction continues the existing Muse session.
- [ ] Run tests red, implement deterministic local handlers/fingerprints, then run green and an OpenCode compaction smoke test.

### Task 12: Add Muse session lifecycle, restart recovery, and rewind

**Files:**
- Create: `src/session/manager.ts`
- Create: `test/integration/session-recovery.test.ts`, `test/integration/rewind-fork.test.ts`
- Modify: `src/session/registry.ts`, `src/msp/client.ts`

**Interfaces:** `resolveSession(context) -> MuseSessionBinding`; `startOrResume(binding) -> MspSession`; `forkAt(binding, lastRetainedTurnId) -> MuseSessionBinding`; `recoverPendingTurn(binding) -> RecoveryResult`.

- [ ] Test one host/session, durable session check, `session/start` + non-sensitive rename, cursor persistence, `session/resume`, view replay, and host reaping only when no work is pending.
- [ ] Test crash after command write but before ack, after ack but before events, during stream, and after foreground completion; no test may silently submit a new command ID for the same user turn.
- [ ] Test same-ID retry only when exact payload is deterministically reconstructed; otherwise assert recovery returns “user choice required” without replay.
- [ ] Test rewind at a mapped completed Muse turn uses explicit `cutPoint.lastTurnId`; unmappable/mid-turn boundary returns a clear error; old Muse session remains available as the preserved branch.
- [ ] Test OpenCode fork creates an independent Muse session and does not share a live session; filesystem is never rolled back by the bridge.
- [ ] Run recovery/fork tests against the unimplemented manager and verify they fail for the expected missing transitions.
- [ ] Implement session resolution, durable resume/view replay, explicit-cut fork mapping, recovery state transitions, and host/workspace-lock ownership in `src/session/manager.ts`.
- [ ] Run integration tests against fake MSP, then the opt-in PAYG lifecycle probe on the pinned CLI.

### Task 13: Add approval bridge and narration (conditional on UI gate)

**Files:**
- Create: `src/approvals.ts`, `src/narration.ts`
- Create: `test/unit/approvals.test.ts`, `test/unit/narration.test.ts`, `test/integration/approval-ui.test.ts`

**Interfaces:** `handleApprovalRequested(event, permissionUi) -> Promise<void>`; `mapApprovalReply(event, reply) -> OfferedMuseChoice`; `narrateMuseActivity(sessionId, events) -> Promise<void>`.

- [ ] First require Task 5 proof that UI can render Muse choices/scopes; if not, do not implement generic allow/deny substitution—record approvals as unavailable in v1.
- [ ] Test exact offered `choiceId` and `currentRequirementId`, persisted UUIDv7 command ID, `approval/updated` stage change, stale-stage rejection, `approval/resolved`, timeout/close behavior, and fail-closed unmatched UI reply.
- [ ] Assert no local always cache, no choice ID synthesis, no raw args/secrets in logs or registry, and no host reaping while an approval is pending.
- [ ] Test narration coalesces file/tool activity and does not create OpenCode tool-call parts or claim native diff/undo support.
- [ ] Run unit tests against the unimplemented approval/narration handlers and confirm expected failures.
- [ ] Implement `userInput/*` only if Task 5 proves a structured UI; otherwise test `userInput/interrupt` yields a clear unsupported-input result with no fabricated answer.
- [ ] Implement only the UI-approved choice mapping and narration behavior; keep the feature unavailable when the UI gate failed.
- [ ] Run tests and opt-in live approval round-trip on PAYG.

### Task 14: Add safe auth UX and OpenChamber integration fallback

**Files:**
- Create: `src/auth.ts`
- Create: `test/unit/auth.test.ts`, `test/integration/auth-ui.test.ts`
- Modify: `README.md`

**Interfaces:** `probeMuseAuthState(host) -> AuthState`; `runMuseLogin(processAdapter, ui) -> LoginResult`; `classifyMuseFailure(turnError) -> UserFacingError`.

- [ ] Test logged-out behavior at every observed point in the pinned CLI lifecycle; empty `session/list` must not imply signed-in.
- [ ] Test only the exact verified billing failure maps to subscription/PAYG advice; generic `modelError` remains a generic typed failure.
- [ ] Test `muse login` stdio/TTY path, cancellation, timeout, missing CLI, and that raw stdout/stderr is never persisted or logged.
- [ ] Verify auth methods appear in OpenChamber; if not, README documents manual `muse login` and no unavailable sign-in card is promised.
- [ ] Add a no-config-read regression test by instrumenting the filesystem/process/logging boundaries; assert the plugin never reads Muse config paths, exports credential values, or logs sentinel secret values.
- [ ] Implement the verified auth-state probe, safe login relay, and typed user-facing auth/billing errors; if UI integration is unavailable, expose manual-login guidance only.
- [ ] Run tests and manual UI verification.

### Task 15: Final end-to-end gates and packaging

**Files:**
- Modify: `README.md`, `docs/compatibility.md`
- Modify: `package.json`, publish files only as required by build output.
- Create: `test/integration/e2e-payg.test.ts`

**Interfaces:** All earlier modules wired through `src/index.ts`; no OpenChamber source modifications.

- [ ] Run `npm run build` and `bun test`; require zero failures.
- [ ] Run the full opt-in PAYG test: provider visible while logged out; login guidance; model/effort selection; text/image turns; video where the pinned host supports it; strict JSON only where supported; `doGenerate`; cancel; compact; restart/replay; rewind fork; and no OpenCode tool calls.
- [ ] Run conditional approval UI test; if UI gate failed, assert approval feature is explicitly unavailable and fails closed.
- [ ] Verify a no-subscription billing response remains typed and actionable; verify no auth/config file was opened by the plugin.
- [ ] Test `npm pack --dry-run` and install the packed artifact into a clean OpenCode test profile; confirm `aisdk:file://` factory import and fallback catalog.
- [ ] Update README with install/login, unsupported v1 inputs/features, workspace lock behavior, rewind/file-restore limitation, and troubleshooting.
- [ ] Re-verify the ToS position recorded in the design before any public release or package publication.
- [ ] Record exact versions, schema fingerprints, probe outcomes, and remaining limitations in `docs/compatibility.md`; perform a final adversarial review before release.

## Execution Stop Conditions

- Task 2 correlation failure: do not begin Tasks 8–12 on the in-process architecture; revise to local proxy first.
- Task 4 non-durable sessions or failed cursor replay: do not promise restart resume; revise v1 scope and recovery wording.
- Task 5 UI cannot represent Muse approvals: keep approvals unavailable in v1; do not weaken Muse policy.
- Any target-schema mismatch affecting command IDs, fork boundaries, usage, terminal events, media parts/uploads, or structured-output controls: revise this plan and design before implementing the affected task.
- No PAYG key: unit/fake-MSP work can proceed after gates that do not need inference; defer live turn/approval confirmation and do not claim it passed.
