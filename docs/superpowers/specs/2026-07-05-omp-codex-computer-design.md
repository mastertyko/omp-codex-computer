# OMP Codex Computer Design

## Summary

Build an OMP extension that exposes OpenAI Codex Computer Use to OMP agents through Codex app-server. The first release focuses on a complete and reliable Computer Use bridge. Chrome support lives in the same repository as a separate proof-of-concept track until its runtime integration is verified.

The extension should be conservative, testable, and close to the existing OMP extension model. It should not implement desktop automation itself. Codex app-server owns plugin lifecycle, MCP server startup, app permissions, and communication with the bundled Computer Use service.

## Goals

- Provide OMP-native tools for Codex Computer Use.
- Reuse Codex app-server and the bundled `computer-use` MCP server.
- Keep tool names familiar to models, such as `computer_use_get_app_state` and `computer_use_click`.
- Add a small slash-command surface for status, diagnostics, enable/disable, and restart.
- Serialize desktop actions so concurrent model tool calls cannot interleave UI operations.
- Fail closed when a permission prompt cannot be shown to the user.
- Keep logs free of screenshots, base64 payloads, accessibility tree dumps, and secrets.
- Include focused tests before production implementation.

## Non-Goals

- Do not build a replacement desktop automation engine.
- Do not bypass Codex app-server's plugin and permission model.
- Do not make Chrome support equal to Computer Use in the first release.
- Do not auto-approve broad app permissions by default.
- Do not depend on Gemini, Claude, or unrelated MCP discovery.

## Architecture

The Computer Use path is:

```text
OMP extension tool
  -> Codex app-server over stdio
    -> bundled computer-use MCP server
      -> Codex Computer Use service
        -> local macOS desktop
```

The extension package will use OMP's extension manifest shape:

```json
{
  "omp": {
    "extensions": ["./src/index.ts"]
  }
}
```

Runtime startup is lazy. Nothing starts until the user runs a slash command that needs the backend or the model calls a Computer Use tool. The runtime shuts down on session shutdown, explicit restart/disable, and an idle timeout.

Chrome support is tracked as a separate bridge inside the same repository. The bundled Chrome plugin does not appear to expose an MCP server directly. Its API is available through the Codex browser client runtime, so the first Chrome milestone should only verify startup/status and a very small read-only browser action before expanding the tool surface.

## Components

### Extension Entry

`src/index.ts` registers tools, commands, and lifecycle hooks. It owns session-local enable/disable state and resets the runtime between sessions.

Commands:

- `/codex-computer status`
- `/codex-computer diagnose`
- `/codex-computer enable`
- `/codex-computer disable`
- `/codex-computer restart`

### App-Server Client

`src/app-server-client.ts` spawns `codex app-server --listen stdio://` and speaks newline-delimited JSON. It supports request/response messages and app-server initiated permission requests.

Expected Computer Use flow:

1. `initialize`
2. `plugin/list`
3. `thread/start` with an ephemeral thread
4. `mcpServer/tool/call` with server `computer-use`

### Thread Manager

`src/thread-manager.ts` owns the ephemeral Codex thread. It recreates the thread after runtime restart, session reset, or a stale-thread error. The backend may retry once after a stale-thread failure.

### Computer Use Backend

`src/computer-use-backend.ts` is a thin adapter over app-server tool calls. It normalizes errors, keeps app-server method names centralized, and exposes one method per Computer Use MCP tool.

### Tool Layer

`src/computer-use-tools.ts` registers OMP tools with static schemas. Tools proxy one-to-one to the Codex `computer-use` MCP server.

Initial tools:

- `computer_use_list_apps`
- `computer_use_get_app_state`
- `computer_use_click`
- `computer_use_type_text`
- `computer_use_press_key`
- `computer_use_scroll`
- `computer_use_drag`
- `computer_use_set_value`
- `computer_use_select_text`
- `computer_use_perform_secondary_action`

### Queue

`src/queue.ts` serializes all Computer Use tool calls through a promise chain. This prevents click/type/scroll operations from racing each other.

### Content Conversion

`src/content.ts` converts MCP content blocks to OMP-compatible tool results. Text may be truncated with a clear marker. Image blocks are preserved and never logged.

### Status and Diagnostics

`src/status.ts` checks Codex CLI availability, app-server startup, plugin install/enabled state, MCP server status, and live Computer Use tool listing where available.

### Logging

`src/log.ts` provides opt-in debug logging. Redaction must cover screenshots, base64 fields, text dumps, tokens, authorization headers, and app-server payloads that may contain user content.

## Permission Handling

Codex app-server may send elicitation requests such as "Allow Codex to use Finder?". The extension should bridge these to OMP UI confirmation when UI is available.

Rules:

- UI available: ask the user and return accept or decline.
- No UI available: decline.
- Development auto-accept may exist only behind an explicit environment allowlist.
- Permission decisions should not be silently broadened.

## Error Handling

Expected recoverable errors:

- Codex CLI missing: show install/configuration guidance.
- Codex app-server cannot start: show command and exit status without leaking payloads.
- Computer Use plugin missing or disabled: status command explains the state.
- MCP server unavailable: recommend reload/restart.
- Stale thread: reset thread and retry once.
- Permission declined: return a clear tool error.
- Tool timeout: shut down stale runtime and report retry guidance.

Unexpected errors should include a short user-facing message and a redacted diagnostic detail object for logs.

## Testing Strategy

Use test-driven development for implementation. Tests should be small and behavior-focused.

Initial test coverage:

- app-server JSONL parsing, response matching, and server-initiated permission requests.
- stale-thread retry behavior.
- queue serializes calls even when invoked concurrently.
- content conversion preserves image blocks and truncates huge text blocks predictably.
- status formatting for missing CLI, missing plugin, disabled plugin, and ready states.
- command handlers update enable/disable state without starting the backend unnecessarily.

Manual verification after tests:

- Run the extension under local OMP development mode.
- Run `/codex-computer status`.
- Ask OMP to list apps through Computer Use.
- Ask OMP to inspect a safe app such as Calculator or TextEdit.
- Verify permission prompts appear and decline safely when refused.

## Chrome Track

Chrome support should not block the Computer Use MVP.

First Chrome milestone:

- Detect whether the bundled Chrome/browser client files exist.
- Start a minimal bridge process only for a read-only smoke test.
- Report status through a separate command or diagnostic section.
- Avoid write/click/navigation tools until the bridge lifecycle and permission model are understood.

Only after that smoke test is reliable should the repo add `codex_chrome_*` tools.

## Development Workflow

Start with the design document, then create an implementation plan. After implementation begins:

1. Write a failing test for one behavior.
2. Run the focused test and confirm the failure is correct.
3. Implement the smallest production change.
4. Rerun the focused test.
5. Refactor only after the test is green.
6. Expand coverage behavior by behavior.

Local verification should use the local development command path first, leaving the official OMP install untouched until the extension is ready.
