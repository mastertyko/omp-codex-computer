import { afterEach, describe, expect, it, vi } from "vitest";
import { checkComputerUseStatus, evaluateComputerUseStatus, formatComputerUseStatus } from "../src/status";
import type { InitializeResponse, McpServerStatusListResponse } from "../src/protocol";

const mockState = vi.hoisted(() => ({
  execFileError: undefined as Error | undefined,
  execFileStdout: "codex 1.2.3\n",
  clientEvents: [] as string[],
  clientRequests: [] as Array<{ method: string; params: unknown }>,
  clientNotifications: [] as Array<{ method: string; params: unknown }>,
  clientStop: vi.fn(async () => {}),
  clientRequest: undefined as ((method: string, params: unknown) => Promise<unknown>) | undefined,
  clientNotify: undefined as ((method: string, params: unknown) => Promise<void>) | undefined,
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    callback(mockState.execFileError ?? null, { stdout: mockState.execFileStdout, stderr: "" });
  }),
}));

vi.mock("../src/app-server-client", () => ({
  AppServerClient: vi.fn().mockImplementation(function () {
    return {
      request: vi.fn(async (method: string, params: unknown) => {
        mockState.clientEvents.push(`request:${method}`);
        mockState.clientRequests.push({ method, params });
        if (mockState.clientRequest) return mockState.clientRequest(method, params);
        if (method === "initialize") return appServer;
        if (method === "plugin/list") return pluginList;
        if (method === "thread/start") return threadStartResponse;
        if (method === "mcpServerStatus/list") return mcp();
        throw new Error(`unexpected method ${method}`);
      }),
      notify: vi.fn(async (method: string, params: unknown) => {
        mockState.clientEvents.push(`notify:${method}`);
        mockState.clientNotifications.push({ method, params });
        if (mockState.clientNotify) await mockState.clientNotify(method, params);
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

const pluginRoot = "/tmp/computer-use";
const pluginList = {
  marketplaces: [{
    name: "openai-bundled",
    plugins: [{
      id: "computer-use@openai-bundled",
      installed: true,
      enabled: true,
      source: { type: "local", path: pluginRoot },
    }],
  }],
};
const threadStartResponse = {
  thread: {
    id: "thread-status",
    sessionId: "session-status",
    status: {},
    cwd: "/tmp/project",
    ephemeral: true,
  },
  model: "test",
  modelProvider: "test",
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

function mcp(
  toolNames: string[] = [...REQUIRED_MCP_TOOL_NAMES],
  inputSchemas: Record<string, unknown> = {},
): McpServerStatusListResponse {
  return {
    data: [
      {
        name: "computer-use",
        authStatus: "unsupported",
        resources: [],
        resourceTemplates: [],
        tools: Object.fromEntries(toolNames.map((name) => [name, { name, inputSchema: inputSchemas[name] ?? {} }])),
      },
    ],
    nextCursor: null,
  };
}

afterEach(() => {
  mockState.execFileError = undefined;
  mockState.execFileStdout = "codex 1.2.3\n";
  mockState.clientEvents = [];
  mockState.clientRequests = [];
  mockState.clientNotifications = [];
  mockState.clientRequest = undefined;
  mockState.clientNotify = undefined;
  mockState.clientStop.mockClear();
});

describe("evaluateComputerUseStatus", () => {
  it("reports mcp_missing when the server is unavailable", () => {
    const status = evaluateComputerUseStatus({ appServer, mcp: { data: [] } });

    expect(status.reason).toBe("mcp_missing");
  });

  it("reports ready only when every required MCP tool is present", () => {
    const status = evaluateComputerUseStatus({ appServer, mcp: mcp() });

    expect(status.reason).toBe("ready");
    expect(status.mcpServer?.toolNames).toEqual([...REQUIRED_MCP_TOOL_NAMES].sort());
    expect(status.missingToolNames).toBeUndefined();
  });

  it("keeps ready status and surfaces extra MCP tools separately", () => {
    const status = evaluateComputerUseStatus({
      appServer,
      mcp: mcp([...REQUIRED_MCP_TOOL_NAMES, "debug_tool"]),
    });

    expect(status).toMatchObject({ reason: "ready", extraToolNames: ["debug_tool"] });
    expect(status.mcpServer?.toolNames).toEqual([...REQUIRED_MCP_TOOL_NAMES, "debug_tool"].sort());
    expect(status.missingToolNames).toBeUndefined();
  });

  it("formats MCP readiness without legacy app or plugin fields", () => {
    const text = formatComputerUseStatus(evaluateComputerUseStatus({
      appServer,
      mcp: mcp([...REQUIRED_MCP_TOOL_NAMES, "debug_tool"]),
    }));

    expect(text).toContain("Computer Use status: ready");
    expect(text).toContain("MCP tools: click, debug_tool, drag, get_app_state, list_apps, perform_secondary_action, press_key, scroll, select_text, set_value, type_text");
    expect(text).toContain("Additional upstream MCP tools not exposed by adapter: debug_tool");
    expect(text).not.toContain("Codex.app");
    expect(text).not.toContain("Plugin:");
  });

  it("reports mcp_incomplete with missing tool names for partial MCP exposure", () => {
    const exposedToolNames = [...REQUIRED_MCP_TOOL_NAMES.slice(0, 3)];
    const status = evaluateComputerUseStatus({ appServer, mcp: mcp(exposedToolNames) });

    expect(status.reason).toBe("mcp_incomplete");
    expect(status.mcpServer?.toolNames).toEqual([...exposedToolNames].sort());
    expect(status.missingToolNames).toEqual([...REQUIRED_MCP_TOOL_NAMES.slice(3)]);
  });

  it("formats missing MCP tool names without exposing tool payloads", () => {
    const text = formatComputerUseStatus(evaluateComputerUseStatus({
      appServer,
      mcp: mcp(["list_apps", "click"], {
        list_apps: { secretToken: "list-secret" },
        click: { traceId: "click-secret" },
      }),
    }));

    expect(text).toContain("Computer Use status: mcp_incomplete");
    expect(text).toContain("MCP tools: click, list_apps");
    expect(text).toContain("Missing MCP tools: get_app_state, type_text, press_key, scroll, drag, set_value, select_text, perform_secondary_action");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("inputSchema");
  });
});


describe("checkComputerUseStatus", () => {
  it("returns codex_missing when codex --version fails", async () => {
    mockState.execFileError = new Error("spawn codex ENOENT");

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status.reason).toBe("codex_missing");
    expect(status.error).toBe("spawn codex ENOENT");
    expect(mockState.clientEvents).toEqual([]);
    expect(mockState.clientStop).not.toHaveBeenCalled();
  });

  it("checks the same thread-scoped MCP configuration used by tool calls", async () => {
    const status = await checkComputerUseStatus("/tmp/project");

    expect(status.reason).toBe("ready");
    expect(status.mcpServer?.toolNames).toEqual([...REQUIRED_MCP_TOOL_NAMES].sort());
    expect(mockState.clientEvents).toEqual([
      "request:initialize",
      "notify:initialized",
      "request:plugin/list",
      "request:thread/start",
      "request:mcpServerStatus/list",
    ]);
    expect(mockState.clientRequests[2]).toEqual({
      method: "thread/start",
      params: {
        cwd: "/tmp/project",
        ephemeral: true,
        config: {
          "mcp_servers.computer-use.enabled": true,
          "mcp_servers.computer-use.cwd": pluginRoot,
        },
      },
    });
    expect(mockState.clientRequests[3]).toEqual({
      method: "mcpServerStatus/list",
      params: { threadId: "thread-status" },
    });
    expect(mockState.clientNotifications).toEqual([{ method: "initialized", params: undefined }]);
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });

  it("follows every thread-scoped MCP status page before evaluating readiness", async () => {
    let page = 0;
    mockState.clientRequest = async (method: string) => {
      if (method === "initialize") return appServer;
      if (method === "plugin/list") return pluginList;
      if (method === "thread/start") return threadStartResponse;
      if (method !== "mcpServerStatus/list") throw new Error(`unexpected method ${method}`);
      page++;
      return page === 1 ? { data: [], nextCursor: "page-2" } : mcp();
    };

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status.reason).toBe("ready");
    expect(mockState.clientRequests.slice(3)).toEqual([
      { method: "mcpServerStatus/list", params: { threadId: "thread-status" } },
      { method: "mcpServerStatus/list", params: { threadId: "thread-status", cursor: "page-2" } },
    ]);
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });

  it("returns check_failed when MCP discovery throws and still stops the client", async () => {
    mockState.clientRequest = async (method: string) => {
      if (method === "initialize") return appServer;
      if (method === "plugin/list") return pluginList;
      if (method === "thread/start") return threadStartResponse;
      throw new Error("MCP status exploded");
    };

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status.reason).toBe("check_failed");
    expect(status.codexVersion).toBe("codex 1.2.3");
    expect(status.error).toBe("MCP status exploded");
    expect(status).not.toHaveProperty("codexAppPath");
    expect(mockState.clientEvents).toEqual([
      "request:initialize",
      "notify:initialized",
      "request:plugin/list",
      "request:thread/start",
      "request:mcpServerStatus/list",
    ]);
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });

  it("returns check_failed when the initialized notification fails", async () => {
    mockState.clientNotify = async () => {
      throw new Error("notification failed");
    };

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status.reason).toBe("check_failed");
    expect(status.error).toBe("notification failed");
    expect(mockState.clientEvents).toEqual(["request:initialize", "notify:initialized"]);
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });
});
