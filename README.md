# omp-codex-computer

Local OMP extension that exposes OpenAI Codex Computer Use through `codex app-server`.

## Requirements

- macOS
- Codex CLI on `PATH` as `codex`
- Codex.app installed with Codex Computer Use enabled/available
- OMP installed
- Accessibility and Screen Recording permissions granted when Codex Computer Use asks
- Bundled `computer-use` Codex plugin available in Codex.app; this extension cannot operate without it

## Use from source

Until a packaged release exists, use the extension from this repository:

```bash
git clone git@github.com:mastertyko/omp-codex-computer.git
cd omp-codex-computer
bun install
bun run check
omp-dev -e .
```

Inside OMP:

```text
/codex-computer status
/codex-computer diagnose
```

The extension registers `computer_use_*` tools for native macOS app inspection and interaction through Codex Computer Use.

For local development, keep `bun run check` green before opening a pull request. Use `bun run test:watch` while iterating.

## Commands

- `/codex-computer status` — checks Codex CLI/app, the bundled `computer-use` plugin, required MCP tools, and reports additional upstream MCP tools not exposed by this adapter.
- `/codex-computer diagnose` — prints the same detailed readiness/update report.
- `/codex-computer enable` — enables the `computer_use_*` tools.
- `/codex-computer disable` — disables the `computer_use_*` tools and shuts down the runtime.
- `/codex-computer restart`
- `/codex-computer hide-status` — hides the `Codex 💻: …` footer status for the current extension instance.
- `/codex-computer show-status` — shows the footer status again.

Set `OMP_CODEX_COMPUTER_STATUS=off` before starting OMP to default the footer status to hidden.

## Safety

The extension does not automate the desktop directly. It calls Codex app-server, which owns the bundled plugin lifecycle and permission flow. Permission requests fail closed when OMP has no UI available.

Desktop tasks should start with read-only discovery such as `computer_use_list_apps` or `computer_use_get_app_state`. Mutating tools are registered with write approval, and the bundled `codex-computer` skill tells the model to verify after clicks, typing, scrolling, dragging, and value changes.

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

Verified on 2026-07-05 with OMP v16.3.6 and Codex CLI 0.142.5:

- `bun run check` passed with 80 tests.
- `/codex-computer diagnose` reported Codex Computer Use ready.
- A safe `computer_use_list_apps` model path listed available apps.
