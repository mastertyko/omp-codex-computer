# omp-codex-computer

Local OMP extension that exposes OpenAI Codex Computer Use and a constrained first-party Chrome automation surface through `codex app-server`.

## Requirements

- macOS
- Codex CLI on `PATH` as `codex`
- Codex.app or ChatGPT.app build with Codex Computer Use enabled/available
- OMP installed
- Accessibility and Screen Recording permissions granted when Codex Computer Use asks
- Bundled `computer-use` Codex plugin available through app-server; this extension cannot operate without it
- First-party Chrome support additionally requires Google Chrome, the official ChatGPT Chrome extension connected to the ChatGPT desktop app, bundled Chrome plugin `26.818.31338`, and Codex app-server `0.149.0`. Other tuples fail closed until explicitly validated.

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

It also registers `chrome_open`, `chrome_observe`, and `chrome_act` against OpenAI's bundled first-party Chrome browser client. This is intentionally narrower than Codex `@Chrome`: it owns one new blank tab per OMP agent run and never enumerates, selects, or attaches to the user's existing tabs.

Use `omp-dev -e .` for a local smoke test without installing the package.

## Uninstallation

Uninstall the OMP plugin by package/plugin name:

```bash
omp plugin uninstall omp-codex-computer
```

Use `omp plugin list` to confirm the plugin is no longer installed.

## Commands

- `/codex-computer status` — checks both native Computer Use routing and static Chrome transport compatibility. Chrome extension connectivity is checked only when `chrome_open` runs.
- `/codex-computer diagnose` — prints the same detailed readiness and compatibility report.
- `/codex-computer enable` — enables both `computer_use_*` and `chrome_*` tools.
- `/codex-computer disable` — disables both tool families and shuts down both runtimes.
- `/codex-computer restart` — stops both dedicated app-server children; they reconnect on the next tool call.
- `/codex-computer hide-status` — hides the `💻 codex: …` footer status for the current extension instance.
- `/codex-computer show-status` — shows the footer status again.

Set `OMP_CODEX_COMPUTER_STATUS=off` before starting OMP to default the footer status to hidden.

## Compatibility routes

### Native Computer Use

The adapter negotiates the native-app transport from capabilities reported by Codex app-server:

- Current Codex: `app-server → node_repl/js → @oai/sky → Sky`.
- Legacy Codex: direct `computer-use` MCP, only when that server advertises all required tools.

Sky is preferred when both routes are available. Fallback is allowed only when Sky bootstrap fails before an action is dispatched; the adapter never falls back after dispatch because that could repeat a click or typed text.

### Chrome

Chrome uses a separate path: `app-server → node_repl/js → bundled Chrome browser client → first-party browser service → official Chrome extension`. The adapter accepts only the explicitly validated Chrome plugin/app-server tuple, a canonical local plugin directory, the matching manifest, and an unambiguous `node_repl/js` tool. It never aliases Chrome to generic Computer Use, CDP, or another browser.

`chrome_open` creates the one agent-owned tab and can optionally load an initial http(s) URL in the same call. `chrome_observe` returns a capped semantic page snapshot and accepts a 1-indexed line offset for paging past the cap. `chrome_act` supports HTTPS/HTTP navigation, back/forward/reload, semantic-locator click/fill/keypress/select/check actions, and close. Agent-end cleanup closes any remaining tab before stopping the dedicated app-server child.

## Safety

The extension does not automate the desktop or browser directly. It calls Codex app-server, which owns bundled plugin lifecycles, `node_repl`, native permissions, and the first-party browser connection. Native Computer Use permission requests fail closed when OMP has no UI. Chrome elicitation requests are always declined rather than reflecting page-derived text into a trusted prompt.

Desktop tasks should start with read-only discovery such as `computer_use_list_apps`, `computer_use_resolve_app`, or `computer_use_get_app_state`. Sky app listings expose only the model-relevant `id`, `displayName`, and `isRunning` fields while retaining the full structured response internally for target resolution. If an app-state diff lacks the required context, request a complete accessibility tree with `disableDiff: true`. If `get_app_state` returns `Invalid app`, the adapter enriches the error with target-resolution guidance for cases like unbundled local GUI processes launched as raw executables. Mutating tools are registered with write approval, reject clicks without an element index or complete coordinate pair, and are never automatically replayed after a user-stopped Computer Use session.

Chrome remains isolated to one opaque tab for one agent run. Page snapshots are untrusted content and capped at 50 KiB/3,000 lines per window. The public schema exposes no arbitrary JavaScript, CDP, CSS selectors, coordinates, browser/tab IDs, existing-tab discovery, file URLs, credential-bearing URLs, uploads, downloads, or unrestricted key chords. `chrome_open` and `chrome_act` require write approval; `chrome_observe` is read-only. Locator actions require an unambiguous target before acting — exactly one match, or exactly one visible match among a few duplicates; a miss or a still-ambiguous locator fails without side effects and without ending the Chrome run. Only failures with an uncertain outcome after an action was dispatched — timeouts mid-action, lost or invalid responses, interrupts — poison the Chrome runtime for the rest of that agent run, so a possible side effect is never retried or routed elsewhere.

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

Verified on 2026-08-22 with OMP v17.3.4, Codex CLI/app-server 0.149.0, bundled Chrome plugin 26.818.31338, and bundled Computer Use plugin 1.0.1000816:

- `bun run check` passed with 198 tests across 17 files.
- `npm pack --dry-run` completed successfully.
- The Chrome compatibility probe reported `ready` for the exact trusted plugin/app-server tuple; it did not bootstrap the browser.
- A live `ChromeRuntime` opened a blank extension-backed tab, returned an empty snapshot, navigated to `https://example.com/`, clicked `Learn more` with a semantic text locator, returned the IANA snapshot, closed the tab, and completed cleanup.
- An end-to-end `omp-dev -e .` agent run loaded the extension's real OMP-compatible schemas, used only `chrome_open`/`chrome_act`, reported the `Example Domain` heading, and closed the tab.

Re-verified on 2026-08-23 for the extended Chrome surface, same stack:

- `bun run check` passed with 209 tests across 17 files.
- A live `ChromeRuntime` opened `https://www.selenium.dev/selenium/web/web-form.html` directly through `chrome_open` with a URL, then exercised select-by-label, checkbox setChecked, fill with multibyte text, navigate, back, forward, reload, offset-paged observe, and close — three consecutive full runs green.
- A missing locator returned `element_not_found` and a two-match locator returned `ambiguous_locator`; both were side-effect free and the same Chrome run continued and completed cleanup afterwards.
- A raw bridge probe confirmed strict-mode Playwright semantics upstream and working `nth()`/`isVisible()` primitives for the visible-aware locator resolver.
- An end-to-end `omp-dev -e . -p` agent run enabled the tools with `/codex-computer enable`, loaded the extended schemas through OMP's real Zod surface, opened `https://example.com/` via `chrome_open` with its `url` parameter, reported the `Example Domain` heading, and closed the tab.
