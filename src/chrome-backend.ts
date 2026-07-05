import { randomUUID } from "node:crypto";
import { convertCodexContentToOmpContent, type OmpContentBlock } from "./content";
import { logDebug } from "./log";
import { SerialQueue } from "./queue";
import type { AppServerClient } from "./app-server-client";
import type { CodexThreadInfo, CodexThreadManager } from "./thread-manager";

export const DEFAULT_CHROME_BROWSER_CLIENT_PATH =
  "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/chrome/scripts/browser-client.mjs";

export interface ChromeBackendOptions {
  browserClientPath?: string;
  createTurnId?: () => string;
}

export interface ChromeToolResult {
  content: OmpContentBlock[];
  structuredContent?: unknown;
  meta?: unknown;
}

interface RawMcpToolCallResponse {
  content: unknown;
  structuredContent?: unknown;
  _meta?: unknown;
  isError?: boolean | null;
}

interface ChromeToolSpec {
  title: string;
  code: string;
  timeoutMs?: number;
}

class ChromeToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChromeToolCallError";
  }
}

export class ChromeBackend {
  private readonly queue = new SerialQueue();
  private readonly browserClientPath: string;
  private readonly createTurnId: () => string;

  constructor(
    private readonly client: Pick<AppServerClient, "request">,
    private readonly threads: Pick<CodexThreadManager, "getThread" | "reset">,
    options: ChromeBackendOptions = {},
  ) {
    this.browserClientPath = options.browserClientPath ?? DEFAULT_CHROME_BROWSER_CLIENT_PATH;
    this.createTurnId = options.createTurnId ?? randomUUID;
  }

  async callTool(cwd: string, tool: string, args: Record<string, unknown>): Promise<ChromeToolResult> {
    return this.queue.enqueue(async () => {
      logDebug("chrome.tool.start", { tool, argKeys: Object.keys(args) });
      try {
        return await this.callToolOnce(cwd, tool, args);
      } catch (error) {
        if (error instanceof ChromeToolCallError) throw error;

        const message = error instanceof Error ? error.message : String(error);
        if (!/thread not found|invalid thread id/i.test(message)) throw error;

        logDebug("chrome.tool.retry-thread", { tool });
        this.threads.reset();
        return this.callToolOnce(cwd, tool, args);
      }
    });
  }

  private async callToolOnce(cwd: string, tool: string, args: Record<string, unknown>): Promise<ChromeToolResult> {
    const thread = await this.threads.getThread(cwd);
    const spec = buildChromeToolSpec(tool, args, this.browserClientPath);
    const response = await this.client.request<RawMcpToolCallResponse>(
      "mcpServer/tool/call",
      {
        server: "node_repl",
        threadId: thread.id,
        tool: "js",
        arguments: {
          code: spec.code,
          title: spec.title,
          timeout_ms: spec.timeoutMs ?? 60_000,
        },
        _meta: {
          "x-codex-turn-metadata": createTurnMetadata(thread, this.createTurnId()),
        },
      },
      spec.timeoutMs ?? 60_000,
    );

    if (response.isError) {
      const text = convertCodexContentToOmpContent(response.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      throw new ChromeToolCallError(text || `Chrome ${tool} failed`);
    }

    const content = convertCodexContentToOmpContent(response.content);
    logDebug("chrome.tool.end", { tool, contentTypes: content.map((block) => block.type).join(",") });

    return {
      content,
      structuredContent: response.structuredContent,
      meta: response._meta,
    };
  }
}

function createTurnMetadata(thread: CodexThreadInfo, turnId: string): Record<string, string> {
  return {
    session_id: thread.sessionId,
    thread_id: thread.id,
    turn_id: turnId,
  };
}

export function buildChromeToolSpec(
  tool: string,
  args: Record<string, unknown>,
  browserClientPath = DEFAULT_CHROME_BROWSER_CLIENT_PATH,
): ChromeToolSpec {
  return {
    title: `Chrome ${tool}`,
    timeoutMs: getTimeoutMs(args),
    code: buildChromeToolCode(tool, args, browserClientPath),
  };
}

function buildChromeToolCode(tool: string, args: Record<string, unknown>, browserClientPath: string): string {
  return `
await (async () => {
  const input = ${JSON.stringify(args)};
  const browserClientPath = ${JSON.stringify(browserClientPath)};
  const tool = ${JSON.stringify(tool)};

  async function ensureRuntime() {
    if (globalThis.__ompCodexChromeRuntime?.browserClientPath === browserClientPath && globalThis.agent?.browsers) {
      return;
    }
    const { setupBrowserRuntime } = await import(browserClientPath);
    await setupBrowserRuntime({ globals: globalThis });
    globalThis.__ompCodexChromeRuntime = { browserClientPath };
    globalThis.__ompCodexChromeBrowsers = new Map();
  }

  async function getBrowser() {
    await ensureRuntime();
    const browserId = stringOr(input.browser_id, "extension");
    const cache = globalThis.__ompCodexChromeBrowsers ?? new Map();
    globalThis.__ompCodexChromeBrowsers = cache;
    if (!cache.has(browserId)) {
      cache.set(browserId, await agent.browsers.get(browserId));
    }
    return cache.get(browserId);
  }

  async function getTab(browser) {
    if (typeof input.tab_id === "string" && input.tab_id.length > 0) {
      return await browser.tabs.get(input.tab_id);
    }
    const selected = await browser.tabs.selected();
    if (selected) return selected;
    throw new Error("No selected Chrome tab is available; pass tab_id, claim a tab, or create a new tab first.");
  }

  async function summarizeTab(tab) {
    return {
      id: String(tab.id),
      title: await optional(() => tab.title()),
      url: await optional(() => tab.url()),
    };
  }

  async function output(value) {
    nodeRepl.write(JSON.stringify(value ?? null, null, 2));
  }

  async function optional(fn) {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  }

  function stringOr(value, fallback) {
    return typeof value === "string" && value.length > 0 ? value : fallback;
  }

  function pickDefined(keys) {
    const picked = {};
    for (const key of keys) {
      if (input[key] !== undefined) picked[key] = input[key];
    }
    return picked;
  }

  if (tool === "list_browsers") {
    await ensureRuntime();
    await output(await agent.browsers.list());
    return;
  }

  const browser = await getBrowser();

  if (tool === "documentation") {
    nodeRepl.write(await browser.documentation());
    return;
  }

  if (tool === "open_tabs") {
    await output(await browser.user.openTabs());
    return;
  }

  if (tool === "history") {
    await output(await browser.user.history(pickDefined(["queries", "limit", "from", "to"])));
    return;
  }

  if (tool === "claim_tab") {
    const tab = await browser.user.claimTab(String(input.tab_id));
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "tabs_list") {
    await output(await browser.tabs.list());
    return;
  }

  if (tool === "tabs_content") {
    await output(await browser.tabs.content({
      urls: input.urls,
      contentType: stringOr(input.content_type, "text"),
      timeoutMs: input.timeout_ms,
    }));
    return;
  }

  if (tool === "selected_tab") {
    const tab = await browser.tabs.selected();
    await output(tab ? await summarizeTab(tab) : null);
    return;
  }

  if (tool === "new_tab") {
    const tab = await browser.tabs.new();
    if (typeof input.url === "string" && input.url.length > 0) await tab.goto(input.url);
    await output(await summarizeTab(tab));
    return;
  }

  const tab = await getTab(browser);

  if (tool === "get_tab_state") {
    const state = await summarizeTab(tab);
    if (input.include_visible_dom === true) state.visibleDom = await tab.dom_cua.get_visible_dom();
    await output(state);
    return;
  }

  if (tool === "get_visible_dom") {
    await output(await tab.dom_cua.get_visible_dom());
    return;
  }

  if (tool === "screenshot") {
    const options = {};
    if (input.full_page !== undefined) options.fullPage = input.full_page;
    if (input.clip) options.clip = input.clip;
    await nodeRepl.emitImage(await tab.screenshot(options));
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "goto") {
    await tab.goto(String(input.url));
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "reload") {
    await tab.reload();
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "back") {
    await tab.back();
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "forward") {
    await tab.forward();
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "close") {
    const summary = await summarizeTab(tab);
    await tab.close();
    await output({ closed: summary });
    return;
  }

  if (tool === "mark_handoff") {
    await tab.markHandoff();
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "mark_deliverable") {
    await tab.markDeliverable();
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "dom_click") {
    await tab.dom_cua.click({ node_id: String(input.node_id) });
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "dom_double_click") {
    await tab.dom_cua.double_click({ node_id: String(input.node_id) });
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "dom_type") {
    await tab.dom_cua.type({ text: String(input.text) });
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "dom_keypress") {
    await tab.dom_cua.keypress({ keys: input.keys });
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "dom_scroll") {
    await tab.dom_cua.scroll({
      x: input.x ?? 0,
      y: input.y,
      ...(input.node_id === undefined ? {} : { node_id: String(input.node_id) }),
    });
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "click") {
    await tab.cua.click(pickDefined(["x", "y", "button", "keypress"]));
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "double_click") {
    await tab.cua.double_click({
      x: input.x,
      y: input.y,
      ...(input.keypress === undefined ? {} : { keypress: input.keypress }),
    });
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "type_text") {
    await tab.cua.type({ text: String(input.text) });
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "keypress") {
    await tab.cua.keypress({ keys: input.keys });
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "scroll") {
    await tab.cua.scroll({
      x: input.x,
      y: input.y,
      scrollX: input.scroll_x ?? 0,
      scrollY: input.scroll_y,
      ...(input.keypress === undefined ? {} : { keypress: input.keypress }),
    });
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "drag") {
    await tab.cua.drag(pickDefined(["path", "keys"]));
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "evaluate") {
    const value = await tab.playwright.evaluate(
      ({ expression, arg }) => {
        const fn = new Function("arg", '"use strict"; return (' + expression + ');');
        return fn(arg);
      },
      { expression: String(input.expression), arg: input.arg },
      { timeoutMs: input.timeout_ms },
    );
    await output(value);
    return;
  }

  if (tool === "dom_snapshot") {
    nodeRepl.write(await tab.playwright.domSnapshot());
    return;
  }

  if (tool === "element_info") {
    await output(await tab.playwright.elementInfo({
      x: input.x,
      y: input.y,
      ...(input.include_non_interactable === undefined ? {} : { includeNonInteractable: input.include_non_interactable }),
    }));
    return;
  }

  if (tool === "dev_logs") {
    await output(await tab.dev.logs(pickDefined(["filter", "levels", "limit"])));
    return;
  }

  if (tool === "wait_for_load_state") {
    await tab.playwright.waitForLoadState({
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.timeout_ms === undefined ? {} : { timeoutMs: input.timeout_ms }),
    });
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "wait_for_url") {
    await tab.playwright.waitForURL(String(input.url), {
      ...(input.timeout_ms === undefined ? {} : { timeoutMs: input.timeout_ms }),
      ...(input.wait_until === undefined ? {} : { waitUntil: input.wait_until }),
    });
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "wait_for_timeout") {
    await tab.playwright.waitForTimeout(Number(input.timeout_ms));
    await output(await summarizeTab(tab));
    return;
  }

  if (tool === "export_content") {
    await output({ path: await tab.content.export() });
    return;
  }

  if (tool === "export_gsuite") {
    await output({ path: await tab.content.exportGsuite(String(input.format)) });
    return;
  }

  if (tool === "clipboard_read_text") {
    await output({ text: await tab.clipboard.readText() });
    return;
  }

  if (tool === "clipboard_write_text") {
    await tab.clipboard.writeText(String(input.text));
    await output({ ok: true });
    return;
  }

  throw new Error("Unsupported Chrome tool: " + tool);
})();
`;
}

function getTimeoutMs(args: Record<string, unknown>): number | undefined {
  const value = args.timeout_ms;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.ceil(value);
}
