---
name: codex-chrome
description: Use Codex Chrome tools for the user's Chrome browser through the bundled Codex Chrome plugin.
---

# Codex Chrome

Use these tools when the user explicitly asks for Chrome or the task needs the user's existing Chrome profile state:

1. Start with `codex_chrome_list_browsers`, `codex_chrome_open_tabs`, or `codex_chrome_get_tab_state` before acting.
2. Prefer DOM tools with node ids from `codex_chrome_get_visible_dom` over raw coordinates.
3. After navigation, click, type, keypress, scroll, drag, or clipboard writes, verify with `codex_chrome_get_tab_state` or `codex_chrome_get_visible_dom`.
4. Ask the user before submitting forms, sending messages, deleting data, making purchases, changing account/security settings, or transmitting sensitive information.
5. If Chrome setup or permission is unavailable, stop and explain what is needed instead of falling back silently.
