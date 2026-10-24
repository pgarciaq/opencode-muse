# Muse CLI Development Handover

**Snapshot:** 2026-10-24

**Purpose:** Give a fresh Muse CLI session a reliable starting point. This is a dated status summary, not a replacement for the design, plan, repository rules, compatibility record, or issues linked below. Re-check live repository and issue state before acting.

## Read first

1. [`AGENTS.md`](../AGENTS.md) — mandatory security, protocol, planning, and verification rules.
2. [`docs/design.md`](design.md) — product architecture and behavioral requirements.
3. [`docs/plans/2026-10-21-opencode-muse.md`](plans/2026-10-21-opencode-muse.md) and [`docs/plans/2026-10-21-opencode-muse-tdd.md`](plans/2026-10-21-opencode-muse-tdd.md) — implementation history and gates.
4. [`docs/compatibility.md`](compatibility.md) — pinned versions, probes, limitations, and release checks.
5. [`docs/releasing.md`](releasing.md) — the GitHub Release → npm Trusted Publishing workflow.
6. The linked GitHub issue for the task. Issue status can change after this snapshot.

For OpenCode v2 plugin API questions, use the [official v2 plugin guide](https://opencode.ai/v2/docs/build/plugins); do not rely on v1 docs.

## Current state

- The handover snapshot was taken from clean `main` at `7650f56` (`docs: record verified 0.1.2 npm publication`); this document is the subsequent handoff change.
- **`opencode-muse@0.1.2` is published and `latest`.** Release: [`v0.1.2`](https://github.com/pgquiles/opencode-muse/releases/tag/v0.1.2). The OIDC workflow passed build, tests, and package checks; provenance was signed. The published tarball was installed and its plugin entry imported successfully.
- **#25 is closed.** Root cause: distinct `session/statusChanged` and `turn/completed` notifications can share an opaque `viewCursor`. Cursor-only deduplication dropped the terminal event, leaving turn markers and workspace locks behind. The fix identifies exact notification replays by cursor plus a canonical method/params fingerprint; gap recovery and usage deduplication use the same identity.
- **#26 remains open, but its root cause is documented.** The failed “Muse Spark 1.3 Contributor” selection stored the retired OpenCode-gateway ID `opencode/muse-spark-1.3-contributor-free`; that request never reached this plugin. The working plugin model is under provider **Muse Code**: `muse/muse-profile-tbh-model-muse-spark-1.3`. The user intends to report the stale upstream model listing.
- Meta’s Model API Terms were rechecked on 2026-10-24; the terms page still says October 9, 2026. No PAYG test was performed. The owner has Everyday subscription access only; PAYG remains a separate, gated path.

## Runtime pins: keep the two OpenCodes separate

- OpenChamber 2.5.1 bundles **OpenCode 2.1.3**. Its embedded server is a distinct process and may have active sessions; do not restart it without the user’s approval.
- Standalone OpenCode is **2.1.4**. Do not use its behavior as proof about the bundled server, or vice versa.
- Current plugin dependency: `@muse-code/sdk` **1.4.12**; verified Muse CLI: **1.4.12**. Package/API pins are recorded in `package.json` and `docs/compatibility.md`.

## Open issues and likely next work

- [#24 — plan and validate 0.2.0](https://github.com/pgquiles/opencode-muse/issues/24) is the next release-planning task. Keep PAYG out of scope unless the owner separately enables and authorizes it.
- [#21 — MSP compatibility policy](https://github.com/pgquiles/opencode-muse/issues/21), [#23 — view-gap recovery probe](https://github.com/pgquiles/opencode-muse/issues/23), [#22 — approval/user-input UX](https://github.com/pgquiles/opencode-muse/issues/22), and [#20 — rewind/fork](https://github.com/pgquiles/opencode-muse/issues/20) remain follow-ups. Rewind/fork stays blocked until the pinned runtime supports the required explicit cut point.
- Re-check issue states before choosing work. Do not infer that an open issue authorizes a release or a PAYG/live probe.

## Development guardrails

- Meta communication must go only through the official Muse CLI and `@muse-code/sdk` using `muse serve` over stdio. Never call Meta endpoints directly for plugin inference.
- Never open, parse, copy, cache, log, or transmit `~/.config/muse` or any Muse credential. Do not inspect credentials to infer authentication state.
- Preserve MSP `commandId` idempotency, session/view cursors, workspace locks, and explicit fork cut points. Never silently drop supported user inputs or fabricate approval/user-input answers.
- Keep the repository plugin-only; do not modify OpenChamber source.
- Read the design and current plan before behavior changes. Get plan approval and honor compatibility probe hard gates. Use TDD with fake MSP hosts by default.
- Before release: re-check terms, update supported-version/probe notes, run the release checks, and obtain explicit owner authorization. Publish only by creating a matching stable GitHub Release tag so the pinned OIDC workflow runs; do not publish directly from a local machine.

## Useful checks

```sh
npm ci
npm run build
npm test
npm pack --dry-run
```

At handover time the suite had **164 passing tests**, the TypeScript build passed, and the production dependency audit reported zero vulnerabilities. Re-run checks on the current checkout rather than relying on this snapshot.
