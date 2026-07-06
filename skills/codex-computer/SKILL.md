---
name: codex-computer
description: Use Codex Computer Use tools safely for local macOS app inspection and interaction.
---

# Codex Computer Use

Use these tools when the user asks you to inspect or operate a local macOS app:

1. Call `computer_use_get_app_state` before acting in an app.
2. Prefer element indexes over raw coordinates.
3. After every click, type, keypress, scroll, drag, or value change, call `computer_use_get_app_state` again to verify the result.
4. Ask the user before sending messages, submitting forms, deleting data, making purchases, changing account/security settings, or transmitting sensitive information.
5. If a permission prompt is declined, stop the desktop task and explain what is needed.

## App target resolution

If `computer_use_get_app_state` returns `Invalid app`, do not assume the app is not running. The app may be a local macOS GUI process launched as a raw executable, so it can have WindowServer windows while missing from the Computer Use registered app index.

Before falling back to brittle desktop mechanisms:

1. Call `computer_use_list_apps` to inspect the registered Computer Use app index.
2. Call `computer_use_resolve_app` with the same requested target.
3. Prefer stable targets in this order: bundle id, `.app` bundle path, exact registered display name.
4. Treat raw executable paths, PID strings, `.build/debug/...`, `target/debug/...`, `dist/mac-unpacked/...`, and Electron development processes as possible unbundled GUI targets.
5. Do not use `osascript` or System Events as an automatic fallback unless the user explicitly asks.

If the target appears to be a WindowServer/process-only app that upstream Computer Use cannot address, explain that the app may be visible but not addressable by current Computer Use and suggest launching it through a temporary `.app` bundle, then using the bundle id or `.app` path.
