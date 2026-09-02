import { CLIENT_INFO } from "../src/client-info";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHROME_CLIENT_CONTRACT_MARKERS } from "../src/chrome-capabilities";
import { checkChromeStatus, formatChromeStatus } from "../src/chrome-status";
import { BUILT_IN_TRUSTED_APP_SERVER_VERSIONS } from "../src/chrome-trust";
import type {
  InitializeResponse,
  McpServerStatus,
  McpServerStatusListResponse,
  PluginListResponse,
  PluginSummary,
} from "../src/protocol";

const CHROME_VERSION = "26.818.61809";
const APP_SERVER_VERSION = "0.149.0";
const CLIENT_FIXTURE = [
  "export function setupBrowserRuntime() {}",
  ...CHROME_CLIENT_CONTRACT_MARKERS.map((marker) => `// ${marker}`),
  "",
].join("\n");

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
let configHome: string | undefined;

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
    writeFile(join(root, "scripts", "browser-client.mjs"), CLIENT_FIXTURE),
    writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "chrome", version: CHROME_VERSION }),
    ),
  ]);

  // Pin trust resolution to an empty temp store so the developer machine's
  // real OMP_CODEX_CHROME_TRUST or persisted trust never leaks into a test.
  configHome = await mkdtemp(join(tmpdir(), "omp-chrome-status-config-"));
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
  vi.stubEnv("OMP_CODEX_CHROME_TRUST", "");

  mockState.initializeResponse = initialize();
  mockState.pluginResponse = plugins(root);
  mockState.mcpResponse = mcp();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (pluginRoot) await rm(pluginRoot, { recursive: true, force: true });
  pluginRoot = undefined;
  if (configHome) await rm(configHome, { recursive: true, force: true });
  configHome = undefined;
});

describe("checkChromeStatus", () => {
  it("reports supported readiness without bootstrapping or connecting to Chrome", async () => {
    const status = await checkChromeStatus("/private/project-cwd");

    expect(status).toEqual({
      status: "ready",
      reason: "ready",
      message: "Chrome transport compatibility is verified; connection is checked when chrome_open runs.",
      trustedAppServerVersions: [...BUILT_IN_TRUSTED_APP_SERVER_VERSIONS],
      observedPluginVersions: [CHROME_VERSION],
      observedAppServerVersion: APP_SERVER_VERSION,
    });
    expect(mockState.clientOptions).toEqual([{ requestTimeoutMs: 60_000 }]);
    expect(mockState.calls).toEqual([
      {
        method: "initialize",
        params: {
          clientInfo: CLIENT_INFO,
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

  it("reports safe trusted and observed versions without exposing any discovered path", async () => {
    if (!pluginRoot) throw new Error("Expected a plugin fixture");
    mockState.initializeResponse = initialize("0.150.0");

    const status = await checkChromeStatus("/private/project-cwd");
    const formatted = formatChromeStatus(status);

    expect(status).toMatchObject({
      status: "unavailable",
      reason: "unsupported_app_server_version",
      trustedAppServerVersions: [...BUILT_IN_TRUSTED_APP_SERVER_VERSIONS],
      observedPluginVersions: [CHROME_VERSION],
      observedAppServerVersion: "0.150.0",
    });
    expect(status.message).toContain("/codex-computer trust");
    expect(formatted).toContain(
      `Trusted Codex app-server versions: ${BUILT_IN_TRUSTED_APP_SERVER_VERSIONS.join(", ")}`,
    );
    expect(formatted).toContain("Observed Codex app-server version: 0.150.0");
    expect(formatted).toContain(`Observed Chrome plugin versions: ${CHROME_VERSION}`);
    expect(formatted).not.toContain(pluginRoot);
    expect(formatted).not.toContain("/private/marketplace-path-that-must-not-leak");
    expect(formatted).not.toContain("/private/upstream-codex-home");
    expect(JSON.stringify(status)).not.toContain(pluginRoot);
    expect(mockState.stop).toHaveBeenCalledTimes(1);
  });

  it("includes persisted and env-trusted app-server versions in the trusted list", async () => {
    if (!configHome) throw new Error("Expected a config fixture");
    await mkdir(join(configHome, "omp-codex-computer"), { recursive: true });
    await writeFile(
      join(configHome, "omp-codex-computer", "trusted-app-servers.json"),
      JSON.stringify({ appServerVersions: ["0.150.0"] }),
    );
    vi.stubEnv("OMP_CODEX_CHROME_TRUST", "0.152.0");
    mockState.initializeResponse = initialize("0.150.0");

    const status = await checkChromeStatus("/private/project-cwd");

    expect(status).toMatchObject({
      status: "ready",
      trustedAppServerVersions: [...BUILT_IN_TRUSTED_APP_SERVER_VERSIONS, "0.150.0", "0.152.0"],
      observedAppServerVersion: "0.150.0",
    });
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

  it("fails closed on a client that dropped the automation contract", async () => {
    if (!pluginRoot) throw new Error("Expected a plugin fixture");
    await writeFile(
      join(pluginRoot, "scripts", "browser-client.mjs"),
      "export function setupBrowserRuntime() {}\n// domSnapshot only\n",
    );

    const status = await checkChromeStatus("/private/project-cwd");

    expect(status).toMatchObject({
      status: "unavailable",
      reason: "plugin_contract_mismatch",
      observedPluginVersions: [CHROME_VERSION],
    });
    expect(status.message).toContain("Update omp-codex-computer");
  });

  it("always stops its temporary client when initialization fails", async () => {
    mockState.failureMethod = "initialize";
    mockState.failure = new Error("initialize-secret /private/initialize-path");

    const status = await checkChromeStatus("/private/project-cwd");

    expect(status).toEqual({
      status: "unavailable",
      reason: "check_failed",
      message: "Chrome status check failed while talking to Codex app-server.",
      trustedAppServerVersions: [...BUILT_IN_TRUSTED_APP_SERVER_VERSIONS],
      observedPluginVersions: [],
    });
    expect(JSON.stringify(status)).not.toContain("initialize-secret");
    expect(JSON.stringify(status)).not.toContain("/private/initialize-path");
    expect(mockState.calls).toEqual([{
      method: "initialize",
      params: {
        clientInfo: CLIENT_INFO,
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
      reason: "plugin_artifact_untrusted",
      observedPluginVersions: [],
    });
    expect(formatted).toContain("Observed Chrome plugin versions: unknown");
    expect(formatted).not.toContain(pathShapedVersion);
    expect(mockState.stop).toHaveBeenCalledTimes(1);
  });
});
