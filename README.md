# omp-codex-computer

Local OMP extension that exposes OpenAI Codex Computer Use through `codex app-server`.

## Requirements

- macOS
- Codex CLI on `PATH` as `codex`
- Codex.app or ChatGPT.app build with Codex Computer Use enabled/available
- OMP installed
- Accessibility and Screen Recording permissions granted when Codex Computer Use asks
- Bundled `computer-use` Codex plugin available through app-server; this extension cannot operate without it

## Installation

Install the npm package through OMP:

```bash
omp install omp-codex-computer
```

For private pre-release testing from GitHub over SSH:

```bash
omp install git@github.com:mastertyko/omp-codex-computer.git
```

For local development, link the working tree into OMP and keep checks green:

```bash
omp install .
bun install
bun run check
```

Inside OMP:

```text
/codex-computer status
/codex-computer diagnose
```

The extension registers `computer_use_*` tools for native macOS app inspection and interaction through Codex Computer Use, plus a local `computer_use_resolve_app` diagnostic tool that helps identify bad app targets before control actions.

Use `omp-dev -e .` for a local smoke test without installing the package.

## Uninstallation

Uninstall the OMP plugin by package/plugin name:

```bash
omp plugin uninstall omp-codex-computer
```

Use `omp plugin list` to confirm the plugin is no longer installed.

## Commands

- `/codex-computer status` — checks Codex CLI/app-server, the bundled `computer-use` plugin, the current Sky/`node_repl` route, and the legacy direct-MCP fallback.
- `/codex-computer diagnose` — prints the same detailed readiness and route report.
- `/codex-computer enable` — enables the `computer_use_*` tools.
- `/codex-computer disable` — disables the `computer_use_*` tools and shuts down the runtime.
- `/codex-computer restart`
- `/codex-computer hide-status` — hides the `💻 codex: …` footer status for the current extension instance.
- `/codex-computer show-status` — shows the footer status again.

Set `OMP_CODEX_COMPUTER_STATUS=off` before starting OMP to default the footer status to hidden.

## Compatibility routes

The adapter negotiates the transport from capabilities reported by Codex app-server:

- Current Codex: `app-server → node_repl/js → @oai/sky → Sky`.
- Legacy Codex: direct `computer-use` MCP, only when that server advertises all required tools.

Sky is preferred when both routes are available. Fallback is allowed only when Sky bootstrap fails before an action is dispatched; the adapter never falls back after dispatch because that could repeat a click or typed text. Public OMP tool names and approval levels remain unchanged.

## Safety

The extension does not automate the desktop directly. It calls Codex app-server, which owns the bundled plugin lifecycle, `node_repl` runtime, and permission flow. Permission requests fail closed when OMP has no UI available.

Desktop tasks should start with read-only discovery such as `computer_use_list_apps`, `computer_use_resolve_app`, or `computer_use_get_app_state`. Sky app listings expose only the model-relevant `id`, `displayName`, and `isRunning` fields while retaining the full structured response internally for target resolution. If an app-state diff lacks the required context, request a complete accessibility tree with `disableDiff: true`. If `get_app_state` returns `Invalid app`, the adapter enriches the error with target-resolution guidance for cases like unbundled local GUI processes launched as raw executables. Mutating tools are registered with write approval, reject clicks without an element index or complete coordinate pair, are never automatically replayed after a user-stopped Computer Use session, and the bundled `codex-computer` skill tells the model to verify after clicks, typing, scrolling, dragging, and value changes.

## Contributing and security

- See [CONTRIBUTING.md](CONTRIBUTING.md) for the local development workflow and pull request expectations.
- See [SECURITY.md](SECURITY.md) for supported versions and responsible disclosure guidance.

## Verification

Local automated checks:

```bash
bun run check
```

Local OMP smoke:

```bash
omp-dev -e .
/codex-computer diagnose
```

Verified on 2026-07-27 with OMP v17.1.4, Codex CLI 0.145.0, and bundled Computer Use plugin 1.0.1000502:

- `bun run check` passed with 145 tests.
- `npm pack --dry-run` completed successfully.
- `/codex-computer diagnose` reported `ready` through the Sky/`node_repl` route hosted by ChatGPT.app.
- The public OMP `computer_use_list_apps` model path returned 29 apps without exposing app details in the verification output.
- A controlled read-only `get_app_state` smoke returned accessibility text and one in-memory `image/png` block.
