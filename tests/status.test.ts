import { afterEach, describe, expect, it, vi } from "vitest";
import { checkComputerUseStatus, evaluateComputerUseStatus, findPlugin, formatComputerUseStatus } from "../src/status";
import type { InitializeResponse, McpServerStatusListResponse, PluginListResponse, PluginSummary } from "../src/protocol";

const mockState = vi.hoisted(() => ({
  execFileError: undefined as Error | undefined,
  execFileStdout: "codex 1.2.3\n",
  accessError: undefined as Error | undefined,
  clientRequests: [] as string[],
  clientStop: vi.fn(async () => {}),
  clientRequest: undefined as ((method: string) => Promise<unknown>) | undefined,
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    callback(mockState.execFileError ?? null, { stdout: mockState.execFileStdout, stderr: "" });
  }),
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn(async () => {
    if (mockState.accessError) throw mockState.accessError;
  }),
}));

vi.mock("../src/app-server-client", () => ({
  AppServerClient: vi.fn().mockImplementation(function () {
    return {
      request: vi.fn(async (method: string) => {
        mockState.clientRequests.push(method);
        if (mockState.clientRequest) return mockState.clientRequest(method);
        if (method === "initialize") return appServer;
        if (method === "plugin/list") return plugins([{ name: "openai-bundled", plugin: plugin() }]);
        if (method === "mcpServerStatus/list") return mcp(["list_apps"]);
        throw new Error(`unexpected method ${method}`);
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

function mcp(toolNames: string[] = ["list_apps"]): McpServerStatusListResponse {
  return {
    data: [
      {
        name: "computer-use",
        authStatus: "unsupported",
        resources: [],
        resourceTemplates: [],
        tools: Object.fromEntries(toolNames.map((name) => [name, { name, inputSchema: {} }])),
      },
    ],
  };
}

afterEach(() => {
  mockState.execFileError = undefined;
  mockState.execFileStdout = "codex 1.2.3\n";
  mockState.accessError = undefined;
  mockState.clientRequests = [];
  mockState.clientRequest = undefined;
  mockState.clientStop.mockClear();
});

describe("evaluateComputerUseStatus", () => {
  it("reports codex_app_missing when app bundle missing and no marketplace has plugin", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: false,
      appServer,
      plugins: plugins([{ name: "empty" }]),
      mcp: mcp(),
    });
    expect(status.reason).toBe("codex_app_missing");
  });

  it("reports marketplace_missing when Codex.app exists but plugin is absent", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "empty" }]),
      mcp: mcp(),
    });
    expect(status.reason).toBe("marketplace_missing");
  });

  it("reports codex_app_missing before marketplace and plugin readiness checks", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: false,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: mcp(["type_text", "list_apps"]),
    });
    expect(status.reason).toBe("codex_app_missing");
  });

  it("reports plugin_not_installed", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin({ installed: false }) }]),
      mcp: mcp(),
    });
    expect(status.reason).toBe("plugin_not_installed");
  });

  it("reports plugin_disabled", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin({ enabled: false }) }]),
      mcp: mcp(),
    });
    expect(status.reason).toBe("plugin_disabled");
  });

  it("reports mcp_missing when server has no tools", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: { data: [] },
    });
    expect(status.reason).toBe("mcp_missing");
  });

  it("reports ready with sorted tool names", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: mcp(["type_text", "list_apps"]),
    });
    expect(status.reason).toBe("ready");
    expect(status.mcpServer?.toolNames).toEqual(["list_apps", "type_text"]);
  });

  it("formats status without exposing payloads", () => {
    const text = formatComputerUseStatus(evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: mcp(["list_apps"]),
    }));
    expect(text).toContain("Computer Use status: ready");
    expect(text).toContain("MCP tools: list_apps");
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
  it("returns codex_missing when codex --version fails", async () => {
    mockState.execFileError = new Error("spawn codex ENOENT");

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status.reason).toBe("codex_missing");
    expect(status.error).toBe("spawn codex ENOENT");
    expect(mockState.clientRequests).toEqual([]);
    expect(mockState.clientStop).not.toHaveBeenCalled();
  });

  it("returns check_failed when app-server calls throw and still stops the client", async () => {
    mockState.clientRequest = async (method: string) => {
      if (method === "initialize") return appServer;
      throw new Error("plugin list exploded");
    };

    const status = await checkComputerUseStatus("/tmp/project");

    expect(status.reason).toBe("check_failed");
    expect(status.codexVersion).toBe("codex 1.2.3");
    expect(status.codexAppPath).toBe("/Applications/Codex.app");
    expect(status.error).toBe("plugin list exploded");
    expect(mockState.clientRequests).toEqual(["initialize", "plugin/list"]);
    expect(mockState.clientStop).toHaveBeenCalledTimes(1);
  });
});
