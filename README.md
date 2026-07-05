# omp-codex-computer

Local OMP extension that exposes OpenAI Codex Computer Use through `codex app-server`.

## Requirements

- macOS
- Codex CLI on `PATH` as `codex`
- Codex.app installed
- OMP installed
- Accessibility and Screen Recording permissions granted when Codex Computer Use asks

## Local Development

```bash
bun install
bun run check
omp-dev -e .
```

Inside OMP:

```text
/codex-computer status
```

## Commands

- `/codex-computer status`
- `/codex-computer diagnose`
- `/codex-computer enable`
- `/codex-computer disable`
- `/codex-computer restart`

## Safety

The extension does not automate the desktop directly. It calls Codex app-server, which owns the bundled Computer Use plugin lifecycle and permission flow. Permission requests fail closed when OMP has no UI available.

## Verification

Local automated checks:

```bash
bun run check
```

Local OMP smoke:

```bash
omp-dev -e .
/codex-computer status
```

Verified on 2026-07-05 with OMP v16.3.6 and Codex CLI 0.142.5:

- `bun run check` passed with 76 tests.
- `/codex-computer status` reported Codex Computer Use ready.
- A safe `computer_use_list_apps` model path listed available apps.
