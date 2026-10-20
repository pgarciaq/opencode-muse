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

Currently in the spike phase — see
[the spike issue](https://github.com/pgarciaq/opencode-muse/issues) for the
list of questions this project must answer before any real build starts.

## Credits and references

- [opencode-claude](https://github.com/openchamber/opencode-claude) — the
  architectural pattern this project follows (a local OpenAI-compatible
  provider that drives the official CLI/SDK; tools execute in OpenCode;
  auth never leaves the CLI).
- [muse-code-sdk](https://github.com/meta-models/muse-code-sdk) — official
  Muse Code SDK and the Muse Session Protocol this project will use.
- [Paseo's Muse Code integration](https://paseo.sh/docs/muse-code) — a
  protocol-level reference implementation.
