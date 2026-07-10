# omp-codex-computer

Local OMP extension that exposes OpenAI Codex Computer Use through `codex app-server`.

## Requirements

- macOS
- Codex CLI on `PATH` as `codex`
- ChatGPT desktop app with Codex Computer Use enabled/available
- OMP installed
- Accessibility and Screen Recording permissions granted when Codex Computer Use asks
- `computer-use` MCP server exposed by `codex app-server`

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

- `/codex-computer status` — checks the Codex CLI, app-server, required MCP tools, and reports additional upstream MCP tools not exposed by this adapter.
- `/codex-computer diagnose` — prints the same detailed readiness/update report.
- `/codex-computer enable` — enables the `computer_use_*` tools.
- `/codex-computer disable` — disables the `computer_use_*` tools and shuts down the runtime.
- `/codex-computer restart`
- `/codex-computer hide-status` — hides the `💻 codex: …` footer status for the current extension instance.
- `/codex-computer show-status` — shows the footer status again.

Set `OMP_CODEX_COMPUTER_STATUS=off` before starting OMP to default the footer status to hidden.

## Safety

The extension does not automate the desktop directly. It calls Codex app-server, which owns the Computer Use server lifecycle and permission flow. Permission requests fail closed when OMP has no UI available.

Desktop tasks should start with read-only discovery such as `computer_use_list_apps`, `computer_use_resolve_app`, or `computer_use_get_app_state`. If `get_app_state` returns `Invalid app`, the adapter enriches the error with target-resolution guidance for cases like unbundled local GUI processes launched as raw executables. Mutating tools are registered with write approval, and the bundled `codex-computer` skill tells the model to verify after clicks, typing, scrolling, dragging, and value changes.

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

Verified on 2026-07-10 with OMP v16.3.14 and Codex CLI 0.144.1:

- `bun run check` passed with 95 tests.
- The thread-scoped readiness check reported all 10 required Computer Use MCP tools.
- A direct adapter smoke listed available apps and read the ChatGPT app state.
