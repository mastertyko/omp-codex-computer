import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkComputerUseStatus, evaluateComputerUseStatus, findPlugin, formatComputerUseStatus } from "../src/status";
import type { InitializeResponse, McpServerStatusListResponse, PluginListResponse, PluginSummary } from "../src/protocol";

const mockState = vi.hoisted(() => ({
  execFileError: undefined as Error | undefined,
  execFileStdout: "codex 1.2.3\n",
  accessError: undefined as Error | undefined,
  accessedPaths: [] as string[],
  clientEvents: [] as string[],
  clientCalls: [] as Array<{ method: string; params: unknown }>,
  clientStop: vi.fn(async () => {}),
  clientRequest: undefined as ((method: string, params: unknown) => Promise<unknown>) | undefined,
  tempRoots: [] as string[],
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    callback(mockState.execFileError ?? null, { stdout: mockState.execFileStdout, stderr: "" });
  }),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    access: vi.fn(async (path: string) => {
      mockState.accessedPaths.push(path);
      if (mockState.accessError) throw mockState.accessError;
    }),
  };
});

vi.mock("../src/app-server-client", () => ({
  AppServerClient: vi.fn().mockImplementation(function () {
    const request = vi.fn(async (method: string, params?: unknown) => {
      mockState.clientEvents.push(method);
      mockState.clientCalls.push({ method, params });
      if (mockState.clientRequest) return mockState.clientRequest(method, params);
      if (method === "initialize") return appServer;
      if (method === "plugin/list") return plugins([{ name: "openai-bundled", plugin: plugin() }]);
      if (method === "mcpServerStatus/list") return mcp();
      if (method === "thread/start") return threadStartResponse;
      throw new Error(`unexpected method ${method}`);
    });

    return {
      request,
      requestWithNotification: vi.fn(async (
        method: string,
        params: unknown,
        notificationMethod: string,
        notificationParams?: unknown,
      ) => {
        const response = await request(method, params);
        mockState.clientEvents.push(notificationMethod);
        mockState.clientCalls.push({ method: notificationMethod, params: notificationParams });
        return response;
      }),
      stop: mockState.clientStop,
    };
  }),
}));

const appServer: InitializeResponse = {
  userAgent: "test/0",
  codexHome: "/tmp/codex",
  platformFamily: "unix",
  platformOs: "macos",
};

const threadStartResponse = {
  thread: {
    id: "thread-1",
    sessionId: "session-1",
  },
};

const REQUIRED_MCP_TOOL_NAMES = [
  "list_apps",
  "get_app_state",
  "click",
  "type_text",
  "press_key",
  "scroll",
  "drag",
  "set_value",
  "select_text",
  "perform_secondary_action",
] as const;

const SKY_PLUGIN_ROOT = "/tmp/codex/plugins/computer-use";

function plugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "computer-use@openai-bundled",
    name: "computer-use",
    installed: true,
    enabled: true,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_INSTALL",
    localVersion: "1.0.0",
    ...overrides,
  };
}

function plugins(entries: Array<{ name: string; path?: string | null; plugin?: PluginSummary }>): PluginListResponse {
  return {
    marketplaces: entries.map((entry) => ({
      name: entry.name,
      path: entry.path ?? null,
      plugins: entry.plugin ? [entry.plugin] : [],
    })),
  };
}

function mcp({
  directToolNames = [...REQUIRED_MCP_TOOL_NAMES],
  nodeReplToolNames = [],
  inputSchemas = {},
}: {
  directToolNames?: string[];
  nodeReplToolNames?: string[];
  inputSchemas?: Record<string, unknown>;
} = {}): McpServerStatusListResponse {
  const server = (name: string, toolNames: string[]) => ({
    name,
    authStatus: "unsupported",
    resources: [],
    resourceTemplates: [],
    tools: Object.fromEntries(toolNames.map((toolName) => [
      toolName,
      { name: toolName, inputSchema: inputSchemas[toolName] ?? {} },
    ])),
  });

  return {
    data: [
      server("computer-use", directToolNames),
      server("node_repl", nodeReplToolNames),
    ],
  };
}

interface SkyPluginTree {
  marketplaceRoot: string;
  pluginRoot: string;
}

const WORKING_SKY = {
  target: "mac",
  list_apps: async () => [],
  get_app_state: async () => null,
  click: async () => null,
  type_text: async () => null,
  press_key: async () => null,
  scroll: async () => null,
  drag: async () => null,
  set_value: async () => null,
  select_text: async () => null,
  perform_secondary_action: async () => null,
};

const BROKEN_SKY = { target: "mac" };

async function createSkyPluginTree(): Promise<SkyPluginTree> {
  const root = await mkdtemp(join(tmpdir(), "omp-status-"));
  mockState.tempRoots.push(root);
  const marketplaceRoot = join(root, "openai-bundled");
  const pluginRoot = join(marketplaceRoot, "computer-use");
  await mkdir(pluginRoot, { recursive: true });
  return { marketplaceRoot, pluginRoot };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function runNodeReplBootstrap(params: unknown, sky: unknown = WORKING_SKY): Promise<unknown> {
  if (!isRecord(params) || !isRecord(params.arguments) || typeof params.arguments.code !== "string") {
    throw new Error("Expected a node_repl bootstrap request");
  }

  const writes: string[] = [];
  const code = params.arguments.code.replaceAll("await import(", "await dynamicImport(");
  const execute = Function(
    "nodeRepl",
    "dynamicImport",
    `return (async () => {\n${code}\n})();`,
  ) as (
    nodeRepl: { write(value: string): void },
    dynamicImport: (specifier: string) => Promise<unknown>,
  ) => Promise<void>;
  await execute(
    { write: (value) => writes.push(value) },
    (specifier) => specifier === "@oai/sky" ? Promise.resolve({ sky }) : import(specifier),
  );
  return { content: writes.map((text) => ({ type: "text", text })) };
}

function useDiscovery(
  pluginResponse: PluginListResponse,
  mcpResponse: McpServerStatusListResponse,
  toolCall: (params: unknown) => Promise<unknown> = runNodeReplBootstrap,
): void {
  mockState.clientRequest = async (method, params) => {
    if (method === "initialize") return appServer;
    if (method === "plugin/list") return pluginResponse;
    if (method === "mcpServerStatus/list") return mcpResponse;
    if (method === "thread/start") return threadStartResponse;
    if (method === "mcpServer/tool/call") return toolCall(params);
    throw new Error(`unexpected method ${method}`);
  };
}

afterEach(async () => {
  await Promise.all(mockState.tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  mockState.execFileError = undefined;
  mockState.execFileStdout = "codex 1.2.3\n";
  mockState.accessError = undefined;
  mockState.accessedPaths = [];
  mockState.clientEvents = [];
  mockState.clientCalls = [];
  mockState.clientRequest = undefined;
  mockState.tempRoots = [];
  mockState.clientStop.mockClear();
});

describe("evaluateComputerUseStatus", () => {
  it("reports marketplace_missing when no known host app path exists", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: false,
      appServer,
      plugins: plugins([{ name: "empty" }]),
      mcp: mcp(),
    });

    expect(status.reason).toBe("marketplace_missing");
    expect(status.codexAppPath).toBeUndefined();
    expect(status.mcpServer?.toolNames).toEqual([...REQUIRED_MCP_TOOL_NAMES].sort());
  });

  it("reports plugin_not_installed independently of the host app hint", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: false,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin({ installed: false }) }]),
      mcp: mcp(),
      transportError: "transport should not replace plugin diagnostics",
    });

    expect(status.reason).toBe("plugin_not_installed");
    expect(status.codexAppPath).toBeUndefined();
    expect(status.error).toBeUndefined();
  });

  it("reports plugin_disabled", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin({ enabled: false }) }]),
      mcp: mcp(),
      transportError: "transport should not replace plugin diagnostics",
    });
    expect(status.reason).toBe("plugin_disabled");
    expect(status.error).toBeUndefined();
  });

  it("reports mcp_missing when neither direct MCP nor node_repl exposes tools", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: mcp({ directToolNames: [], nodeReplToolNames: [] }),
    });

    expect(status).toMatchObject({
      reason: "mcp_missing",
      mcpServer: { name: "computer-use", toolNames: [] },
      nodeReplServer: { name: "node_repl", toolNames: [] },
      missingToolNames: [...REQUIRED_MCP_TOOL_NAMES],
      nodeReplMissingToolNames: ["js"],
    });
  });

  it("reports a transport probe error as incomplete without claiming a route", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{
        name: "openai-bundled",
        plugin: plugin({ source: { path: SKY_PLUGIN_ROOT } }),
      }]),
      mcp: mcp({ directToolNames: [], nodeReplToolNames: ["js"] }),
      transportError: "Computer Use Sky runtime is missing list_apps",
    });

    expect(status).toMatchObject({
      reason: "mcp_incomplete",
      error: "Computer Use Sky runtime is missing list_apps",
      mcpServer: { name: "computer-use", toolNames: [] },
      nodeReplServer: { name: "node_repl", toolNames: ["js"] },
    });
    expect(status.transportRoute).toBeUndefined();
  });

  it("does not infer Sky readiness from capabilities alone", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: false,
      appServer,
      plugins: plugins([{
        name: "openai-bundled",
        path: "/tmp/codex/plugins",
        plugin: plugin({ source: { path: SKY_PLUGIN_ROOT } }),
      }]),
      mcp: mcp({ directToolNames: [], nodeReplToolNames: ["js"] }),
    });

    expect(status).toMatchObject({
      reason: "mcp_incomplete",
      codexAppPath: undefined,
      mcpServer: { name: "computer-use", toolNames: [] },
      nodeReplServer: { name: "node_repl", toolNames: ["js"] },
    });
    expect(status.transportRoute).toBeUndefined();
    expect(status.message).toContain("no transport route was observed");
  });

  it("reports ready via Sky only when the route was observed", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: false,
      appServer,
      plugins: plugins([{
        name: "openai-bundled",
        plugin: plugin({ source: { path: SKY_PLUGIN_ROOT } }),
      }]),
      mcp: mcp({ directToolNames: [], nodeReplToolNames: ["js"] }),
      transportRoute: "sky",
    });

    expect(status).toMatchObject({
      reason: "ready",
      transportRoute: "sky",
      codexAppPath: undefined,
      mcpServer: { name: "computer-use", toolNames: [] },
      nodeReplServer: { name: "node_repl", toolNames: ["js"] },
    });
    expect(status.message).toContain("via Sky/node_repl");
    expect(status.missingToolNames).toBeUndefined();
    expect(status.nodeReplMissingToolNames).toBeUndefined();
  });

  it("does not infer direct readiness from a complete capability listing", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: mcp({ directToolNames: [...REQUIRED_MCP_TOOL_NAMES] }),
    });

    expect(status.reason).toBe("mcp_incomplete");
    expect(status.transportRoute).toBeUndefined();
    expect(status.message).toContain("no transport route was observed");
  });

  it("reports ready via direct MCP when all ten direct tools exist", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: mcp({ directToolNames: [...REQUIRED_MCP_TOOL_NAMES] }),
      transportRoute: "direct",
    });

    expect(REQUIRED_MCP_TOOL_NAMES).toHaveLength(10);
    expect(status).toMatchObject({
      reason: "ready",
      transportRoute: "direct",
      mcpServer: {
        name: "computer-use",
        toolNames: [...REQUIRED_MCP_TOOL_NAMES].sort(),
      },
      nodeReplServer: { name: "node_repl", toolNames: [] },
    });
    expect(status.message).toContain("via direct MCP");
    expect(status.missingToolNames).toBeUndefined();
  });

  it("keeps direct readiness and surfaces extra direct MCP tools separately", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: mcp({ directToolNames: [...REQUIRED_MCP_TOOL_NAMES, "debug_tool"] }),
      transportRoute: "direct",
    });

    expect(status).toMatchObject({
      reason: "ready",
      transportRoute: "direct",
      extraToolNames: ["debug_tool"],
    });
    expect(status.mcpServer?.toolNames).toEqual([...REQUIRED_MCP_TOOL_NAMES, "debug_tool"].sort());
  });

  it("formats route, direct MCP, node_repl, and non-authoritative host hints", () => {
    const text = formatComputerUseStatus(evaluateComputerUseStatus({
      codexAppExists: false,
      appServer,
      plugins: plugins([{
        name: "openai-bundled",
        plugin: plugin({ source: { path: SKY_PLUGIN_ROOT } }),
      }]),
      mcp: mcp({ directToolNames: [], nodeReplToolNames: ["js"] }),
      transportRoute: "sky",
    }));

    expect(text).toContain("Computer Use status: ready");
    expect(text).toContain("Host app hint: none found at known paths (non-authoritative)");
    expect(text).toContain("Transport route: sky (Sky/node_repl)");
    expect(text).toContain("Direct MCP server: computer-use");
    expect(text).toContain("Direct MCP tools: none");
    expect(text).toContain("node_repl server: node_repl");
    expect(text).toContain("node_repl tools: js");
  });

  it("formats both incomplete tool sets without exposing tool schemas", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: mcp({
        directToolNames: ["list_apps", "click"],
        nodeReplToolNames: ["inspect"],
        inputSchemas: {
          list_apps: { secretToken: "list-secret" },
          click: { traceId: "click-secret" },
          inspect: { privateSchema: "node-repl-secret" },
        },
      }),
    });
    const text = formatComputerUseStatus(status);

    expect(status).toMatchObject({
      reason: "mcp_incomplete",
      mcpServer: { name: "computer-use", toolNames: ["click", "list_apps"] },
      nodeReplServer: { name: "node_repl", toolNames: ["inspect"] },
      missingToolNames: [
        "get_app_state",
        "type_text",
        "press_key",
        "scroll",
        "drag",
        "set_value",
        "select_text",
        "perform_secondary_action",
      ],
      nodeReplMissingToolNames: ["js"],
    });
    expect(text).toContain("Computer Use status: mcp_incomplete");
    expect(text).toContain("Direct MCP tools: click, list_apps");
    expect(text).toContain("node_repl tools: inspect");
    expect(text).toContain("Missing direct MCP tools: get_app_state, type_text, press_key, scroll, drag, set_value, select_text, perform_secondary_action");
    expect(text).toContain("Missing node_repl tools: js");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("inputSchema");
  });

  it("formats additional direct MCP tools on a dedicated line", () => {
    const text = formatComputerUseStatus(evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: mcp({ directToolNames: [...REQUIRED_MCP_TOOL_NAMES, "debug_tool"] }),
      transportRoute: "direct",
    }));

    expect(text).toContain("Direct MCP tools: click, debug_tool, drag, get_app_state, list_apps, perform_secondary_action, press_key, scroll, select_text, set_value, type_text");
    expect(text).toContain("Additional upstream MCP tools not exposed by adapter: debug_tool");
  });
});

describe("findPlugin", () => {
  it("prefers openai-bundled over other marketplaces", () => {
    const bundled = plugin({ id: "bundled" });
    const curated = plugin({ id: "curated" });
    const match = findPlugin(plugins([
      { name: "openai-curated", plugin: curated },
      { name: "openai-bundled", plugin: bundled },
    ]), "computer-use");

    expect(match?.plugin.id).toBe("bundled");
  });
});

describe("checkComputerUseStatus", () => {
  it("returns codex_missing without starting app-server when codex --version fails", async () => {
    mockState.execFileError = new Error("spawn codex ENOENT");

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status.reason).toBe("codex_missing");
    expect(status.error).toBe("spawn codex ENOENT");
    expect(mockState.accessedPaths).toEqual([]);
    expect(mockState.clientEvents).toEqual([]);
    expect(mockState.clientStop).not.toHaveBeenCalled();
  });

  it("notifies initialized before discovery and treats missing host paths as hints", async () => {
    mockState.accessError = new Error("ENOENT");

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status).toMatchObject({
      reason: "ready",
      transportRoute: "direct",
      codexAppPath: undefined,
      mcpServer: {
        name: "computer-use",
        toolNames: [...REQUIRED_MCP_TOOL_NAMES].sort(),
      },
    });
    expect(mockState.accessedPaths).toEqual([
      "/Applications/Codex.app",
      "/Applications/ChatGPT.app",
    ]);
    expect(mockState.clientEvents).toEqual([
      "initialize",
      "initialized",
      "plugin/list",
      "mcpServerStatus/list",
    ]);
    expect(mockState.clientCalls.slice(0, 2)).toEqual([
      {
        method: "initialize",
        params: {
          clientInfo: { name: "omp-codex-computer", version: "0.1.1" },
          capabilities: { experimentalApi: true },
        },
      },
      { method: "initialized", params: undefined },
    ]);
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });

  it("starts plugin and MCP status discovery concurrently after initialization", async () => {
    const pluginDiscovery = Promise.withResolvers<PluginListResponse>();
    const mcpDiscovery = Promise.withResolvers<McpServerStatusListResponse>();
    mockState.clientRequest = async (method) => {
      if (method === "initialize") return appServer;
      if (method === "plugin/list") return pluginDiscovery.promise;
      if (method === "mcpServerStatus/list") return mcpDiscovery.promise;
      throw new Error(`unexpected method ${method}`);
    };

    const statusPromise = checkComputerUseStatus("/tmp/project");
    await vi.waitFor(() => expect(mockState.clientEvents).toContain("plugin/list"));

    expect(mockState.clientEvents).toContain("mcpServerStatus/list");
    pluginDiscovery.resolve(plugins([{ name: "openai-bundled", plugin: plugin() }]));
    mcpDiscovery.resolve(mcp());
    await expect(statusPromise).resolves.toMatchObject({ reason: "ready", transportRoute: "direct" });
  });

  it("observes Sky through thread creation and a real @oai/sky bootstrap without exposing probe payloads", async () => {
    const tree = await createSkyPluginTree();
    const pluginResponse = plugins([{
      name: "openai-bundled",
      path: tree.marketplaceRoot,
      plugin: plugin({ source: { path: tree.pluginRoot } }),
    }]);
    const mcpResponse = mcp({
      directToolNames: [],
      nodeReplToolNames: ["js"],
      inputSchemas: { js: { privateSchema: "node-repl-schema-secret" } },
    });
    useDiscovery(pluginResponse, mcpResponse);

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status).toMatchObject({
      reason: "ready",
      transportRoute: "sky",
      marketplace: { name: "openai-bundled", path: tree.marketplaceRoot },
      nodeReplServer: { name: "node_repl", toolNames: ["js"] },
    });
    expect(mockState.clientEvents).toEqual([
      "initialize",
      "initialized",
      "plugin/list",
      "mcpServerStatus/list",
      "thread/start",
      "mcpServer/tool/call",
    ]);

    const threadCall = mockState.clientCalls.find((call) => call.method === "thread/start");
    expect(threadCall?.params).toEqual({ cwd: "/tmp/project", ephemeral: true });
    const bootstrapCall = mockState.clientCalls.find((call) => call.method === "mcpServer/tool/call");
    expect(bootstrapCall?.params).toMatchObject({
      server: "node_repl",
      threadId: "thread-1",
      tool: "js",
      arguments: {
        title: "Computer Use bootstrap",
        timeout_ms: 120_000,
      },
    });
    if (!isRecord(bootstrapCall?.params) || !isRecord(bootstrapCall.params.arguments)) {
      throw new Error("Expected recorded node_repl bootstrap parameters");
    }
    const bootstrapCode = bootstrapCall.params.arguments.code;
    expect(bootstrapCode).toEqual(expect.any(String));
    expect(bootstrapCode).not.toContain("node-repl-schema-secret");
    expect(bootstrapCode).toContain('await import("@oai/sky")');

    const payload = JSON.stringify(status);
    expect(payload).not.toContain("node-repl-schema-secret");
    expect(payload).not.toContain("Computer Use bootstrap");
    expect(payload).not.toContain("@oai/sky");
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });

  it("sanitizes probe errors without exposing attached schema or payload data", async () => {
    const tree = await createSkyPluginTree();
    const probeError = Object.assign(new Error("node_repl bootstrap failed\nwithout a route"), {
      data: {
        privateSchema: "attached-schema-secret",
        payload: "attached-payload-secret",
      },
    });
    useDiscovery(
      plugins([{
        name: "openai-bundled",
        path: tree.marketplaceRoot,
        plugin: plugin({ source: { path: tree.pluginRoot } }),
      }]),
      mcp({ directToolNames: [], nodeReplToolNames: ["js"] }),
      async () => {
        throw probeError;
      },
    );

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status).toMatchObject({
      reason: "mcp_incomplete",
      error: "node_repl bootstrap failed without a route",
    });
    expect(status.transportRoute).toBeUndefined();
    const payload = JSON.stringify(status);
    expect(payload).not.toContain("attached-schema-secret");
    expect(payload).not.toContain("attached-payload-secret");
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });

  it("does not claim readiness when the observed Sky package bootstrap fails", async () => {
    const tree = await createSkyPluginTree();
    useDiscovery(
      plugins([{
        name: "openai-bundled",
        path: tree.marketplaceRoot,
        plugin: plugin({ source: { path: tree.pluginRoot } }),
      }]),
      mcp({ directToolNames: [], nodeReplToolNames: ["js"] }),
      (params) => runNodeReplBootstrap(params, BROKEN_SKY),
    );

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status).toMatchObject({
      reason: "mcp_incomplete",
      error: "Computer Use Sky runtime is missing list_apps",
      nodeReplServer: { name: "node_repl", toolNames: ["js"] },
    });
    expect(status.transportRoute).toBeUndefined();
    expect(mockState.clientEvents).toEqual([
      "initialize",
      "initialized",
      "plugin/list",
      "mcpServerStatus/list",
      "thread/start",
      "mcpServer/tool/call",
    ]);
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });

  it("reports an observed direct fallback when Sky bootstrap fails", async () => {
    const tree = await createSkyPluginTree();
    useDiscovery(
      plugins([{
        name: "openai-bundled",
        path: tree.marketplaceRoot,
        plugin: plugin({ source: { path: tree.pluginRoot } }),
      }]),
      mcp({
        directToolNames: [...REQUIRED_MCP_TOOL_NAMES],
        nodeReplToolNames: ["js"],
      }),
      (params) => runNodeReplBootstrap(params, BROKEN_SKY),
    );

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status).toMatchObject({
      reason: "ready",
      transportRoute: "direct",
      mcpServer: {
        name: "computer-use",
        toolNames: [...REQUIRED_MCP_TOOL_NAMES].sort(),
      },
    });
    expect(status.error).toBeUndefined();
    expect(mockState.clientEvents).toEqual([
      "initialize",
      "initialized",
      "plugin/list",
      "mcpServerStatus/list",
      "thread/start",
      "mcpServer/tool/call",
    ]);
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });

  it("returns check_failed when initialize fails before initialized", async () => {
    mockState.clientRequest = async (method) => {
      if (method === "initialize") throw new Error("initialize exploded");
      throw new Error(`unexpected method ${method}`);
    };

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status).toMatchObject({
      reason: "check_failed",
      error: "initialize exploded",
    });
    expect(mockState.clientEvents).toEqual(["initialize"]);
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });

  it("returns check_failed when discovery throws and still stops the client", async () => {
    mockState.clientRequest = async (method: string) => {
      if (method === "initialize") return appServer;
      throw new Error("plugin list exploded");
    };

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status.reason).toBe("check_failed");
    expect(status.codexVersion).toBe("codex 1.2.3");
    expect(status.codexAppPath).toBe("/Applications/Codex.app");
    expect(status.error).toBe("plugin list exploded");
    expect(mockState.clientEvents).toEqual([
      "initialize",
      "initialized",
      "plugin/list",
      "mcpServerStatus/list",
    ]);
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });
});
