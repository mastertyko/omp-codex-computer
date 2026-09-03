# SOURCE KNOWLEDGE BASE

## OVERVIEW

Flat TypeScript runtime for the OMP extension: native Computer Use and isolated first-party Chrome automation over `codex app-server`. This directory earned local guidance with score 14 (22 code files, dense exports, an `index.ts` boundary, and central runtime symbols).

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Extension lifecycle and slash command | `index.ts` | Package default export; registers tools, skills, session hooks, and `/codex-computer` |
| App-server process and JSON-RPC | `app-server-client.ts`, `protocol.ts` | Spawns `codex app-server --listen stdio://`; owns request IDs and pending calls |
| Native Computer Use orchestration | `runtime.ts`, `computer-use-backend.ts` | Permission handling, queues, retry/reset policy, status |
| Native route negotiation | `computer-use-capabilities.ts`, `computer-use-transport.ts` | Prefers Sky through `node_repl/js`; direct MCP is pre-dispatch fallback only |
| Native public tools | `computer-use-tools.ts` | OMP schemas, approval modes, upstream-name mapping |
| Chrome agent lifecycle | `chrome-runtime.ts` | One agent-owned tab, cleanup, poisoning, restart |
| Chrome contract and dispatch | `chrome-capabilities.ts`, `chrome-transport.ts` | Trust gate plus fixed generated `node_repl` program |
| Chrome public tools | `chrome-tools.ts` | Strict semantic-locator schemas for open/observe/act |
| Chrome trust and readiness | `chrome-trust.ts`, `chrome-trust-probe.ts`, `chrome-status.ts` | Built-in/persisted/session trust and live probe |
| Native status and app targets | `status.ts`, `app-target-resolver.ts` | Route diagnostics and invalid-app guidance |
| Shared serialization/content/logging | `queue.ts`, `thread-manager.ts`, `content.ts`, `log.ts` | Small cross-cutting primitives |

## CONVENTIONS

- Keep the flat layer suffixes meaningful: `*-tools` is public schema/registration, `*-runtime` is lifecycle state, `*-transport` is protocol execution, and `*-capabilities` is discovery/gating.
- `index.ts` is the only package export boundary; internal modules export symbols for composition and tests, not npm subpaths.
- Source is ESM TypeScript shipped directly with `noEmit`; do not introduce a compiled output tree.
- Serialize stateful calls with `SerialQueue`; key ephemeral app-server threads by working directory through `CodexThreadManager`.
- Model route and transport failures with typed errors carrying stable code/phase data where caller behavior depends on the failure.
- Capability parsing is fail-closed. Ambiguous marketplace, plugin, server, tool, artifact, or locator state is unavailable rather than guessed.
- Chrome public inputs are closed finite schemas. Computer Use intentionally passes unknown upstream fields through for protocol compatibility.
- Use `logDebug` with dotted event names. Its recursive redaction is the sole path for runtime diagnostics.
- Mirror behavior changes in the basename-matched `tests/*.test.ts` module; protocol tests assert machine-consumed envelopes and dispatch metadata.

## ANTI-PATTERNS

- NEVER expose raw `node_repl`, JavaScript, CDP, browser/tab handles, existing-tab discovery, selectors, coordinates, credentials, or unrestricted keys through Chrome tools.
- NEVER replay or reroute an action whose dispatch outcome is uncertain; preserve Chrome runtime poisoning after possible side effects.
- Do not fall back from Chrome to native Computer Use, another browser, another tab, or CDP.
- Do not attach to or enumerate user tabs; Chrome owns exactly one new opaque tab per agent run.
- Do not replace Chrome plugin contract validation with a plugin-version pin. App-server versions remain explicitly trusted.
- Do not weaken write approvals, no-UI permission declines, snapshot caps, semantic locator ambiguity checks, or lifecycle cleanup.
- Do not log raw app/page content, screenshots, payloads, headers, tokens, cookies, API keys, session IDs, or credentials.
