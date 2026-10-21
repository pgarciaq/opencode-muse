# opencode-muse — Design

**Status:** draft v1.1 for review · 2026-10-21 (v1.0 + adversarial-review fixes C1–C4, W1–W8, N1–N11)
**Decision basis:** spike issue [#1](https://github.com/pgarciaq/opencode-muse/issues/1) (probe record: Q1 verdict, close-out, smoke-test comment). Companion context: TheStreamCode/opencode-muse-auth#12 (compliance concern that motivates this design).

---

## 1. Goal and non-goals

**Goal.** Let OpenChamber (an IDE wrapping OpenCode) use a Muse Code subscription through a new OpenCode plugin, `opencode-muse`. The plugin drives `muse serve` (MSP — Muse's JSON-RPC session protocol, spoken through the `@muse-code/sdk` npm client): auth and inference stay inside the Muse CLI. OpenCode's model seam receives a custom `LanguageModelV3` implementation; Muse's CLI runs its own agent loop and tools.

**Non-goals (this phase).**
- No changes to OpenChamber source. Plugin-registered providers surface in OpenChamber automatically.
- Never extract, cache, or inject the subscription credential into OpenCode. The plugin never reads `~/.config/muse` contents (not even auth metadata — see §2).
- Not a replacement for the existing direct-API providers (pay-as-you-go `META_API_KEY` works today, documented by Meta).

## 2. Compliance invariants (design-wide, tested in review)

1. The plugin talks to Muse **only** through the `muse` CLI (host process over stdio JSON-RPC). No direct calls to Meta endpoints using any credential the CLI holds.
2. The plugin **never parses or copies** `~/.config/muse/auth.json` or settings files — not even "safe" metadata fields (`subs_active`, `mechanism`, `user_email` live in the same JSON as the `access_token`, so field-level access is not enforceable: parsing the file loads the tokens into plugin memory, and one stray log line or error serializer becomes a leak). State is inferred exclusively from wire-level surfaces (handshake result, session/list, typed turn failures, CLI exit codes). If identity display is ever wanted, the sanctioned route is MSP `account/read` under the experimental capability flag — negotiated and typed, never file parsing.
3. `muse login` remains the user's action; the plugin only relays its output (device code + instructions).
4. Before public release, re-verify ToS position (§3.2/§13.4 cited in opencode-muse-auth#12) for "integration through the CLI as a client".

**Trust boundary (documented, not ours to solve).** OpenCode's plugin model is the trust boundary: any project plugin can spawn `muse serve` or register hooks for the `muse` provider id. This design guarantees only *this plugin's* behavior; it cannot and does not claim to protect the user from other plugins.

## 3. Verified runtime foundations

Everything in this design builds on live evidence (see #1 for probes):

| Foundation | Evidence |
| --- | --- |
| `aisdk.hook("sdk" \| "language")` seam works for user plugins | Smoke test: provider `seam-smoke/echo` served a hand-rolled `LanguageModelV3`; run rendered its text, exit 0 |
| Hook path engages **only** if the provider's `package` starts with `aisdk:` | Same smoke test: plain packages bypass hooks entirely |
| No npm needed at plugin load: `aisdk:file://<module-url>` + a `create*` export lets the bundled dynamic-provider plugin build the SDK host object from the plugin module itself | Smoke test log: `createSeamSmoke called → sdk hook → language hook → doStream` |
| OpenCode forwards its full builtin toolset (18 tools) into `doStream` params; a model that ignores them suppresses OpenCode tools **without any OpenCode-side config** | Smoke test: `forwarded-opencode-tools=18` |
| Meta-request classes (title generation, compaction) arrive as ordinary model calls; OpenCode rejects tool calls during summary generation | Listener capture of the `/title-gen` system prompt; opencode-cursor `request-classifier.ts` precedent |
| Muse 1.4.11 has **no** client-side tool-disable knob (muse always advertises its 26-member `muse` toolset) | Probe Q1 (#1, fake-provider harness) |
| `model/list` (stable) returns the full catalog with effort variants | Probe Q8 (#1) |
| Failures are typed on the wire: `turn/completed` with `terminal="failed"`, `error.kind`, `retryable`; host exit 3 = credentials | Probes Q7 + live 402 |
| Meta-request precedent: opencode-claude (`request-kind.ts`, `session-store.ts`) and opencode-cursor (`request-classifier.ts`) both detect title/summary requests and serve them off the live session | Source inspection |
| OpenCode plugin context offers `permission.create`/`reply` (`allow\|deny\|ask`) and `session.synthetic` | Type inspection (#1 close-out) |
| OpenCode removes providers with **zero models** from `provider.list()` (hides them in OpenChamber) | opencode-cursor `fallback-catalog.ts` (comment) |
| Stable-MSP surface audit: `userInput/*` family, `session/rename`, `session/sideChat`, `turn/retryScheduled`/`retracted`/`unqueued` exist; `session/promptHint` is **experimental-only** and a read-only table query; no `session/delete` exists | Vendored `msp.d.ts` inspection (stable + experimental bundles) |

## 4. Architecture overview

```
OpenChamber ── spawns ──> opencode serve (v2.1.1)
                             │  loads plugins (.opencode/plugins or config "plugin")
                             ▼
                      opencode-muse plugin (this repo)
                             │
        ┌────────────────────┼─────────────────────────────┐
        │                    │                             │
  provider.transform    aisdk.hook("language")      session/permission hooks
  registers provider    supplies LanguageModelV3    approvals + narration
  "muse" + models       bridge per model+variant
        │                    │                             │
        └──────────┬─────────┴──────────────┬──────────────┘
                   ▼                        ▼
          muse session registry      MSP client (@muse-code/sdk)
          (OpenCode session ↔        spawns `muse serve --provider meta`
           muse session map)         one host per active OpenCode session
                                      session/start · turn/start · item/* ·
                                      approval/* · turn/cancel …
```

One architecture, two planes:

- **Model plane** (per model call): `LanguageModelV3` ⇄ MSP turn lifecycle. Stateless from OpenCode's perspective; muse holds the conversation.
- **Session plane** (per session lifecycle): mapping, host pooling, resume, approvals.

## 5. Plugin surface and registration

**Entry:** npm package `opencode-muse`, v2 plugin shape `{ id, setup(ctx) }` (consumed via config `"plugin": ["opencode-muse"]`). The same module bundle must also expose a provider *package* factory for the bundled dynamic plugin (§5.2).

### 5.1 Provider registration

```ts
await ctx.provider.transform((providers) => {
  providers.add({
    info: {
      id: "muse",
      name: "Muse Code",
      activation: "enabled",
      // Route model construction through the hook system: the "aisdk:"
      // specifier is what OpenCode's model resolver keys on. Point it at
      // THIS module so the dynamic provider plugin imports it locally.
      package: `aisdk:${import.meta.url}`,   // aisdk:file:///…/dist/index.js
      settings: { /* carrier only; hooks ignore it */ },
    },
    models: buildCatalog(currentCatalog()),  // §8
  });
});
```

- `import.meta.url` works both when loaded from `.opencode/plugins/` (dev) and from the npm cache (`~/.cache/opencode/npm/...`) — no hardcoded paths, no npm fetch for the SDK package.
- Fallback registration if the `file://` factory trick regresses in a future OpenCode: `package: "aisdk:@ai-sdk/openai-compatible"` (real published package; the bundled dynamic plugin installs it from the registry — proven to reach the registry in probes) plus the plugin's own `language` hook replacing the model in place. Last-resort fallback: opencode-claude-style local proxy.
- The `sdk` hook fills in only when absent; the `language` hook **always** provides the muse bridge for `providerID === "muse"`:

```ts
await ctx.aisdk.hook("language", async (input) => {
  if (input.model.providerID !== "muse") return;
  input.language = getBridge(input.model);           // §6
}, { providerID: "muse" });
```

### 5.2 The `create*` export (SDK-package role of the same module)

```ts
export function createMuse(options) {
  // Called by the bundled dynamic provider plugin BEFORE this plugin's sdk
  // hook runs (proven ordering). Return a stand-in host object; the real
  // model is supplied by the language hook below.
  return {
    languageModel: () => {
      // Reached only if the language hook did NOT replace us — i.e. the
      // hook seam regressed. Throw a named drift diagnostic rather than a
      // mystery TypeError: this is the seam-regression tripwire.
      throw new Error(
        "opencode-muse: language hook did not engage (OpenCode seam drift?)",
      );
    },
  };
}
```

The dynamic plugin expects a `model()`-less factory that yields an SDK host; our `language` hook replaces the eventual `LanguageModelV3` before construction, so `languageModel()` is never called in a healthy run — its throw is the named tripwire for seam regression (distinct from §5.1's fallback registration, which handles the same failure by another route).

## 6. The language bridge — `LanguageModelV3` over MSP

One bridge object per (model, variant). Implements `doStream` only (doGenerate throws; OpenCode streams everything).

**Request correlation (Phase-1 verification item — first probe).** `doStream` receives prompt parts and tool definitions, nothing that identifies the calling OpenCode session. Everything below (kind routing, session mapping, `workspaceRoot`) depends on a correlation carrier: the `session.hook("model.request")` layer stamps each request with `{sessionID, directory, kind}` (opencode-claude's precedent carries these as request headers through its local proxy), and the bridge reads them back from the `doStream` call options. Whether the in-process V3 seam preserves such headers/options is **not yet verified** — the smoke test's echo model needed no session context. If no carrier exists, the fallback is the opencode-claude local-proxy shape, where HTTP headers carry it naturally.

### 6.1 Request-kind routing (decided)

OpenCode makes model calls of different kinds. The `session.hook("model.request")` input carries `kind`; fall back to system-prompt sniffing (opencode-claude's heuristics) if `kind` is missing in practice.

| OpenCode request kind | Handling | Muse calls |
| --- | --- | --- |
| `title` (thread title) | **Local, zero calls.** Title = first user message (from the request's message list — title requests carry the conversation prefix; verify payload shape in Phase 1) truncated to ~50 chars. Muse context is authoritative, so title quality is cosmetic. | none |
| `compaction` (summary) | **Local, zero calls.** Summarize from the messages carried by the compaction request itself (self-contained — no mirrored store needed); must not emit tool calls (OpenCode rejects them here). | none |
| `generate` (stateless one-shot, `/api/experimental/generate`) | **Scratch muse session, never the live one** (opencode-claude namespaces the same way). `session/sideChat` is the stable-MSP candidate; verify semantics in Phase 1. | one scratch turn |
| default (agent turn) | **Muse turn** on the mapped muse session (§7) | `turn/start` (+ `turn/steer` if queued) |

Rationale: the ~13-model-calls/turn multiplier (§14) makes every muse round trip expensive; title/compaction carry no value from muse because muse owns the conversation context anyway.

**What "local" means (compaction).** The summary is written by plugin code running inside the `opencode` process — deterministic, zero model calls of any kind (no muse turn, no other OpenCode model). It is entirely separate from muse's own context management (`session/compact`), which muse applies to its authoritative session independently and is untouched by this path.

**Why answer compaction locally at all** — muse never consumes the result (the bridge sends only *new* user content each turn), but the call isn't optional for OpenCode: when compaction fires, something must come back successfully. The options considered:

| Option | Outcome |
| --- | --- |
| Forward to the live muse session | Pays the ~13× multiplier; the summarization prompt and its answer land in muse's history, polluting the real conversation |
| Route to a scratch muse session | Real LLM summary, no pollution — but still pays the multiplier every time, for output muse will never read |
| Fail the request | OpenCode's compaction step errors (surfaced to the user, possibly retried) and its transcript grows unbounded |
| **Answer locally (chosen)** | Step succeeds, costs nothing, no side effects anywhere |

**What the local summary is for** — bookkeeping for the projection only: (1) OpenCode's compaction step completes cleanly; (2) the transcript OpenCode/OpenChamber holds and renders stays bounded in long sessions; (3) portability — if a session is later moved to another provider, that provider *does* receive the transcript; (4) OpenCode features that read session history (subagent flows, export) operate on the trimmed transcript. Heuristic quality is acceptable precisely because the real context lives in muse.

**Compaction must not read as rewind (§7).** Both compaction and rewind shrink OpenCode's prior-message history, so §7's rewind detector would otherwise fork the muse session on **every compaction** — destroying the context it exists to protect, on long sessions where compaction fires automatically. Because the bridge *authors* the summary, it can do two things: (1) embed a recognizable marker in the summary text (stable prefix), and (2) update the session registry's fingerprint ledger at the moment it serves the compaction request. Rewind detection then distinguishes the cases: shorter history **with our marker / a ledger-anticipated compaction** → continue the same muse session; shorter history with a diverging tail and no anticipation → rewind/fork.

### 6.2 Touching muse: the turn protocol

For an agent-kind call the bridge:

1. **Resolve the muse session** for the correlated OpenCode session (§6 correlation; §7). On the first turn of a session: `session/start` (workspaceRoot = the session's directory, approvalMode default) followed by `session/rename` (`opencode: …`, §7 hygiene).
2. Map the **new** user content only (muse owns prior context — advise: never replay full history per turn):
   - text parts → MSP text input items,
   - file/skill/system additions from OpenCode that must reach muse go in as a **plain text preamble** (MVP). `session/promptHint` is *not* a candidate: schema-verified as experimental-only and a read-only model-facing table query, not a context-injection channel,
   - image parts → **stripped in MVP with a narrated warning** (synthetic part: "image dropped — muse image input unverified"), so one accidental screenshot doesn't kill the request; the turn proceeds on text. Hard-reject revisited if the build-time probe (§14) shows muse can't consume them usefully.
3. `turn/start` and translate the notification stream into V3 stream parts:

| Muse event | Bridge → V3 part |
| --- | --- |
| `item/started` (assistant text) | `text-start {id}` |
| `item/delta` (text) | `text-delta {id, delta}` |
| reasoning item deltas (if muse emits them) | `reasoning-start/delta/end` (build-time probe) |
| `item/…` (tool/file events) | **not** model output → narration path (§9) |
| `session/tokenUsage` (notification) | collected for the finish part — **summed across the turn's internal calls** (final-event-wins would undercount the ~13-call multiplier) |
| `turn/completed` terminal `completed` | `finish { finishReason:{unified:"stop"}, usage }` |
| `turn/completed` terminal `failed` | `finish { finishReason:{unified:"error"} }` (+ OpenCode error surface §10) |
| `turn/completed` terminal `cancelled`/`interrupted` | `finish { finishReason:{unified:"other"} }` |
| `turn/retryScheduled` / `turn/modelRetryScheduled` | keep the stream open (the turn is still in flight); narrate a retry note |
| `turn/unqueued` | narrate (a queued turn began running) |
| `turn/retracted` | end the stream with `finish { finishReason:{unified:"other"} }` |
| `turn/foregroundCompleted` | ignore in MVP (semantics probe) |

Wire-format facts verified in the smoke test (must hold for all emitted parts): `finishReason` is the **object form** (`{unified:"stop"}`) — string literals fail OpenCode's internal schema; `usage` uses **flat number keys** (`inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`) — not the nested V3-spec shape.

4. **Abort/OpenCode cancel:** the `doStream` abortSignal maps to `turn/cancel` (vs `turn/interrupt`/`turn/unqueue` — disambiguate semantics in Phase 1); if muse got stuck on an approval (§10), the parked turn is closed via the host pool reaper instead (opencode-claude's lesson: an abort never reaches a turn with no open HTTP request).

### 6.3 “Suppression” invariant (test)

The bridge never emits `tool-input-start`/`tool-call` parts. OpenCode's tools stay registered and are even forwarded into `doStream` params — they are ignored by construction. Test in CI once muse is live: a full agent turn must generate **zero** OpenCode tool calls and **zero** OpenCode permission prompts for tools.

## 7. Session management

**Registry.** `session-store` (opencode-claude pattern): OpenCode sessionID → `{ museSessionID, hostID, workspaceFingerprint, rev }`. OpenCode sessions are the user-facing keys; muse sessions are durable in the user's muse home. **The registry itself persists** (JSON in the plugin's data dir, keyed by OpenCode sessionID + workspace fingerprint), loaded and reconciled at plugin startup — otherwise an OpenCode restart orphans every durable muse session and silently starts fresh, defeating the resume path below. Reconciliation drops entries whose muse session no longer resumes.

**Host pool.** One `muse serve` child per *active* OpenCode session (bridge-pool pattern):
- spawn lazily on first muse turn of the session;
- reap after an idle TTL; also close on `session.execution.interrupted/failed` events (the clean-up opencode-claude had to add);
- a host owns 1..N muse sessions but serves one connection (MSP is client-per-stdio-process).

**Resume.** Muse sessions survive CLI restarts (`session/resume` returns inline history). The plugin resumes instead of starting fresh whenever the registry has a muse session id and the workspace fingerprint matches.

**Session naming & hygiene.** MSP has no `session/delete`, so abandoned/forked muse sessions accumulate in the user's muse home and will surface in `muse resume`. Name every plugin-created muse session at start via `session/rename` (`opencode: <session title>`) so they are identifiable and filterable. Accepted externality for v1; revisit if muse grows a prune surface.

**Rewind / divergent history (decided).** *Rewind* is the OpenCode/OpenChamber UI action that edits conversation history: the user picks an earlier point in the session and drops everything after it, then continues from there (`git reset` for the transcript). Session *fork* is the same idea keeping both branches. In a vanilla OpenCode setup this is trivial — OpenCode truncates its transcript and the next model call simply sends the shorter history. Here it is not, because the design has **two sources of truth**:

```
user rewinds to message #3
        OpenCode transcript:  1 2 3 [4 5 dropped]      ← truncated
        muse session:         1 2 3 4 5 ...            ← still remembers everything
```

The bridge only ever sends *new* user content to muse, so without intervention muse would keep reasoning from the discarded turns — the rewind would silently do nothing from the model's side. OpenCode-side history edits (rewind, fork) never mutate muse's session; the bridge is session-authoritative and never re-replays old context into the muse session after the first turn.
- **Detection:** compare the incoming prompt's prior-message fingerprint with the registry's (`rev` counter). A backwards move is rewind/fork **only if not anticipated by a compaction we served** (§6.1's ledger update + summary marker) — compaction also shrinks the history but must continue the same muse session.
- **Policy:** on rewind, `session/fork` a NEW muse session from the current one (preserves muse's runtime view of the workspace), re-point the registry, mark the old muse session abandoned. MVP alternative if `session/fork` proves awkward live: start a fresh muse session and seed it with one "state recap" turn derived from the truncated OpenCode transcript (rehydration), clearly marked in narration.
- OpenCode fork (`--fork`) is just a new OpenCode session id → normal registry path (map to the same muse session? No: OpenCode forks are independent sessions; sharing a muse session across two OpenCode sessions would interleave context. Map forks to fresh muse sessions via fork/rehydration as above).

**Multiple sessions:** each OpenCode session has its own muse session; no sharing, no cross-contamination. Known limitation: two concurrent OpenCode sessions in the *same directory* run two concurrent muse agents editing the same files — muse has no cross-host workspace lock. v1 documents this; per-workspace serialization is a possible later hardening.

## 8. Models and variants

From `model/list` (stable surface, 5 models on provider `meta`; defaults e.g. `muse-spark-1.3-contributor` under contributor mode):

- `Model.Info` per muse model: `modelId` as OpenCode model id, context/output limits, `released` date, display name (`displayLabel`), active/default flags map to `status`/`enabled`.
- Effort tiers (`minimal…max`, per-model subsets) → OpenCode **variants** with empty settings (effort is carried by the bridge → `session/setReasoningEffort` on turn start; opencode-claude precedent).
- **Fallback catalog (required, not optional).** OpenCode removes providers with **zero models** from `provider.list()`, hiding them in OpenChamber (opencode-cursor hit this and ships a placeholder seed). Since `model/list` needs a spawned, authenticated host, a muse-missing or logged-out startup would register an empty catalog and make the provider — and §11's sign-in cards — unreachable. Ship a static seed (known models, or one placeholder when entirely stale) and refresh from `model/list` once a host is available.
- Catalog refresh: cache + periodic refresh via `provider.reload()` (opencode-claude pattern; 10-min TTL guard).

## 9. Narration (muse tool/file activity → OpenCode transcript)

Muse runs its own tools (26-member `muse` namespace); OpenCode sees nothing unless we narrate.

- Bridge subscribes to muse `item/*` tool/file events and posts compact entries via `session.synthetic({sessionID, text, description, metadata})` — e.g. "muse: edited src/foo.ts (+12/−3)".
- Aggregate, don't spam: coalesce consecutive file-edit items per turn into one synthetic entry. Full diffs stay in OpenCode's file-history only if a tool runs on the OpenCode side (out of scope here); muse edits are narrated, not diffed.
- Approval parking (§10) interleaves here: approval cards are permission requests, not narration.

## 10. Approvals bridge

Muse approves side-effectful actions on the wire (`approval/requested`, decide via `approval/decide`; default `on-request` mode).

```ts
// muse approval/requested →
const { id, effect } = await ctx.permission.create({ sessionID, action: "muse", resources: [describe(subject)], metadata: {...} });
if (effect === "ask") { const reply = await pendingReply(id);        // await OpenCode UI
  await msp.command("approval/decide", { sessionId, approvalId, choiceId: map(reply) }); }
```

- `Permission.Effect` = `allow | deny | ask`; muse parks the turn while a decision pends (Paseo — another MSP-speaking client, our second reference integration — fixture evidence), so no timeout bridging is needed.
- OpenCode reply vocabulary (`approve/deny/always`) maps to muse choice ids (`allow_once` preferred; `always` → `allow_always` if offered, else mark in registry to auto-allow next time — **scoped to the approval subject** (tool + path/command prefix, never global) and **expiring with the OpenCode session**, so a prompt-injected tool output can't parlay one "always" into unrestricted shell).
- Approval cards carry the muse subject descriptor (tool + args summary) in `resources`/`metadata` so the OpenChamber UI shows a readable card.
- Per-approval mode: session/start picks the muse approval mode; MVP uses the default (`on-request`). A setting can relax it to auto-approve for trusted contexts (explicit user choice, off by default).
- **`userInput/*` bridging (Phase 2, same machinery).** Muse can ask the user a clarifying question mid-turn (`userInput/requested`; `userInput/answer`/`clarify`/`interrupt` exist in stable MSP). Unhandled, the turn parks indefinitely with nothing user-visible. MVP mapping: surface the question as a permission-style card; "proceed" → `userInput/answer` (proceed with best judgment), "dismiss" → `userInput/interrupt`; narrate either way.

## 11. Auth, state detection, and login UX

- **No config parsing.** The plugin never opens `~/.config/muse` (invariant §2.2): the file's metadata and secrets share one JSON document, and its schema is undocumented internal storage that can change in any patch release, whereas MSP surfaces are versioned. Detection is on-demand (sign-in card, first failed turn) and costs one host spawn. For identity display ("signed in as …"), use `account/read` behind the experimental capability flag if ever justified. State comes from wire surfaces only:
  - logged-out: the host exits with code 3 (credentials) — at spawn or on the first auth-needing call; the exact sequencing is a Phase-1 probe — → "run `muse login`" card;
  - logged-in without subscription: live-verified typed failure `402 Billing verification failed` (`modelError`, non-retryable) surfaced on the first turn → "no active Muse Code subscription — subscribe or set a pay-as-you-go key" (set via `muse auth set --provider meta --api-key-stdin`; `META_API_KEY` takes priority over account login — verified in CLI help).
- **Sign-in integration method** (OpenCode integration domain, opencode-claude pattern): `authorize` spawns `muse login`, relays stdout (device code + URL instructions) into the UI, then polls a cheap state probe (`session/list`) until success; progress and errors are surfaced verbatim from the CLI.
- Install detection: `muse` on PATH (+ `muse --version` fingerprint for the drift check, §14). Install instructions link to Meta's docs rather than auto-installing in MVP (official install channel still releases per-version archives — verify at build time).

## 12. OpenChamber consumption

- Zero OpenChamber changes for chat use: OpenCode consumes npm plugins generically; OpenChamber's UI lists provider models.
- **Phase 5 (optional, separate PRs in openchamber):** integrations-catalog entry (`packages/ui/src/lib/integrations-catalog/registry.ts`) and a quota panel adapter fed from muse `usage/read` (experimental surface — requires the experimental capability probe) or from narrated usage events. Not required for v1.

## 13. Phasing

0. **Foundations (done):** spike #1 (Q1–Q11 verdicts) + seam smoke test (this design's §3 rows).
1. **Bridge MVP:** plugin scaffold, registration + `file://` factory, **correlation-carrier probe (first)**, static fallback catalog + `model/list` refresh, chat-only bridge (session/start, turn/start, stream mapping, cancel mapping), local title/compaction with the fingerprint ledger. Gate: an end-to-end OpenChamber chat turn on a PAYG key.
2. **Approvals + narration:** permission bridge, `userInput/*` bridging, synthetic narration, host pool reaping, muse-session naming, registry persistence + resume across restarts.
3. **Auth UX:** sign-in relay, state cards, subscription/PAYG guidance.
4. **Robustness:** rewind/fork policy, image support decision, steer, usage surface.
5. **OpenChamber polish:** catalog entry, quota panel (optional).

Confirmatory live probes (streaming, cancel, resume, approval round-trip) run at the start of Phase 1 on a PAYG key — they are not blocked on a subscription.

## 14. Risks and open questions

| Risk / question | Assessment | Mitigation |
| --- | --- | --- |
| `aisdk:` seam is invisible in public docs (reverse-engineered) | Real, but the hook API itself (`@opencode/plugin`) is public and versioned | Fallback registration (npm `aisdk:` package + language-hook override); startup fingerprint check of the OpenCode version with a loud log; a tiny CI smoke test against pinned OpenCode |
| Muse CLI version drift (evidence pinned to 1.4.11) | Medium | Fingerprint & gate; read changelog at release time; store required minimum |
| Live behavior of cancel/resume/approvals not yet exercised against real muse | Probe-level corroboration only (SDK journey, Paseo fixtures) | Phase-1 gate on PAYG key |
| Quota multiplier (~13 model calls/agent-turn observed in the Shape B probe) | Matters for usage UX and for cost sanity on meta-requests (which we eliminated) | Measure precisely on PAYG; count muse usage events, not turns |
| Image/multimodal input support in muse turn input | Unknown | MVP rejects with typed error; build-time probe |
| Steer (`turn/steer`) semantics vs OpenCode's queued user messages | Unknown | Build-time probe; MVP: ignore, muse loop owns the iteration |
| `session/fork` semantics (state carried into fork?) | Unknown | Live probe in Phase 1; rehydration fallback designed in §7 |
| In-process correlation carrier (model.request stamp → `doStream` options) unverified — the smoke test's echo model needed no session context | High-impact if absent: kind routing, session mapping, workspaceRoot all depend on it | First Phase-1 probe; fallback: opencode-claude local-proxy shape, where HTTP headers carry it naturally |
| Experimental-surface drift (`account/read`, `usage/read`, `session/promptHint` move or change) | Low–medium (all optional paths) | Capability-flag negotiation; feature-degrade, never fail |
| Import-path stability of `@muse-code/sdk` npm package vs CLI version | Low | Pin dependency + runtime schema/fingerprint handshake already enforced by MSP (schema fingerprint warning on mismatch) |
| ToS re-verification before release | Legal/compliance | Re-check §3.2/§13.4 reading in opencode-muse-auth#12 before public ship |

## 15. Decision log

| Date | Decision | Why |
| --- | --- | --- |
| 2026-10-20 | Shape B (muse-native agent) over Shape A (OpenCode-run tools) | No tool-disable knob in muse 1.4.11 (Q1); muse's system prompt is authoritative |
| 2026-10-20 | Language-model seam via `aisdk.hook("language")`, not provider config `npm` | `model.request` can't suppress OpenCode's own tools (they're forwarded to the model; Q11-turned-trivial) |
| 2026-10-20 | Plugin owns model implementation; needs no OpenCode-side tool suppression | Verified live: bridge ignoring 18 forwarded tools |
| 2026-10-21 | Title + compaction answered locally (no muse calls) | Meta-requests don't benefit muse's context; the ~13× turn multiplier makes muse calls expensive; OpenCode rejects tool calls during compaction anyway |
| 2026-10-21 | Session-authoritative mapping; rewind → `session/fork` (rehydration fallback) | Muse owns conversation context; OpenCode transcript is a projection |
| 2026-10-21 | Never read `~/.config/muse`; state via wire surfaces + CLI help only | Compliance invariant §2 |
| 2026-10-21 | PAYG `META_API_KEY` unblocks all live probes; subscription only for daily use | CLI help verified: key takes priority over login |
| 2026-10-21 | Compaction-aware fingerprint ledger + summary marker; rewind detection excludes anticipated compactions | Otherwise every local compaction reads as rewind and forks the muse session (review C1) |
| 2026-10-21 | Static fallback catalog + placeholder (cursor pattern) | OpenCode removes zero-model providers; §11's auth-UX cards must stay reachable when muse is missing/logged out (review C3) |
| 2026-10-21 | Registry persists to plugin data dir, reconciled at startup | In-memory registry orphans durable muse sessions on every restart (review C4) |
| 2026-10-21 | `userInput/requested` bridged as a permission-style card (Phase 2) | Unhandled, muse questions park the turn with nothing user-visible (review W1) |
| 2026-10-21 | Correlation carrier is the first Phase-1 probe, local-proxy fallback documented | Kind routing, session mapping, and workspaceRoot all hang on it; smoke test didn't exercise it (review C2) |
| 2026-10-21 | Images stripped + narrated warning, not hard turn failure | One accidental screenshot shouldn't kill a request; muse image support unverified (review N11) |
