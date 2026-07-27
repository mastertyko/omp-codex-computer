import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { AppServerClient } from "../src/app-server-client";
import { ComputerUseTransport, SkyComputerUseError } from "../src/computer-use-transport";
import { COMPUTER_USE_MCP_TOOL_NAMES } from "../src/computer-use-tools";
import type { McpServerStatus, McpServerStatusListResponse, PluginListResponse } from "../src/protocol";
import type { CodexThreadManager } from "../src/thread-manager";

const SKY_PROTOCOL = "omp-codex-computer/sky-v1";
const TEST_ROOT = mkdtempSync(join(tmpdir(), "omp-computer-use-transport-"));
const MARKETPLACE_ROOT = join(TEST_ROOT, "marketplace");
const MARKETPLACE_DESCRIPTOR_PATH = join(MARKETPLACE_ROOT, ".agents", "plugins", "marketplace.json");
const PLUGIN_ROOT = join(MARKETPLACE_ROOT, "computer-use");
const WRAPPER_PATH = join(PLUGIN_ROOT, "scripts", "computer-use-client.mjs");

mkdirSync(dirname(WRAPPER_PATH), { recursive: true });
writeFileSync(WRAPPER_PATH, "export const fixture = true;\n");
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

type SkyPhase = "bootstrap" | "dispatch";

interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
}

interface ToolRequest extends RecordedRequest {
  params: Record<string, unknown> & {
    server: string;
    threadId: string;
    tool: string;
    arguments: Record<string, unknown>;
  };
}

interface FakeMcpResponse {
  content: unknown[];
  structuredContent?: unknown;
  _meta?: unknown;
  isError?: boolean;
}

class FakeClient implements Pick<AppServerClient, "request"> {
  readonly calls: RecordedRequest[] = [];
  readonly toolResponses: unknown[] = [];
  pluginResponse: PluginListResponse = currentPluginList();
  mcpResponse: McpServerStatusListResponse = { data: [] };

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<TResult> {
    const call = {
      method,
      params: (params ?? {}) as Record<string, unknown>,
      timeoutMs,
      signal,
    };
    this.calls.push(call);

    if (method === "plugin/list") return this.pluginResponse as unknown as TResult;
    if (method === "mcpServerStatus/list") return this.mcpResponse as unknown as TResult;
    if (method !== "mcpServer/tool/call") throw new Error(`Unexpected request: ${method}`);
    if (this.toolResponses.length === 0) throw new Error("No queued MCP tool response");

    const response = this.toolResponses.shift();
    if (response instanceof Error) throw response;
    return (await response) as TResult;
  }
}

class FakeThreads implements Pick<CodexThreadManager, "getThreadId"> {
  readonly calls: string[] = [];

  constructor(private readonly threadId = "thread-1") {}

  async getThreadId(cwd: string): Promise<string> {
    this.calls.push(cwd);
    return this.threadId;
  }
}

function currentPluginList(options: {
  marketplaceName?: string;
  marketplacePath?: string;
  pluginPath?: string;
  installed?: boolean;
  enabled?: boolean;
} = {}): PluginListResponse {
  return {
    marketplaces: [
      {
        name: options.marketplaceName ?? "openai-bundled",
        path: options.marketplacePath ?? MARKETPLACE_DESCRIPTOR_PATH,
        plugins: [
          {
            id: "computer-use",
            name: "computer-use",
            installed: options.installed ?? true,
            enabled: options.enabled ?? true,
            installPolicy: "bundled",
            authPolicy: "none",
            source: { path: options.pluginPath ?? PLUGIN_ROOT },
          },
        ],
      },
    ],
  };
}

function server(name: string, toolNames: readonly string[]): McpServerStatus {
  return {
    name,
    authStatus: "not_required",
    tools: Object.fromEntries(toolNames.map((toolName) => [toolName, { name: toolName, inputSchema: {} }])),
    resources: [],
    resourceTemplates: [],
  };
}

function nodeReplServer(): McpServerStatus {
  return server("node_repl", ["js"]);
}

function directServer(toolNames: readonly string[] = COMPUTER_USE_MCP_TOOL_NAMES): McpServerStatus {
  return server("computer-use", toolNames);
}

function skySuccess(phase: SkyPhase, result?: unknown, otherContent: unknown[] = []): FakeMcpResponse {
  const envelope: Record<string, unknown> = { protocol: SKY_PROTOCOL, ok: true, phase };
  if (result !== undefined) envelope.result = result;
  return {
    content: [...otherContent, { type: "text", text: JSON.stringify(envelope) }],
  };
}

function skyError(phase: SkyPhase, error: Record<string, unknown>): FakeMcpResponse {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ protocol: SKY_PROTOCOL, ok: false, phase, error }),
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolRequests(client: FakeClient): ToolRequest[] {
  return client.calls.filter((call): call is ToolRequest =>
    call.method === "mcpServer/tool/call"
    && typeof call.params.server === "string"
    && typeof call.params.threadId === "string"
    && typeof call.params.tool === "string"
    && isRecord(call.params.arguments));
}

function programFrom(call: ToolRequest): string {
  const code = call.params.arguments.code;
  if (typeof code !== "string") throw new Error("Expected a node_repl program");
  return code;
}

function decodeSkyPayload(program: string): { tool: string; args: Record<string, unknown> } {
  const match = /Buffer\.from\(("[A-Za-z0-9+/=]+"), "base64"\)/.exec(program);
  if (!match?.[1]) throw new Error("Expected an encoded Sky payload");

  const encoded: unknown = JSON.parse(match[1]);
  if (typeof encoded !== "string") throw new Error("Expected a base64 string literal");
  const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!isRecord(decoded) || typeof decoded.tool !== "string" || !isRecord(decoded.args)) {
    throw new Error("Expected a valid Sky dispatch payload");
  }
  return { tool: decoded.tool, args: decoded.args };
}

describe("ComputerUseTransport", () => {
  it("prefers current Sky capabilities, bootstraps separately, and normalizes list_apps", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList();
    client.mcpResponse = { data: [directServer(), nodeReplServer()] };
    const apps = [{ id: "com.apple.Calculator", displayName: "Calculator" }];
    client.toolResponses.push(skySuccess("bootstrap"), skySuccess("dispatch", apps));
    const transport = new ComputerUseTransport(client, new FakeThreads());
    const controller = new AbortController();

    const result = await transport.callTool("/work", "list_apps", {}, controller.signal);

    expect(result).toEqual({
      route: "sky",
      content: [{ type: "text", text: JSON.stringify(apps, null, 2) }],
      structuredContent: apps,
    });
    expect(client.calls.map((call) => call.method)).toEqual([
      "plugin/list",
      "mcpServerStatus/list",
      "mcpServer/tool/call",
      "mcpServer/tool/call",
    ]);
    expect(client.calls.map((call) => call.timeoutMs)).toEqual([undefined, undefined, 0, 0]);
    expect(client.calls.every((call) => call.signal === controller.signal)).toBe(true);

    const [bootstrap, dispatch] = toolRequests(client);
    if (!bootstrap || !dispatch) throw new Error("Expected separate bootstrap and dispatch requests");
    expect(bootstrap.params).toMatchObject({
      server: "node_repl",
      threadId: "thread-1",
      tool: "js",
      arguments: { title: "Computer Use bootstrap", timeout_ms: 120_000 },
    });
    expect(dispatch.params).toMatchObject({
      server: "node_repl",
      threadId: "thread-1",
      tool: "js",
      arguments: { title: "Computer Use: list_apps", timeout_ms: 120_000 },
    });
    expect(programFrom(bootstrap)).not.toContain('phase = "dispatch"');
    expect(programFrom(bootstrap)).toContain(pathToFileURL(realpathSync(WRAPPER_PATH)).href);
    expect(decodeSkyPayload(programFrom(dispatch))).toEqual({ tool: "list_apps", args: {} });
  });

  it("prepare observes and caches the route selected from supplied discovery", async () => {
    const client = new FakeClient();
    const discovery = {
      plugins: currentPluginList(),
      mcp: { data: [nodeReplServer(), directServer()] },
    };
    client.toolResponses.push(skySuccess("bootstrap"), skySuccess("dispatch", []));
    const transport = new ComputerUseTransport(client, new FakeThreads());
    const controller = new AbortController();

    const route = await transport.prepare("/work", discovery, controller.signal);
    const result = await transport.callTool("/work", "list_apps", {}, controller.signal);

    expect(route).toBe("sky");
    expect(result.route).toBe("sky");
    expect(client.calls.map((call) => call.method)).toEqual([
      "mcpServer/tool/call",
      "mcpServer/tool/call",
    ]);
    expect(client.calls.every((call) => call.signal === controller.signal)).toBe(true);
    expect(toolRequests(client).map((call) => call.params.arguments.title)).toEqual([
      "Computer Use bootstrap",
      "Computer Use: list_apps",
    ]);
  });

  it("rejects a same-name plugin from a third-party marketplace for Sky and direct", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList({ marketplaceName: "third-party" });
    client.mcpResponse = { data: [nodeReplServer(), directServer()] };
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await expect(transport.callTool("/work", "list_apps", {})).rejects.toThrow(
      "Computer Use transport is unavailable",
    );
    expect(toolRequests(client)).toHaveLength(0);
  });

  it("requires the official plugin to be installed and enabled before selecting either route", async () => {
    for (const pluginResponse of [
      currentPluginList({ installed: false }),
      currentPluginList({ enabled: false }),
    ]) {
      const client = new FakeClient();
      client.pluginResponse = pluginResponse;
      client.mcpResponse = { data: [nodeReplServer(), directServer()] };
      const transport = new ComputerUseTransport(client, new FakeThreads());

      await expect(transport.callTool("/work", "list_apps", {})).rejects.toThrow(
        "Computer Use transport is unavailable",
      );
      expect(toolRequests(client)).toHaveLength(0);
    }
  });

  it("accepts the enabled official plugin from openai-curated", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList({ marketplaceName: "openai-curated" });
    client.mcpResponse = { data: [directServer()] };
    client.toolResponses.push({ content: [{ type: "text", text: "apps" }] });
    const transport = new ComputerUseTransport(client, new FakeThreads());

    const result = await transport.callTool("/work", "list_apps", {});

    expect(result.route).toBe("direct");
    expect(toolRequests(client).map((call) => call.params.server)).toEqual(["computer-use"]);
  });

  it("falls back to complete direct MCP when the trusted legacy plugin has no Sky wrapper", async () => {
    const marketplaceRoot = join(TEST_ROOT, "legacy-direct-marketplace");
    const pluginRoot = join(marketplaceRoot, "computer-use");
    mkdirSync(pluginRoot, { recursive: true });

    const client = new FakeClient();
    client.pluginResponse = currentPluginList({ marketplacePath: marketplaceRoot, pluginPath: pluginRoot });
    client.mcpResponse = { data: [nodeReplServer(), directServer()] };
    client.toolResponses.push({ content: [{ type: "text", text: "legacy apps" }] });
    const transport = new ComputerUseTransport(client, new FakeThreads());

    const result = await transport.callTool("/work", "list_apps", {});

    expect(result.route).toBe("direct");
    expect(toolRequests(client).map((call) => call.params.server)).toEqual(["computer-use"]);
  });

  it("rejects a plugin source path that lexically escapes its marketplace", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList({ pluginPath: join(TEST_ROOT, "escaped-plugin") });
    client.mcpResponse = { data: [nodeReplServer()] };
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await expect(transport.callTool("/work", "list_apps", {})).rejects.toThrow(
      "Computer Use transport is unavailable",
    );
    expect(toolRequests(client)).toHaveLength(0);
  });

  it("rejects a plugin whose canonical root escapes its marketplace", async () => {
    const marketplaceRoot = join(TEST_ROOT, "canonical-plugin-marketplace");
    const pluginRoot = join(marketplaceRoot, "computer-use");
    const outsidePluginRoot = join(TEST_ROOT, "canonical-plugin-outside");
    const outsideWrapper = join(outsidePluginRoot, "scripts", "computer-use-client.mjs");
    mkdirSync(marketplaceRoot, { recursive: true });
    mkdirSync(dirname(outsideWrapper), { recursive: true });
    writeFileSync(outsideWrapper, "export const fixture = true;\n");
    symlinkSync(outsidePluginRoot, pluginRoot, "dir");

    const client = new FakeClient();
    client.pluginResponse = currentPluginList({ marketplacePath: marketplaceRoot, pluginPath: pluginRoot });
    client.mcpResponse = { data: [nodeReplServer(), directServer()] };
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await expect(transport.callTool("/work", "list_apps", {})).rejects.toThrow(
      "plugin canonical root escapes",
    );
    expect(toolRequests(client)).toHaveLength(0);
  });

  it("imports the canonical wrapper path when the trusted wrapper is a symlink", async () => {
    const marketplaceRoot = join(TEST_ROOT, "canonical-wrapper-marketplace");
    const pluginRoot = join(marketplaceRoot, "computer-use");
    const wrapperPath = join(pluginRoot, "scripts", "computer-use-client.mjs");
    const canonicalWrapperPath = join(pluginRoot, "scripts", "canonical-client.mjs");
    mkdirSync(dirname(wrapperPath), { recursive: true });
    writeFileSync(canonicalWrapperPath, "export const fixture = true;\n");
    symlinkSync("canonical-client.mjs", wrapperPath);

    const client = new FakeClient();
    client.pluginResponse = currentPluginList({ marketplacePath: marketplaceRoot, pluginPath: pluginRoot });
    client.mcpResponse = { data: [nodeReplServer()] };
    client.toolResponses.push(skySuccess("bootstrap"));
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await expect(transport.prepare("/work")).resolves.toBe("sky");

    const [bootstrap] = toolRequests(client);
    if (!bootstrap) throw new Error("Expected a Sky bootstrap request");
    const program = programFrom(bootstrap);
    expect(program).toContain(pathToFileURL(realpathSync(canonicalWrapperPath)).href);
    expect(program).not.toContain(pathToFileURL(wrapperPath).href);
  });

  it("rejects a wrapper whose canonical path escapes its plugin root", async () => {
    const marketplaceRoot = join(TEST_ROOT, "escaping-wrapper-marketplace");
    const pluginRoot = join(marketplaceRoot, "computer-use");
    const wrapperPath = join(pluginRoot, "scripts", "computer-use-client.mjs");
    const outsideWrapperPath = join(TEST_ROOT, "outside-computer-use-client.mjs");
    mkdirSync(dirname(wrapperPath), { recursive: true });
    writeFileSync(outsideWrapperPath, "export const fixture = true;\n");
    symlinkSync(outsideWrapperPath, wrapperPath);

    const client = new FakeClient();
    client.pluginResponse = currentPluginList({ marketplacePath: marketplaceRoot, pluginPath: pluginRoot });
    client.mcpResponse = { data: [nodeReplServer(), directServer()] };
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await expect(transport.callTool("/work", "list_apps", {})).rejects.toThrow(
      "wrapper canonical path escapes",
    );
    expect(toolRequests(client)).toHaveLength(0);
  });

  it("normalizes get_app_state into ordered text and PNG image content", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList();
    client.mcpResponse = { data: [nodeReplServer()] };
    const image = { type: "image", data: "opaque-image-data", mimeType: "image/png" };
    const dispatch = skySuccess(
      "dispatch",
      { app: "Calculator", text: "Accessible application state" },
      [image],
    );
    const meta = { source: "node_repl" };
    dispatch._meta = meta;
    client.toolResponses.push(skySuccess("bootstrap"), dispatch);
    const transport = new ComputerUseTransport(client, new FakeThreads());

    const result = await transport.callTool("/work", "get_app_state", { app: "Calculator" });

    expect(result.route).toBe("sky");
    if (!Array.isArray(result.content)) throw new Error("Expected normalized content blocks");
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "Accessible application state" });
    expect(result.content[1]).toMatchObject({
      type: "image",
      data: expect.any(String),
      mimeType: "image/png",
    });
    expect(result._meta).toBe(meta);
  });

  it("adapts string element indexes and selection names for Sky", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList();
    client.mcpResponse = { data: [nodeReplServer()] };
    client.toolResponses.push(skySuccess("bootstrap"), skySuccess("dispatch", null));
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await transport.callTool("/work", "select_text", {
      app: "TextEdit",
      element_index: "42",
      text: "needle",
      prefix: "before",
      suffix: "after",
      selection: "cursor_after",
    });

    const dispatch = toolRequests(client)[1];
    if (!dispatch) throw new Error("Expected a Sky dispatch request");
    expect(decodeSkyPayload(programFrom(dispatch))).toEqual({
      tool: "select_text",
      args: {
        app: "TextEdit",
        element_index: 42,
        text: "needle",
        prefix: "before",
        suffix: "after",
        selection_type: "cursor_after",
      },
    });
  });

  it("keeps adversarial arguments encoded while each dispatch bootstraps a fresh kernel", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList();
    client.mcpResponse = { data: [nodeReplServer()] };
    client.toolResponses.push(skySuccess("bootstrap"), skySuccess("dispatch", null));
    const transport = new ComputerUseTransport(client, new FakeThreads());
    const adversarialText = '"); globalThis.compromised = true; // ${process.env.HOME}';
    const args = { app: "TextEdit", text: adversarialText };

    await transport.callTool("/work", "type_text", args);

    const dispatch = toolRequests(client)[1];
    if (!dispatch) throw new Error("Expected a Sky dispatch request");
    const program = programFrom(dispatch);
    expect(program).not.toContain(adversarialText);
    expect(decodeSkyPayload(program)).toEqual({ tool: "type_text", args });
    expect(program).toContain('let phase = "bootstrap"');
    expect(program).toContain("await wrapper.setupComputerUseRuntime({ globals: globalThis })");
    expect(program.indexOf('phase = "dispatch"')).toBeGreaterThan(program.indexOf("setupComputerUseRuntime"));
  });

  it("preserves legacy direct calls when all ten public MCP tools are available", async () => {
    expect(COMPUTER_USE_MCP_TOOL_NAMES).toHaveLength(10);
    const client = new FakeClient();
    client.mcpResponse = { data: [directServer()] };
    const structuredContent = { clicked: true };
    const meta = { source: "direct" };
    client.toolResponses.push({
      content: [{ type: "text", text: "clicked" }],
      structuredContent,
      _meta: meta,
    });
    const transport = new ComputerUseTransport(client, new FakeThreads());
    const args = {
      app: "Calculator",
      element_index: "7",
      click_count: 2,
      mouse_button: "left",
    };

    const result = await transport.callTool("/work", "click", args);

    expect(result).toEqual({
      route: "direct",
      content: [{ type: "text", text: "clicked" }],
      structuredContent,
      _meta: meta,
    });
    const [call] = toolRequests(client);
    expect(call?.params).toMatchObject({
      server: "computer-use",
      threadId: "thread-1",
      tool: "click",
    });
    expect(call?.params.arguments).toBe(args);
  });

  it("does not select an incomplete direct server", async () => {
    const client = new FakeClient();
    client.mcpResponse = { data: [directServer(COMPUTER_USE_MCP_TOOL_NAMES.slice(0, -1))] };
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await expect(transport.callTool("/work", "list_apps", {})).rejects.toThrow(
      "Computer Use transport is unavailable",
    );
    expect(toolRequests(client)).toHaveLength(0);
  });

  it("falls back to a complete direct server when Sky bootstrap fails", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList();
    client.mcpResponse = { data: [nodeReplServer(), directServer()] };
    client.toolResponses.push(
      skyError("bootstrap", { name: "BootstrapError", message: "Sky setup failed" }),
      { content: [{ type: "text", text: "direct apps" }] },
    );
    const transport = new ComputerUseTransport(client, new FakeThreads());

    const result = await transport.callTool("/work", "list_apps", {});

    expect(result).toEqual({
      route: "direct",
      content: [{ type: "text", text: "direct apps" }],
    });
    const calls = toolRequests(client);
    expect(calls.map((call) => [call.params.server, call.params.tool])).toEqual([
      ["node_repl", "js"],
      ["computer-use", "list_apps"],
    ]);
    expect(calls[0]?.params.arguments.title).toBe("Computer Use bootstrap");
  });

  it("does not fall back when initial Sky bootstrap reports a user-stopped session", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList();
    client.mcpResponse = { data: [nodeReplServer(), directServer()] };
    client.toolResponses.push(skyError("bootstrap", {
      name: "UserStoppedSession",
      message: "Computer Use was stopped for this turn",
      code: -10012,
    }));
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await expect(transport.callTool("/work", "click", { app: "Calculator" })).rejects.toThrow(
      "Computer Use was stopped for this turn",
    );
    expect(toolRequests(client).map((call) => call.params.server)).toEqual(["node_repl"]);
  });

  it("does not reselect when a selected Sky call reports a bootstrap-phase user stop", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList();
    client.mcpResponse = { data: [nodeReplServer(), directServer()] };
    client.toolResponses.push(
      skySuccess("bootstrap"),
      skyError("bootstrap", {
        name: "UserStoppedSession",
        message: "Computer Use was stopped for this turn",
        code: -10012,
      }),
    );
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await expect(transport.callTool("/work", "click", { app: "Calculator" })).rejects.toThrow(
      "Computer Use was stopped for this turn",
    );
    expect(toolRequests(client).map((call) => call.params.server)).toEqual(["node_repl", "node_repl"]);
    expect(client.calls.filter((call) => call.method === "plugin/list")).toHaveLength(1);
  });

  it("surfaces typed Sky dispatch errors without falling back to direct", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList();
    client.mcpResponse = { data: [nodeReplServer(), directServer()] };
    client.toolResponses.push(
      skySuccess("bootstrap"),
      skyError("dispatch", {
        name: "AccessibilityError",
        message: "Invalid app",
        code: -10010,
        errorName: "InvalidApplication",
        requestType: "get_app_state",
      }),
    );
    const transport = new ComputerUseTransport(client, new FakeThreads());

    const thrown = await transport.callTool("/work", "get_app_state", { app: "Missing" }).catch((error) => error);

    expect(thrown).toBeInstanceOf(SkyComputerUseError);
    expect(thrown).toMatchObject({
      name: "AccessibilityError",
      message: "Invalid app",
      route: "sky",
      phase: "dispatch",
      code: -10010,
      errorName: "InvalidApplication",
      requestType: "get_app_state",
    });
    expect(toolRequests(client).map((call) => call.params.server)).toEqual(["node_repl", "node_repl"]);
    expect(client.calls.filter((call) => call.method === "plugin/list")).toHaveLength(1);
  });

  it("reset forces capability reselection", async () => {
    const client = new FakeClient();
    client.mcpResponse = { data: [directServer()] };
    client.toolResponses.push({ content: [{ type: "text", text: "direct" }] });
    const transport = new ComputerUseTransport(client, new FakeThreads());

    const first = await transport.callTool("/work", "list_apps", {});
    client.pluginResponse = currentPluginList();
    client.mcpResponse = { data: [nodeReplServer()] };
    client.toolResponses.push(skySuccess("bootstrap"), skySuccess("dispatch", []));
    transport.reset();
    const second = await transport.callTool("/work", "list_apps", {});

    expect(first.route).toBe("direct");
    expect(second.route).toBe("sky");
    expect(client.calls.filter((call) => call.method === "plugin/list")).toHaveLength(2);
    expect(client.calls.filter((call) => call.method === "mcpServerStatus/list")).toHaveLength(2);
    expect(toolRequests(client).map((call) => call.params.server)).toEqual([
      "computer-use",
      "node_repl",
      "node_repl",
    ]);
  });
});
