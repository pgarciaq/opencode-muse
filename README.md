# opencode-muse

An [OpenCode](https://opencode.ai) plugin that lets OpenCode (and therefore
[OpenChamber](https://openchamber.dev/)) use a Muse Code subscription with
auth and inference staying entirely inside the official Muse Code CLI
(`muse serve`, via `@muse-code/sdk`).

No subscription credential is ever extracted, cached, or injected into
OpenCode — unlike
[opencode-muse-auth](https://github.com/TheStreamCode/opencode-muse-auth), the
credential-extraction approach under review in that repo's
[issue #12](https://github.com/TheStreamCode/opencode-muse-auth/issues/12).

## Status

Design v1.3 was the approved baseline; the working v1.4 design incorporates
runtime findings. Core implementation is underway. Rewind/fork is deferred
until Muse fixes the Linux birth-time failure (tracked in
[issue #20](https://github.com/pgarciaq/opencode-muse/issues/20)); see the
[v1 tracking issue](https://github.com/pgarciaq/opencode-muse/issues/2) for
remaining lifecycle and OpenChamber UI gates.

## Credits and references

- [opencode-claude](https://github.com/openchamber/opencode-claude) — a
  reference for OpenCode v2 plugin setup, model/session hooks, bridge
  lifecycle, and the local-proxy fallback. This plugin uses Muse-native tools;
  auth and inference stay in the Muse CLI.
- [muse-code-sdk](https://github.com/meta-models/muse-code-sdk) — official
  Muse Code SDK and the Muse Session Protocol this project will use.
- [Paseo's Muse Code integration](https://paseo.sh/docs/muse-code) — a
  protocol-level reference implementation.
