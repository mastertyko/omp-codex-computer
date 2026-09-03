# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-03T05:36:19Z
**Commit:** 1415943
**Branch:** main

## OVERVIEW

OMP extension that exposes native macOS Computer Use and a constrained first-party Chrome surface through `codex app-server`. ESM TypeScript is shipped directly; Bun, strict `tsc`, and Vitest provide the development toolchain.

## STRUCTURE

```text
omp-codex-computer/
├── src/                 # Flat extension runtime; see src/AGENTS.md
├── tests/               # Basename-mirrored Vitest behavior and protocol tests
├── skills/              # Packaged OMP usage guidance discovered at runtime
├── docs/                # Chrome integration contract and feasibility record
├── .github/workflows/   # CI, auto-merge, release, and npm publishing
├── package.json         # Direct TypeScript package/OMP entry and scripts
└── tsconfig.json        # Strict, no-emit compilation of src and tests
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Package and OMP entry | `package.json`, `src/index.ts` | Export `"."`, extension registration, hooks, `/codex-computer` |
| Native Computer Use behavior | `src/runtime.ts`, `src/computer-use-backend.ts` | Lifecycle, permissions, queueing, retry/reset |
| Native Sky/direct routing | `src/computer-use-transport.ts`, `src/computer-use-capabilities.ts` | Capability-driven pre-dispatch selection |
| Chrome automation | `src/chrome-runtime.ts`, `src/chrome-transport.ts` | Agent isolation, fixed program, poisoning, cleanup |
| Chrome trust gate | `src/chrome-capabilities.ts`, `src/chrome-trust.ts` | App-server allowlist and plugin artifact/contract checks |
| App-server protocol | `src/app-server-client.ts`, `src/protocol.ts`, `src/thread-manager.ts` | Stdio JSON-RPC and ephemeral threads |
| Public tool schemas | `src/computer-use-tools.ts`, `src/chrome-tools.ts` | Names, inputs, approvals, result shaping |
| Readiness diagnostics | `src/status.ts`, `src/chrome-status.ts`, `src/chrome-trust-probe.ts` | Status/diagnose/trust command paths |
| Test behavior | `tests/<source>.test.ts` | Mirrors source concerns; transport/status suites are hotspots |
| User-facing constraints | `README.md`, `skills/`, `CONTRIBUTING.md` | Commands, safety, smoke workflow |
| Release behavior | `.github/workflows/release.yml` | Automated patch version, provenance, release notes |

## CODE MAP

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `ompCodexComputer` | function | `src/index.ts:17` | 10 | Main extension composition boundary |
| `ComputerUseRuntime` | class | `src/runtime.ts:26` | 28 | Native session lifecycle and permissions |
| `ChromeRuntime` | class | `src/chrome-runtime.ts:57` | 18 | Per-agent Chrome lifecycle and isolation |
| `AppServerClient` | class | `src/app-server-client.ts:42` | 13 files | Child process and JSON-RPC multiplexing |
| `ComputerUseBackend` | class | `src/computer-use-backend.ts:50` | 19 | Native execution, retry, content adaptation |
| `ComputerUseTransport` | class | `src/computer-use-transport.ts:112` | 25 | Sky/direct MCP dispatch |
| `ChromeTransport` | class | `src/chrome-transport.ts:209` | 9 | Contract-gated Chrome program execution |
| `CodexThreadManager` | class | `src/thread-manager.ts:8` | 24 | Per-cwd ephemeral thread cache |

## CONVENTIONS

- Production and test code stay in flat `src/` and `tests/` directories with kebab-case filenames.
- Tests usually mirror source basenames and exercise observable protocol/lifecycle behavior with Vitest fakes at process or transport boundaries.
- The npm package exports `src/index.ts` directly. `tsconfig.json` is strict and `noEmit`; there is no build artifact directory.
- Tool names are public snake_case; TypeScript symbols use PascalCase/camelCase and constants use UPPER_SNAKE_CASE.
- `skills/` ships in the npm package and is surfaced through OMP `resources_discover`; keep it synchronized with public behavior.
- CI pins Bun 1.3.14, installs with `--frozen-lockfile`, and runs `bun run check`.
- No formatter or linter is configured. Match nearby formatting and let `tsc` plus Vitest define the automated gate.
- Releases compute patch versions after merge. Feature branches leave the package version unchanged.

## ANTI-PATTERNS (THIS PROJECT)

- Do not add abstractions without a demonstrated second use; this repository explicitly prefers direct, well-tested changes.
- Do not turn unavailable, ambiguous, malformed, or permissionless automation state into a permissive path.
- Never log or commit app/page content, screenshots, credentials, headers, tokens, cookies, keys, `.env` files, or app-server logs.
- Never replay or redirect a possibly dispatched side effect; an uncertain outcome must remain failed/poisoned.
- Do not manually bump `package.json` for normal feature work; the release workflow owns patch bumps.
- Do not change user-visible commands, requirements, or safety behavior without updating README or packaged skill guidance.

## UNIQUE STYLES

- Native Computer Use and Chrome are separate tool families with separate runtimes and transport contracts.
- Native routing prefers the bundled Sky path and permits direct MCP only when selection fails before dispatch.
- Chrome never drives the browser directly: it sends a fixed, encoded program through trusted `node_repl/js`.
- Chrome plugin compatibility is contract-validated; app-server compatibility is an explicit built-in, persisted, or session trust decision.
- Runtime diagnostics are opt-in and flow through a recursive redaction layer.

## COMMANDS

```bash
bun install
bun run check          # strict typecheck, then Vitest
bun run test           # one Vitest run
bun run test:watch
bun run typecheck
npm pack --dry-run
omp -e .               # local OMP smoke; requires macOS/Codex/desktop stack
```

## NOTES

- Live Computer Use and Chrome smoke testing requires macOS, Codex CLI/app-server, OMP, desktop permissions, and the relevant bundled/desktop plugins.
- `/codex-computer status` checks static readiness; operational Chrome connectivity is exercised by `chrome_open`.
- `src/chrome-transport.ts` and `src/computer-use-transport.ts` are the largest implementation hotspots; their matching tests carry most protocol coverage.
- `agent_end` with `willContinue: true` is non-terminal, so lifecycle changes must preserve runtimes across automatic continuations.
