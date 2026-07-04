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
