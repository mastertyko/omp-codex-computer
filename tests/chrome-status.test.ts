import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkChromeStatus, formatChromeStatus } from "../src/chrome-status";
import type {
  InitializeResponse,
  McpServerStatus,
  McpServerStatusListResponse,
  PluginListResponse,
  PluginSummary,
} from "../src/protocol";

const CHROME_VERSION = "26.818.31338";
const APP_SERVER_VERSION = "0.149.0";

const mockState = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; params: unknown }>,
  clientOptions: [] as unknown[],
  stop: vi.fn(async () => {}),
  initializeResponse: undefined as InitializeResponse | undefined,
  pluginResponse: undefined as PluginListResponse | undefined,
  mcpResponse: undefined as McpServerStatusListResponse | undefined,
  failureMethod: undefined as string | undefined,
  failure: undefined as Error | undefined,
}));

vi.mock("../src/app-server-client", () => ({
  AppServerClient: vi.fn().mockImplementation(function (options: unknown) {
    mockState.clientOptions.push(options);

    const request = async (method: string, params?: unknown): Promise<unknown> => {
      mockState.calls.push({ method, params });
      if (mockState.failureMethod === method) {
        throw mockState.failure ?? new Error("status request failed");
      }
      if (method === "initialize") return mockState.initializeResponse;
      if (method === "plugin/list") return mockState.pluginResponse;
      if (method === "mcpServerStatus/list") return mockState.mcpResponse;
      throw new Error(`unexpected method ${method}`);
    };

    return {
      request: vi.fn(request),
      requestWithNotification: vi.fn(async (
        method: string,
        params: unknown,
        notificationMethod: string,
        notificationParams?: unknown,
      ) => {
        const response = await request(method, params);
        mockState.calls.push({ method: notificationMethod, params: notificationParams });
        return response;
      }),
      stop: mockState.stop,
    };
  }),
}));

let pluginRoot: string | undefined;

function initialize(version = APP_SERVER_VERSION): InitializeResponse {
  return {
    userAgent: `omp-codex-computer/${version} (Mac OS 27.0.0; arm64)`,
    codexHome: "/private/upstream-codex-home",
    platformFamily: "unix",
    platformOs: "macos",
  };
}

function plugin(root: string, overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "chrome@openai-bundled",
    name: "chrome",
    installed: true,
    enabled: true,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_INSTALL",
    availability: "AVAILABLE",
    localVersion: CHROME_VERSION,
    source: { type: "local", path: root },
    ...overrides,
  };
}

function plugins(root: string, overrides: Partial<PluginSummary> = {}): PluginListResponse {
  return {
    marketplaces: [{
      name: "openai-bundled",
      path: "/private/marketplace-path-that-must-not-leak",
      plugins: [plugin(root, overrides)],
    }],
  };
}

function server(name: string, toolNames: readonly string[]): McpServerStatus {
  return {
    name,
    authStatus: "unsupported",
    tools: Object.fromEntries(toolNames.map((toolName) => [
      toolName,
      { name: toolName, inputSchema: {} },
    ])),
    resources: [],
    resourceTemplates: [],
  };
}

function mcp(): McpServerStatusListResponse {
  return { data: [server("node_repl", ["js", "js_reset"])] };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockState.calls = [];
  mockState.clientOptions = [];
  mockState.failureMethod = undefined;
  mockState.failure = undefined;

  const root = await mkdtemp(join(tmpdir(), "omp-chrome-status-"));
  pluginRoot = root;
  await Promise.all([
    mkdir(join(root, "scripts"), { recursive: true }),
    mkdir(join(root, ".codex-plugin"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "scripts", "browser-client.mjs"), "export function setupBrowserRuntime() {}\n"),
    writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "chrome", version: CHROME_VERSION }),
    ),
  ]);

  mockState.initializeResponse = initialize();
  mockState.pluginResponse = plugins(root);
  mockState.mcpResponse = mcp();
});

afterEach(async () => {
  if (pluginRoot) await rm(pluginRoot, { recursive: true, force: true });
  pluginRoot = undefined;
});

describe("checkChromeStatus", () => {
  it("reports supported readiness without bootstrapping or connecting to Chrome", async () => {
    const status = await checkChromeStatus("/private/project-cwd");

    expect(status).toEqual({
      status: "ready",
      reason: "ready",
      message: "Chrome transport compatibility is verified; connection is checked when chrome_open runs.",
      supportedPluginVersions: [CHROME_VERSION],
      supportedAppServerVersions: [APP_SERVER_VERSION],
      observedPluginVersions: [CHROME_VERSION],
      observedAppServerVersion: APP_SERVER_VERSION,
    });
    expect(mockState.clientOptions).toEqual([{ requestTimeoutMs: 60_000 }]);
    expect(mockState.calls).toEqual([
      {
        method: "initialize",
        params: {
          clientInfo: { name: "omp-codex-computer", version: "0.1.1" },
          capabilities: { experimentalApi: true },
        },
      },
      { method: "initialized", params: undefined },
      { method: "plugin/list", params: {} },
      { method: "mcpServerStatus/list", params: {} },
    ]);
    expect(mockState.calls.map((call) => call.method)).not.toContain("thread/start");
    expect(mockState.calls.map((call) => call.method)).not.toContain("mcpServer/tool/call");
    expect(mockState.stop).toHaveBeenCalledTimes(1);
  });

  it("reports safe supported and observed versions without exposing any discovered path", async () => {
    if (!pluginRoot) throw new Error("Expected a plugin fixture");
    mockState.initializeResponse = initialize("0.150.0");
    mockState.pluginResponse = plugins(pluginRoot, { localVersion: "26.818.31339" });

    const status = await checkChromeStatus("/private/project-cwd");
    const formatted = formatChromeStatus(status);

    expect(status).toMatchObject({
      status: "unavailable",
      reason: "unsupported_version_tuple",
      supportedPluginVersions: [CHROME_VERSION],
      supportedAppServerVersions: [APP_SERVER_VERSION],
      observedPluginVersions: ["26.818.31339"],
      observedAppServerVersion: "0.150.0",
    });
    expect(formatted).toContain("Supported Chrome plugin versions: 26.818.31338");
    expect(formatted).toContain("Observed Chrome plugin versions: 26.818.31339");
    expect(formatted).toContain("Supported Codex app-server versions: 0.149.0");
    expect(formatted).toContain("Observed Codex app-server version: 0.150.0");
    expect(formatted).not.toContain(pluginRoot);
    expect(formatted).not.toContain("/private/marketplace-path-that-must-not-leak");
    expect(formatted).not.toContain("/private/upstream-codex-home");
    expect(JSON.stringify(status)).not.toContain(pluginRoot);
    expect(mockState.stop).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an untrusted artifact without importing or calling the browser client", async () => {
    if (!pluginRoot) throw new Error("Expected a plugin fixture");
    await rm(join(pluginRoot, "scripts", "browser-client.mjs"));

    const status = await checkChromeStatus("/private/project-cwd");

    expect(status).toMatchObject({
      status: "unavailable",
      reason: "plugin_artifact_untrusted",
      observedPluginVersions: [CHROME_VERSION],
      observedAppServerVersion: APP_SERVER_VERSION,
    });
    expect(mockState.calls.map((call) => call.method)).toEqual([
      "initialize",
      "initialized",
      "plugin/list",
      "mcpServerStatus/list",
    ]);
    expect(mockState.stop).toHaveBeenCalledTimes(1);
  });

  it("always stops its temporary client when initialization fails", async () => {
    mockState.failureMethod = "initialize";
    mockState.failure = new Error("initialize-secret /private/initialize-path");

    const status = await checkChromeStatus("/private/project-cwd");

    expect(status).toEqual({
      status: "unavailable",
      reason: "check_failed",
      message: "Chrome status check failed while talking to Codex app-server.",
      supportedPluginVersions: [CHROME_VERSION],
      supportedAppServerVersions: [APP_SERVER_VERSION],
      observedPluginVersions: [],
    });
    expect(JSON.stringify(status)).not.toContain("initialize-secret");
    expect(JSON.stringify(status)).not.toContain("/private/initialize-path");
    expect(mockState.calls).toEqual([{
      method: "initialize",
      params: {
        clientInfo: { name: "omp-codex-computer", version: "0.1.1" },
        capabilities: { experimentalApi: true },
      },
    }]);
    expect(mockState.stop).toHaveBeenCalledTimes(1);
  });

  it("starts both discovery requests and always stops when one fails", async () => {
    mockState.failureMethod = "plugin/list";
    mockState.failure = new Error("plugin-secret /private/plugin-path");

    const status = await checkChromeStatus("/private/project-cwd");

    expect(status).toMatchObject({
      status: "unavailable",
      reason: "check_failed",
      observedPluginVersions: [],
      observedAppServerVersion: APP_SERVER_VERSION,
    });
    expect(mockState.calls.map((call) => call.method)).toEqual([
      "initialize",
      "initialized",
      "plugin/list",
      "mcpServerStatus/list",
    ]);
    expect(JSON.stringify(status)).not.toContain("plugin-secret");
    expect(JSON.stringify(status)).not.toContain("/private/plugin-path");
    expect(mockState.stop).toHaveBeenCalledTimes(1);
  });

  it("does not render an untrusted path-shaped plugin version", async () => {
    if (!pluginRoot) throw new Error("Expected a plugin fixture");
    const pathShapedVersion = "/private/version-secret";
    mockState.pluginResponse = plugins(pluginRoot, { localVersion: pathShapedVersion });

    const status = await checkChromeStatus("/private/project-cwd");
    const formatted = formatChromeStatus(status);

    expect(status).toMatchObject({
      status: "unavailable",
      reason: "unsupported_version_tuple",
      observedPluginVersions: [],
    });
    expect(formatted).toContain("Observed Chrome plugin versions: unknown");
    expect(formatted).not.toContain(pathShapedVersion);
    expect(mockState.stop).toHaveBeenCalledTimes(1);
  });
});
