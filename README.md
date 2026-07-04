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
omp-dev -e /Volumes/ExtraDisk/Dev/omp-codex-computer
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
