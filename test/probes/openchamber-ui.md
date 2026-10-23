# OpenChamber UI Feasibility Probe

Date: 2026-10-22  
OpenChamber source checkout: `/home/pgquiles/dev/openchamber/openchamber` at `6491f51db`<br>
Probe type: read-only source inspection. No OpenChamber source was changed.

## Findings

| Surface | Source evidence | v1 decision |
| --- | --- | --- |
| Provider catalog / fallback row | OpenChamber's provider page consumes OpenCode provider/model catalogs; a non-empty static plugin catalog can be surfaced in principle. No live OpenChamber runtime was attached, so fallback visibility while Muse is missing/logged out is **not runtime-verified**. | Register static fallback model rows; keep runtime visibility as an acceptance check. |
| Plugin `integration` authentication | OpenCode plugin API supports `command`, `oauth`, `key`, and `env` integration methods. OpenChamber's provider-auth helpers expose OAuth/external sign-in methods and key forms; the inspected provider UI has no command-method flow. | Do not promise an OpenChamber button that launches `muse login`. Use the official CLI's manual `muse login` path; keep auth UX deferred unless runtime testing proves another supported surface. |
| Muse approval choices | OpenChamber's `PermissionCard` offers generic allow-once, allow-always (when save rules exist), and reject actions. It displays OpenCode `action`/`resources`/metadata; it does not render Muse's arbitrary current `choiceId` labels and requirement scopes as a choice list. | Do not collapse Muse choices into generic allow/deny. Defer approval UI and fail closed unless every current Muse choice can be represented faithfully. |
| Structured user input | OpenChamber has generic form-request UI, but no probe established that every MSP `userInput/*` schema can be translated losslessly into OpenCode forms. | Do not fabricate answers; defer unsupported schemas until a complete mapping is verified. |
| Rewind file restoration | The inspected UI can restore reverted message text and attachments to the composer. No evidence showed that Muse `session/fork` restores workspace files. | Conversation rewind is not filesystem rollback. The plugin performs no implicit workspace rollback; explain that Muse file changes remain. |

## Runtime test status

`browser.snapshot` reported that this session has no browser tab and the user is not looking at a tab in this project's session. Therefore no actual OpenChamber provider/auth/permission interactions were exercised. The source evidence above narrows what can be promised; it does not close runtime acceptance for catalog visibility, fallback behavior, or auth presentation.

## Credential and change safety

No Muse credential/config file was opened. No OpenChamber source was modified. No auth action was triggered. See `docs/compatibility.md` for pinned OpenCode/Muse versions and other gates.
