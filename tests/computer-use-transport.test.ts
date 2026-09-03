import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

mkdirSync(MARKETPLACE_ROOT, { recursive: true });
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
  pluginResponse: PluginListResponse | Promise<PluginListResponse> = currentPluginList();
  mcpResponse: McpServerStatusListResponse | Promise<McpServerStatusListResponse> = { data: [] };

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

    if (method === "plugin/list") return await this.pluginResponse as unknown as TResult;
    if (method === "mcpServerStatus/list") return await this.mcpResponse as unknown as TResult;
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
  includePluginSource?: boolean;
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
            ...(options.includePluginSource === false ? {} : { source: { path: options.pluginPath ?? PLUGIN_ROOT } }),
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
    const apps = [{
      id: "com.apple.Calculator",
      displayName: "Calculator",
      isRunning: true,
      lastUsedDate: 809_049_600,
      useCount: 42,
    }];
    const modelVisibleApps = [{ id: "com.apple.Calculator", displayName: "Calculator", isRunning: true }];
    client.toolResponses.push(skySuccess("bootstrap"), skySuccess("dispatch", apps));
    const transport = new ComputerUseTransport(client, new FakeThreads());
    const controller = new AbortController();

    const result = await transport.callTool("/work", "list_apps", {}, controller.signal);

    expect(result).toEqual({
      route: "sky",
      content: [{ type: "text", text: JSON.stringify(modelVisibleApps, null, 2) }],
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
    expect(programFrom(bootstrap)).toContain('await import("@oai/sky")');
    expect(programFrom(bootstrap)).not.toContain("computer-use-client.mjs");
    expect(decodeSkyPayload(programFrom(dispatch))).toEqual({ tool: "list_apps", args: {} });
  });

  it("selects Sky from the app-server 0.151.0 mcpServerStatus/list shape", async () => {
    // Mirrors a live 0.151.0 `node_repl` entry: additive `runtimeStatus`
    // (nullable) plus `pluginId`/`serverInfo` and the current tool set. The
    // intersection keeps `McpServerStatus` as the consumed subset while the
    // fixture carries the upstream fields route selection must ignore.
    const client = new FakeClient();
    const nodeRepl: McpServerStatus & { runtimeStatus: null; pluginId: null; serverInfo: Record<string, unknown> } = {
      ...server("node_repl", ["js", "js_add_node_module_dir", "js_reset", "turn_ended"]),
      authStatus: "unsupported",
      runtimeStatus: null,
      pluginId: null,
      serverInfo: { name: "rmcp", title: null, version: "1.5.0", description: null, icons: null, websiteUrl: null },
    };
    client.mcpResponse = { data: [nodeRepl] };
    client.toolResponses.push(skySuccess("bootstrap"));
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await expect(transport.prepare("/work")).resolves.toBe("sky");

    const [bootstrap] = toolRequests(client);
    expect(bootstrap?.params).toMatchObject({ server: "node_repl", tool: "js" });
  });

  it("starts plugin and MCP discovery concurrently", async () => {
    const client = new FakeClient();
    const pluginDiscovery = Promise.withResolvers<PluginListResponse>();
    const mcpDiscovery = Promise.withResolvers<McpServerStatusListResponse>();
    client.pluginResponse = pluginDiscovery.promise;
    client.mcpResponse = mcpDiscovery.promise;
    client.toolResponses.push({ content: [{ type: "text", text: "apps" }] });
    const transport = new ComputerUseTransport(client, new FakeThreads());

    const resultPromise = transport.callTool("/work", "list_apps", {});
    await Promise.resolve();

    expect(client.calls.map((call) => call.method)).toEqual([
      "plugin/list",
      "mcpServerStatus/list",
    ]);

    pluginDiscovery.resolve(currentPluginList());
    mcpDiscovery.resolve({ data: [directServer()] });
    await expect(resultPromise).resolves.toMatchObject({ route: "direct" });
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

  it("uses the bundled Sky package when the current plugin has no wrapper asset", async () => {
    const marketplaceRoot = join(TEST_ROOT, "current-node-repl-marketplace");
    const pluginRoot = join(marketplaceRoot, "computer-use");
    mkdirSync(pluginRoot, { recursive: true });

    const client = new FakeClient();
    client.pluginResponse = currentPluginList({ marketplacePath: marketplaceRoot, pluginPath: pluginRoot });
    client.mcpResponse = { data: [nodeReplServer()] };
    client.toolResponses.push(skySuccess("bootstrap"));
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await expect(transport.prepare("/work")).resolves.toBe("sky");

    const [bootstrap] = toolRequests(client);
    if (!bootstrap) throw new Error("Expected a Sky bootstrap request");
    expect(programFrom(bootstrap)).toContain('await import("@oai/sky")');
    expect(programFrom(bootstrap)).not.toContain("computer-use-client.mjs");
  });

  it("does not require a plugin source path for the current Sky route", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList({ includePluginSource: false });
    client.mcpResponse = { data: [nodeReplServer()] };
    client.toolResponses.push(skySuccess("bootstrap"));
    const transport = new ComputerUseTransport(client, new FakeThreads());

    await expect(transport.prepare("/work")).resolves.toBe("sky");
    expect(toolRequests(client)).toHaveLength(1);
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

    const result = await transport.callTool("/work", "get_app_state", {
      app: "Calculator",
      disableDiff: true,
    });

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
    const getAppStateDispatch = toolRequests(client)[1];
    if (!getAppStateDispatch) throw new Error("Expected a Sky dispatch request");
    expect(decodeSkyPayload(programFrom(getAppStateDispatch))).toEqual({
      tool: "get_app_state",
      args: { app: "Calculator", disableDiff: true },
    });
  });

  it("sniffs local Sky screenshot bytes before emitting image content", async () => {
    const marketplaceRoot = join(TEST_ROOT, "screenshot-mime-marketplace");
    const pluginRoot = join(marketplaceRoot, "computer-use");
    mkdirSync(marketplaceRoot, { recursive: true });
    const sky = Object.fromEntries(
      COMPUTER_USE_MCP_TOOL_NAMES.map((toolName) => [toolName, async () => null]),
    ) as Record<string, unknown>;
    sky.target = "mac";
    sky.get_app_state = async (args: { app: string }) => ({
      app: "Fixture",
      text: "Accessible application state",
      screenshot: { url: args.app },
    });

    const executeCase = async (fileName: string, bytes: Buffer) => {
      const screenshotPath = join(marketplaceRoot, fileName);
      writeFileSync(screenshotPath, bytes);
      const client = new FakeClient();
      client.pluginResponse = currentPluginList({ marketplacePath: marketplaceRoot, pluginPath: pluginRoot });
      client.mcpResponse = { data: [nodeReplServer()] };
      client.toolResponses.push(
        skySuccess("bootstrap"),
        skySuccess("dispatch", { app: "Fixture", text: "Accessible application state" }),
      );
      const transport = new ComputerUseTransport(client, new FakeThreads());
      await transport.callTool("/work", "get_app_state", { app: pathToFileURL(screenshotPath).href });

      const dispatch = toolRequests(client)[1];
      if (!dispatch) throw new Error("Expected a Sky dispatch request");
      const emitted: unknown[] = [];
      const envelopes: unknown[] = [];
      const nodeRepl = {
        emitImage: async (image: unknown) => { emitted.push(image); },
        write: (value: string) => { envelopes.push(JSON.parse(value)); },
      };
      const fixtureKey = "__ompComputerUseNodeReplFixture";
      const programPath = join(marketplaceRoot, `${fileName}.program.mjs`);
      const executableProgram = programFrom(dispatch).replace(
        'await import("@oai/sky")',
        'await dynamicImport("@oai/sky")',
      );
      writeFileSync(
        programPath,
        `const fixture = Reflect.get(globalThis, ${JSON.stringify(fixtureKey)});\nconst nodeRepl = fixture.nodeRepl;\nconst dynamicImport = async (specifier) => specifier === "@oai/sky" ? { sky: fixture.sky } : import(specifier);\n${executableProgram}\n`,
      );
      Reflect.set(globalThis, fixtureKey, { nodeRepl, sky });
      try {
        await import(pathToFileURL(programPath).href);
      } finally {
        Reflect.deleteProperty(globalThis, fixtureKey);
      }
      return { emitted, envelopes };
    };

    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const jpeg = await executeCase("fixture.jpg", jpegBytes);
    expect(jpeg.emitted).toHaveLength(1);
    expect(jpeg.emitted[0]).toMatchObject({ bytes: jpegBytes, mimeType: "image/jpeg" });

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const png = await executeCase("fixture.png", pngBytes);
    expect(png.emitted).toHaveLength(1);
    expect(png.emitted[0]).toMatchObject({ bytes: pngBytes, mimeType: "image/png" });

    const unsupported = await executeCase("fixture.bin", Buffer.from("not an image"));
    expect(unsupported.emitted).toEqual([]);
    expect(unsupported.envelopes.at(-1)).toMatchObject({
      ok: true,
      phase: "dispatch",
      warning: "Warning: Computer Use returned a screenshot that could not be read.",
    });
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
    expect(program).toContain('const skyModule = await import("@oai/sky")');
    expect(program.indexOf('phase = "dispatch"')).toBeGreaterThan(program.indexOf('await import("@oai/sky")'));
  });

  it("preserves legacy direct calls when all eleven public MCP tools are available", async () => {
    expect(COMPUTER_USE_MCP_TOOL_NAMES).toHaveLength(11);
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
