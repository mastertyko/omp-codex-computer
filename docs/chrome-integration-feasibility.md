# First-party Chrome in `omp-codex-computer`

## Decision

> **A constrained first-party Chrome surface is implemented and live-verified. It is intentionally narrower than full Codex `@Chrome`.**

`omp-codex-computer` now uses OpenAI's bundled Chrome client through Codex app-server and `node_repl/js`. Chrome is a separate control surface; it is never an alias for or a fallback to general macOS Computer Use.

The public surface owns one new blank tab per OMP agent run. It does not list, select, or take over the user's existing tabs. Features that require browser elicitation, browser auth, or full `@Chrome` parity remain unavailable and fail closed.

## Implemented surface

| Tool | Approval | Contract |
|---|---|---|
| `chrome_open` | write | Opens exactly one new agent-owned blank Chrome tab. A second open in the same run is rejected. |
| `chrome_observe` | read | Returns a semantic DOM snapshot, truncated to 50 KiB and 3,000 lines. |
| `chrome_act` | write | Allows only HTTP(S) navigation, semantic click/fill/keypress, and close. Returns a snapshot after a successful action. |

Allowed locators are role/name, text, label, placeholder, and test id. Allowed keys are a fixed navigation/form list. The public schemas do not expose raw JavaScript, CDP, CSS selectors, coordinates, browser/tab ids, tab lists, history, file URLs, credential-bearing URLs, uploads, downloads, or unrestricted key chords.

## Architecture

```text
OMP agent_start
    │
    ▼
ChromeRuntime ── dedicated AppServerClient and CodexThreadManager
    │
    ▼
ChromeTransport
    ├── plugin/list + mcpServerStatus/list
    ├── exact version/artifact gate
    ├── fixed generated JS + base64-encoded typed payload
    └── x-codex-turn-metadata with opaque UUIDs
            │
            ▼
node_repl/js → bundled browser-client.mjs
            → first-party browser service
            → official Chrome extension
```

The Chrome runtime is deliberately separate from `ComputerUseRuntime`. This prevents a browser disconnect, unsafe abort, or lifecycle reset from affecting the native app tools. It creates a dedicated app-server child only on the first Chrome call and stops it on `agent_end`, `session_shutdown`, disable, or restart.

`agent_end` first sends an explicit cleanup operation with the same opaque session/turn identity. Cleanup removes the session, closes any remaining tab, and then stops the child process. A failed or aborted dispatch poisons the Chrome runtime for the rest of the agent run; the action is never replayed and never routed to Computer Use, CDP, or another browser.

## Capability and version gate

The currently validated combination is:

- Codex app-server `0.149.0`.
- Bundled `chrome@openai-bundled` `26.818.31338`.
- Exactly one installed, enabled, and `AVAILABLE` Chrome plugin from the `openai-bundled` marketplace.
- An absolute local plugin root that is a real directory, not a symlink.
- A matching `.codex-plugin/plugin.json` and a real `scripts/browser-client.mjs` inside the canonical root.
- Exactly one `node_repl` server advertising the tool `js` under that exact name.

An unknown version, ambiguous marketplace/plugin/server, non-local source, missing file, manifest mismatch, or symlink escape yields `Chrome unavailable`. No alternative transport is attempted.

`/codex-computer status` only verifies this static contract. It does not bootstrap the browser service and therefore cannot prove that the Chrome extension is connected. The operational connection is first verified by `chrome_open`.

## Security decisions

1. **Browser elicitation is always denied.** OMP does not display page-derived elicitation text in a trusted dialog and accepts no schema. Flows that require site approval, browser auth, or first-party confirmation therefore do not work. This is a deliberate fail-closed restriction, not a fallback.
2. **OMP approval sits at the public tool boundary.** Open and all actions are write; observe is read. The bundled skill requires separate user confirmation immediately before messaging, form submission, purchases, account/security changes, or sensitive transfers.
3. **No model-exposed `node_repl`.** The model only selects typed operations. The transport generates the program itself, imports only the discovered canonical client file, and re-validates the payload inside the repl process.
4. **Strict response envelope.** Only a versioned text envelope is accepted. Results are validated against exact keys; raw metadata, internal errors, browser/tab objects, and discovered paths are not returned.
5. **No replay.** An abort, timeout, lost response, invalid envelope, or snapshot failure after an action invalidates the entire Chrome run.
6. **Page content is untrusted.** The snapshot may contain page text and link URLs and must be treated as data, never instructions. It is truncated before the model result and is not logged by the Chrome modules.

## Live verification 2026-08-22

The following was observed locally against the installed first-party stack:

1. The status probe identified exactly plugin `26.818.31338`, app-server `0.149.0`, a trusted local client, and `node_repl/js` as compatible.
2. A real `ChromeRuntime` started the app-server, selected exactly `agent.browsers.get("chrome")`, and opened a blank tab.
3. `chrome_observe` on the blank tab returned an empty, valid snapshot without browser/tab ids.
4. Navigation to `https://example.com/` returned the semantic heading `Example Domain`.
5. A text-locator click on `Learn more` navigated to IANA and returned the new semantic snapshot.
6. Close and the subsequent agent cleanup succeeded; no test tab was left open.

This proves real browser RPC, Chrome extension connectivity, navigation, locator clicks, snapshots, and explicit cleanup for the constrained surface. It does not prove full `@Chrome` parity or flows that require elicitation.

## Remaining limitations

- No listing or takeover of existing tabs.
- No history, screenshots, upload/download, browser auth, or connector APIs.
- No approval broker for first-party browser elicitations; such flows are denied.
- Only the strictly validated version combination is supported. Every Codex/plugin update requires a new contract review and live probe before the allowlist is expanded.
- Status is a compatibility check, not a connectivity check.

## Sources

- OpenAI, [Use your computer with ChatGPT](https://learn.chatgpt.com/use-cases/use-your-computer-with-codex#choose-the-right-browser) — distinguishes desktop Computer Use from Chrome/browser tasks.
- OpenAI, [Chrome extension](https://learn.chatgpt.com/docs/chrome-extension) — installation, website access, data, and security.
- OpenAI Codex, [`McpServerToolCallParams.ts`](https://github.com/openai/codex/blob/343074d4207d572809bd8cea15f4be1d09d98e0b/codex-rs/app-server-protocol/schema/typescript/v2/McpServerToolCallParams.ts) — `_meta` on direct MCP calls.
- Installed first-party artifact: `$HOME/.codex/plugins/cache/openai-bundled/chrome/26.818.31338/scripts/browser-client.mjs` and its matching plugin manifest. These proprietary files are version-bound and are not considered a stable public ABI.
