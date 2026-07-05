import { describe, expect, it } from "vitest";
import { evaluateComputerUseStatus, findPlugin, formatComputerUseStatus } from "../src/status";
import type { InitializeResponse, McpServerStatusListResponse, PluginListResponse, PluginSummary } from "../src/protocol";

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
