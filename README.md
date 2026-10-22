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

The approved v1.3 design is now recorded as working v1.4 with pinned-runtime
findings. The provider bridge, fake-MSP tests, durable session mapping, and
local title/compaction paths are implemented. The pinned OpenCode 2.1.2 CLI
smoke remains blocked because its provider-list command hangs even in an empty
project; see the [v1 tracking issue](https://github.com/pgarciaq/opencode-muse/issues/2).
Rewind/fork is deliberately unsupported until Muse fixes the Linux birth-time
failure (tracked in [#20](https://github.com/pgarciaq/opencode-muse/issues/20)).

This package is not yet published. Once published, install it with:

```sh
opencode plugin add opencode-muse
```

## Authentication

Sign in through the official Muse Code CLI before using the provider:

```sh
muse login
```

OpenChamber's current provider UI does not expose OpenCode plugin `command`
authentication methods, so this plugin does not promise a sign-in button. It
uses the Muse CLI's existing account/configuration through `muse serve`; it
never reads Muse credential files, exports tokens, or changes subscription
mode. If the CLI has no usable model catalog, the provider remains a disabled
setup placeholder rather than advertising a model that will fail on use.

## V1 limitations

- Muse approvals and structured `userInput/*` prompts are unavailable through
  the current OpenChamber UI; unsupported server requests fail closed. Muse
  tools do not become OpenCode tool calls.
- Direct MSP input supports text/images and verified video uploads. Audio, PDF,
  and strict JSON constraints have no verified direct-MSP representation.
- OpenCode transcript rewind/fork is unsupported on Muse 1.4.11/Linux until the
  explicit fork probe passes ([#20](https://github.com/pgarciaq/opencode-muse/issues/20)).
  The bridge does not roll back workspace files.
- The bridge serializes writers per local workspace and may report a busy
  session while another Muse turn is still completing in the background.

## Credits and references

- [opencode-claude](https://github.com/openchamber/opencode-claude) — a
  reference for OpenCode v2 plugin setup, model/session hooks, bridge
  lifecycle, and the local-proxy fallback. This plugin uses Muse-native tools;
  auth and inference stay in the Muse CLI.
- [muse-code-sdk](https://github.com/meta-models/muse-code-sdk) — official
  Muse Code SDK and the Muse Session Protocol this project will use.
- [Paseo's Muse Code integration](https://paseo.sh/docs/muse-code) — a
  protocol-level reference implementation.
