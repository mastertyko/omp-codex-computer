# omp-codex-computer

Local OMP extension that exposes OpenAI Codex Computer Use and Codex Chrome through `codex app-server`.

## Requirements

- macOS
- Codex CLI on `PATH` as `codex`
- Codex.app installed
- OMP installed
- Accessibility and Screen Recording permissions granted when Codex Computer Use asks
- Bundled `computer-use` and `chrome` Codex plugins available in Codex.app

## Local Development

```bash
bun install
bun run check
omp-dev -e .
```

Inside OMP:

```text
/codex-computer status
/codex-computer diagnose
```

The extension registers two tool families:

- `computer_use_*` tools for native macOS app interaction through Codex Computer Use.
- `codex_chrome_*` tools for Chrome browser discovery, tab inspection, navigation, DOM/coordinate interaction, screenshots, exports, logs, waits, and clipboard access through the bundled Codex Chrome plugin.

## Commands

- `/codex-computer status`
- `/codex-computer diagnose`
- `/codex-computer enable`
- `/codex-computer disable`
- `/codex-computer restart`

## Safety

The extension does not automate the desktop or Chrome directly. It calls Codex app-server, which owns the bundled plugin lifecycles and permission flow. Permission requests fail closed when OMP has no UI available.

Chrome tasks should start with read-only discovery such as `codex_chrome_list_browsers`, `codex_chrome_open_tabs`, or `codex_chrome_get_tab_state`. Mutating Chrome tools are registered with write approval, and the bundled `codex-chrome` skill tells the model to verify after navigation, clicks, typing, scrolling, dragging, and clipboard writes.

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

- `bun run check` passed with 87 tests.
- `/codex-computer diagnose` reported Codex Computer Use ready and Chrome bridge files available.
- A safe `computer_use_list_apps` model path listed available apps.
- A safe `codex_chrome_list_browsers` model path completed through OMP and returned `[]`; no tabs were opened or modified. This confirms the tool path is wired, while this OMP-dev session did not expose a live Chrome backend.
