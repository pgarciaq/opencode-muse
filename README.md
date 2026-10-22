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

The approved v1.3 design is implemented (tests: fake-MSP suite green; install
gates below). The provider bridge, durable session mapping, and local
title/compaction paths are implemented and the OpenCode 2.1.3 runtime gates
now pass: provider listing (`PROVIDER_LIST_OK`, three `muse/` rows), the
request-correlation probe (`CORRELATION_OK`), and a live subscription-backed
bridge turn through `muse serve`. The same provider-list, correlation, and live
no-variant turn probes also pass with OpenChamber's embedded OpenCode 2.0.32
binary (direct embedded-CLI verification; full OpenChamber UI acceptance is
still pending). Earlier OpenCode 2.1.2 CLI hangs in empty projects did not
reproduce on 2.1.3; see the
[v1 tracking issue](https://github.com/pgarciaq/opencode-muse/issues/2).
Rewind/fork is deliberately unsupported until Muse fixes the Linux birth-time
failure (tracked in [#20](https://github.com/pgarciaq/opencode-muse/issues/20)).

This package is not yet published. Until then, load it through an OpenCode
plugin directory (verified on OpenCode 2.1.3):

```sh
mkdir -p .opencode/plugins
cat > .opencode/plugins/opencode-muse.js <<'EOF'
export { default } from "file:///path/to/opencode-muse/dist/index.js";
EOF
```

For all projects, put the same shim file in `~/.config/opencode/plugins/`
instead. Note that OpenCode 2.1.3 did not load plugin entries from the
`plugin`/`plugins` config arrays (npm specifier or `file:`) in the tested CLI
paths, so `opencode plugin add` is not yet expected to work for local
plugins. After publication this section will be updated.

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
- Identifiable custom OpenCode agent instructions are forwarded as a labeled
  preamble; unknown custom-agent layouts fail closed. Other OpenCode system
  boilerplate and tool catalogs are not sent to Muse; Muse uses its own
  workspace rules.

## Credits and references

- [opencode-claude](https://github.com/openchamber/opencode-claude) — a
  reference for OpenCode v2 plugin setup, model/session hooks, bridge
  lifecycle, and the local-proxy fallback. This plugin uses Muse-native tools;
  auth and inference stay in the Muse CLI.
- [muse-code-sdk](https://github.com/meta-models/muse-code-sdk) — official
  Muse Code SDK and the Muse Session Protocol this project will use.
- [Paseo's Muse Code integration](https://paseo.sh/docs/muse-code) — a
  protocol-level reference implementation.
