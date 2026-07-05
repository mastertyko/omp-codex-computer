import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { OmpContentBlock } from "./content";
import type { ChromeToolResult } from "./chrome-backend";
import type { ComputerUseRuntime } from "./runtime";

export const CHROME_TOOL_NAMES = [
  "codex_chrome_list_browsers",
  "codex_chrome_documentation",
  "codex_chrome_open_tabs",
  "codex_chrome_history",
  "codex_chrome_claim_tab",
  "codex_chrome_tabs_list",
  "codex_chrome_tabs_content",
  "codex_chrome_selected_tab",
  "codex_chrome_new_tab",
  "codex_chrome_get_tab_state",
  "codex_chrome_get_visible_dom",
  "codex_chrome_screenshot",
  "codex_chrome_goto",
  "codex_chrome_reload",
  "codex_chrome_back",
  "codex_chrome_forward",
  "codex_chrome_close",
  "codex_chrome_mark_handoff",
  "codex_chrome_mark_deliverable",
  "codex_chrome_dom_click",
  "codex_chrome_dom_double_click",
  "codex_chrome_dom_type",
  "codex_chrome_dom_keypress",
  "codex_chrome_dom_scroll",
  "codex_chrome_click",
  "codex_chrome_double_click",
  "codex_chrome_type_text",
  "codex_chrome_keypress",
  "codex_chrome_scroll",
  "codex_chrome_drag",
  "codex_chrome_evaluate",
  "codex_chrome_dom_snapshot",
  "codex_chrome_element_info",
  "codex_chrome_dev_logs",
  "codex_chrome_wait_for_load_state",
  "codex_chrome_wait_for_url",
  "codex_chrome_wait_for_timeout",
  "codex_chrome_export_content",
  "codex_chrome_export_gsuite",
  "codex_chrome_clipboard_read_text",
  "codex_chrome_clipboard_write_text",
] as const;

const CHROME_TOOLS = [
  tool("codex_chrome_list_browsers", "list_browsers", "List Chrome Backends", "List Chrome/browser backends available to Codex.", "read"),
  tool("codex_chrome_documentation", "documentation", "Read Chrome Docs", "Read the bundled Chrome browser-control documentation.", "read"),
  tool("codex_chrome_open_tabs", "open_tabs", "List User Tabs", "List open user Chrome tabs that can be claimed.", "read"),
  tool("codex_chrome_history", "history", "Read History", "Read recent Chrome history through the Chrome plugin.", "read"),
  tool("codex_chrome_claim_tab", "claim_tab", "Claim Tab", "Claim an existing user Chrome tab for automation.", "write"),
  tool("codex_chrome_tabs_list", "tabs_list", "List Session Tabs", "List tabs currently controlled by the Chrome automation session.", "read"),
  tool("codex_chrome_tabs_content", "tabs_content", "Read URLs", "Load URLs in background tabs and extract content where supported.", "read"),
  tool("codex_chrome_selected_tab", "selected_tab", "Selected Tab", "Return the selected controlled Chrome tab.", "read"),
  tool("codex_chrome_new_tab", "new_tab", "New Tab", "Create a new controlled Chrome tab, optionally opening a URL.", "write"),
  tool("codex_chrome_get_tab_state", "get_tab_state", "Tab State", "Read a Chrome tab title, URL, and optionally visible DOM.", "read"),
  tool("codex_chrome_get_visible_dom", "get_visible_dom", "Visible DOM", "Read the filtered visible DOM with node ids for interaction.", "read"),
  tool("codex_chrome_screenshot", "screenshot", "Screenshot", "Capture a Chrome tab screenshot.", "read"),
  tool("codex_chrome_goto", "goto", "Go To URL", "Navigate a Chrome tab to a URL.", "write"),
  tool("codex_chrome_reload", "reload", "Reload", "Reload a Chrome tab.", "write"),
  tool("codex_chrome_back", "back", "Back", "Navigate a Chrome tab backward.", "write"),
  tool("codex_chrome_forward", "forward", "Forward", "Navigate a Chrome tab forward.", "write"),
  tool("codex_chrome_close", "close", "Close Tab", "Close a controlled Chrome tab.", "write"),
  tool("codex_chrome_mark_handoff", "mark_handoff", "Mark Handoff", "Keep a Chrome tab available for later turns.", "write"),
  tool("codex_chrome_mark_deliverable", "mark_deliverable", "Mark Deliverable", "Keep a Chrome tab as a final deliverable.", "write"),
  tool("codex_chrome_dom_click", "dom_click", "DOM Click", "Click a visible DOM node by node id.", "write"),
  tool("codex_chrome_dom_double_click", "dom_double_click", "DOM Double Click", "Double-click a visible DOM node by node id.", "write"),
  tool("codex_chrome_dom_type", "dom_type", "DOM Type", "Type text into the focused DOM element.", "write"),
  tool("codex_chrome_dom_keypress", "dom_keypress", "DOM Keypress", "Press keys in the focused DOM element.", "write"),
  tool("codex_chrome_dom_scroll", "dom_scroll", "DOM Scroll", "Scroll the page or a visible DOM node.", "write"),
  tool("codex_chrome_click", "click", "Click Coordinates", "Click viewport coordinates in a Chrome tab.", "write"),
  tool("codex_chrome_double_click", "double_click", "Double Click Coordinates", "Double-click viewport coordinates in a Chrome tab.", "write"),
  tool("codex_chrome_type_text", "type_text", "Type Text", "Type text at the current Chrome focus.", "write"),
  tool("codex_chrome_keypress", "keypress", "Keypress", "Press keys at the current Chrome focus.", "write"),
  tool("codex_chrome_scroll", "scroll", "Scroll Coordinates", "Scroll from viewport coordinates in a Chrome tab.", "write"),
  tool("codex_chrome_drag", "drag", "Drag", "Drag along a viewport coordinate path in a Chrome tab.", "write"),
  tool("codex_chrome_evaluate", "evaluate", "Evaluate Readonly JS", "Evaluate JavaScript in Chrome's read-only page scope.", "read"),
  tool("codex_chrome_dom_snapshot", "dom_snapshot", "DOM Snapshot", "Read a Playwright-style DOM snapshot.", "read"),
  tool("codex_chrome_element_info", "element_info", "Element Info", "Read element metadata at screenshot coordinates.", "read"),
  tool("codex_chrome_dev_logs", "dev_logs", "Dev Logs", "Read captured console logs for a Chrome tab.", "read"),
  tool("codex_chrome_wait_for_load_state", "wait_for_load_state", "Wait Load State", "Wait for a Chrome tab load state.", "read"),
  tool("codex_chrome_wait_for_url", "wait_for_url", "Wait URL", "Wait for a Chrome tab URL.", "read"),
  tool("codex_chrome_wait_for_timeout", "wait_for_timeout", "Wait", "Wait for a fixed duration in a Chrome tab.", "read"),
  tool("codex_chrome_export_content", "export_content", "Export Content", "Export a Chrome tab's content to a local file.", "read"),
  tool("codex_chrome_export_gsuite", "export_gsuite", "Export GSuite", "Export a Google Workspace tab to a local file.", "read"),
  tool("codex_chrome_clipboard_read_text", "clipboard_read_text", "Read Clipboard", "Read plain text from Chrome's session clipboard.", "read"),
  tool("codex_chrome_clipboard_write_text", "clipboard_write_text", "Write Clipboard", "Write plain text to Chrome's session clipboard.", "write"),
] as const satisfies ReadonlyArray<{
  name: (typeof CHROME_TOOL_NAMES)[number];
  backendTool: string;
  label: string;
  description: string;
  approval: "read" | "write";
}>;

export function registerChromeTools(pi: ExtensionAPI, runtime: Pick<ComputerUseRuntime, "callChromeTool">): void {
  const parametersByTool = createParameterSchemas(pi);

  for (const chromeTool of CHROME_TOOLS) {
    pi.registerTool({
      name: chromeTool.name,
      label: chromeTool.label,
      description: chromeTool.description,
      parameters: parametersByTool[chromeTool.name],
      defaultInactive: true,
      approval: chromeTool.approval,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        const result = await runtime.callChromeTool(ctx, chromeTool.backendTool, params);
        return {
          content: result.content,
          details: summarizeResult(result),
        };
      },
    } as Parameters<ExtensionAPI["registerTool"]>[0]);
  }
}

function tool(
  name: (typeof CHROME_TOOL_NAMES)[number],
  backendTool: string,
  label: string,
  description: string,
  approval: "read" | "write",
) {
  return { name, backendTool, label, description, approval };
}

function createParameterSchemas(pi: ExtensionAPI): Record<(typeof CHROME_TOOL_NAMES)[number], unknown> {
  const z = pi.zod;
  const browserId = z.string().describe("Browser id from codex_chrome_list_browsers. Defaults to extension.").optional();
  const tabId = z.string().describe("Controlled tab id. Defaults to the selected controlled tab when omitted.").optional();
  const withTab = { browser_id: browserId, tab_id: tabId };
  const keys = z.array(z.string()).min(1).describe("Keys or key combination to press, such as Enter or Meta+L.");
  const timeoutMs = z.number().int().positive().describe("Timeout in milliseconds.").optional();
  const coordinate = {
    x: z.number().describe("Viewport x coordinate."),
    y: z.number().describe("Viewport y coordinate."),
  };

  return {
    codex_chrome_list_browsers: z.object({}).passthrough(),
    codex_chrome_documentation: z.object({ browser_id: browserId }).passthrough(),
    codex_chrome_open_tabs: z.object({ browser_id: browserId }).passthrough(),
    codex_chrome_history: z.object({
      browser_id: browserId,
      queries: z.array(z.string()).optional(),
      limit: z.number().int().positive().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    }).passthrough(),
    codex_chrome_claim_tab: z.object({ browser_id: browserId, tab_id: z.string() }).passthrough(),
    codex_chrome_tabs_list: z.object({ browser_id: browserId }).passthrough(),
    codex_chrome_tabs_content: z.object({
      browser_id: browserId,
      urls: z.array(z.string()).min(1),
      content_type: z.enum(["html", "text", "domSnapshot"]).default("text").optional(),
      timeout_ms: timeoutMs,
    }).passthrough(),
    codex_chrome_selected_tab: z.object({ browser_id: browserId }).passthrough(),
    codex_chrome_new_tab: z.object({ browser_id: browserId, url: z.string().optional() }).passthrough(),
    codex_chrome_get_tab_state: z.object({
      ...withTab,
      include_visible_dom: z.boolean().optional(),
    }).passthrough(),
    codex_chrome_get_visible_dom: z.object(withTab).passthrough(),
    codex_chrome_screenshot: z.object({
      ...withTab,
      full_page: z.boolean().optional(),
      clip: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
    }).passthrough(),
    codex_chrome_goto: z.object({ ...withTab, url: z.string() }).passthrough(),
    codex_chrome_reload: z.object(withTab).passthrough(),
    codex_chrome_back: z.object(withTab).passthrough(),
    codex_chrome_forward: z.object(withTab).passthrough(),
    codex_chrome_close: z.object(withTab).passthrough(),
    codex_chrome_mark_handoff: z.object(withTab).passthrough(),
    codex_chrome_mark_deliverable: z.object(withTab).passthrough(),
    codex_chrome_dom_click: z.object({ ...withTab, node_id: z.union([z.string(), z.number()]) }).passthrough(),
    codex_chrome_dom_double_click: z.object({ ...withTab, node_id: z.union([z.string(), z.number()]) }).passthrough(),
    codex_chrome_dom_type: z.object({ ...withTab, text: z.string() }).passthrough(),
    codex_chrome_dom_keypress: z.object({ ...withTab, keys }).passthrough(),
    codex_chrome_dom_scroll: z.object({
      ...withTab,
      node_id: z.union([z.string(), z.number()]).optional(),
      x: z.number().default(0).optional(),
      y: z.number(),
    }).passthrough(),
    codex_chrome_click: z.object({
      ...withTab,
      ...coordinate,
      button: z.number().int().positive().optional(),
      keypress: z.array(z.string()).optional(),
    }).passthrough(),
    codex_chrome_double_click: z.object({
      ...withTab,
      ...coordinate,
      keypress: z.array(z.string()).optional(),
    }).passthrough(),
    codex_chrome_type_text: z.object({ ...withTab, text: z.string() }).passthrough(),
    codex_chrome_keypress: z.object({ ...withTab, keys }).passthrough(),
    codex_chrome_scroll: z.object({
      ...withTab,
      ...coordinate,
      scroll_x: z.number().default(0).optional(),
      scroll_y: z.number(),
      keypress: z.array(z.string()).optional(),
    }).passthrough(),
    codex_chrome_drag: z.object({
      ...withTab,
      path: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
      keys: z.array(z.string()).optional(),
    }).passthrough(),
    codex_chrome_evaluate: z.object({
      ...withTab,
      expression: z.string().describe("JavaScript expression evaluated in Chrome's read-only page scope."),
      arg: z.unknown().optional(),
      timeout_ms: timeoutMs,
    }).passthrough(),
    codex_chrome_dom_snapshot: z.object(withTab).passthrough(),
    codex_chrome_element_info: z.object({
      ...withTab,
      ...coordinate,
      include_non_interactable: z.boolean().optional(),
    }).passthrough(),
    codex_chrome_dev_logs: z.object({
      ...withTab,
      filter: z.string().optional(),
      levels: z.array(z.enum(["debug", "info", "log", "warn", "error", "warning"])).optional(),
      limit: z.number().int().positive().optional(),
    }).passthrough(),
    codex_chrome_wait_for_load_state: z.object({
      ...withTab,
      state: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      timeout_ms: timeoutMs,
    }).passthrough(),
    codex_chrome_wait_for_url: z.object({
      ...withTab,
      url: z.string(),
      timeout_ms: timeoutMs,
      wait_until: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
    }).passthrough(),
    codex_chrome_wait_for_timeout: z.object({
      ...withTab,
      timeout_ms: z.number().int().positive(),
    }).passthrough(),
    codex_chrome_export_content: z.object(withTab).passthrough(),
    codex_chrome_export_gsuite: z.object({
      ...withTab,
      format: z.enum(["pdf", "md", "xlsx", "csv", "docx", "pptx"]),
    }).passthrough(),
    codex_chrome_clipboard_read_text: z.object(withTab).passthrough(),
    codex_chrome_clipboard_write_text: z.object({ ...withTab, text: z.string() }).passthrough(),
  };
}

interface ToolSummary {
  contentTypes: string[];
  counts: Record<string, number>;
  hasStructuredContent: boolean;
  hasMeta: boolean;
}

function summarizeResult(result: ChromeToolResult): ToolSummary {
  const counts: Record<string, number> = {};
  const contentTypes: string[] = [];

  for (const block of result.content) {
    const type = getContentType(block);
    counts[type] = (counts[type] ?? 0) + 1;
    if (!contentTypes.includes(type)) contentTypes.push(type);
  }

  return {
    contentTypes,
    counts,
    hasStructuredContent: result.structuredContent !== undefined,
    hasMeta: result.meta !== undefined,
  };
}

function getContentType(block: OmpContentBlock): string {
  return typeof block.type === "string" ? block.type : "unknown";
}
