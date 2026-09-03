import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHROME_CLIENT_CONTRACT_MARKERS,
  evaluateChromeCapabilities,
  type ChromeCapabilities,
  type ChromeUnavailableReason,
} from "../src/chrome-capabilities";
import { BUILT_IN_TRUSTED_APP_SERVER_VERSIONS } from "../src/chrome-trust";
import type {
  InitializeResponse,
  McpServerStatus,
  McpServerStatusListResponse,
  PluginListResponse,
  PluginMarketplaceEntry,
  PluginSummary,
} from "../src/protocol";

const CHROME_VERSION = "26.818.31338";
const APP_SERVER_VERSION = "0.149.0";
const NEWER_APP_SERVER_VERSION = "0.151.0";
const UNTRUSTED_APP_SERVER_VERSION = "0.152.0";
const CLIENT_FIXTURE = [
  "export function setupBrowserRuntime() {}",
  ...CHROME_CLIENT_CONTRACT_MARKERS.map((marker) => `// ${marker}`),
  "",
].join("\n");
const tempRoots: string[] = [];

interface PluginTree {
  root: string;
  clientPath: string;
  manifestPath: string;
}

async function createPluginTree(
  manifest: unknown = { name: "chrome", version: CHROME_VERSION },
  client: string = CLIENT_FIXTURE,
): Promise<PluginTree> {
  const root = await mkdtemp(join(tmpdir(), "omp-chrome-capabilities-"));
  tempRoots.push(root);
  const clientPath = join(root, "scripts", "browser-client.mjs");
  const manifestPath = join(root, ".codex-plugin", "plugin.json");
  await Promise.all([
    mkdir(join(root, "scripts"), { recursive: true }),
    mkdir(join(root, ".codex-plugin"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(clientPath, client),
    writeFile(manifestPath, JSON.stringify(manifest)),
  ]);
  return { root, clientPath, manifestPath };
}

function initialize(version = APP_SERVER_VERSION): InitializeResponse {
  return {
    userAgent: `omp-codex-computer/${version} (Mac OS 27.0.0; arm64)`,
    codexHome: "/private/status-secret/codex",
    platformFamily: "unix",
    platformOs: "macos",
  };
}

function chromePlugin(root: string, overrides: Partial<PluginSummary> = {}): PluginSummary {
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

function marketplace(name: string, plugins: PluginSummary[]): PluginMarketplaceEntry {
  return { name, path: null, plugins };
}

function pluginList(root: string, overrides: Partial<PluginSummary> = {}): PluginListResponse {
  return { marketplaces: [marketplace("openai-bundled", [chromePlugin(root, overrides)])] };
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

function mcp(servers: McpServerStatus[] = [server("node_repl", ["js"])]): McpServerStatusListResponse {
  return { data: servers };
}

// Every call passes an explicit env so the developer machine's real
// OMP_CODEX_CHROME_TRUST or persisted trust store never leaks into a test.
function evaluate(
  init: InitializeResponse,
  plugins: PluginListResponse,
  servers: McpServerStatusListResponse,
  env: NodeJS.ProcessEnv = {},
  extraTrusted: readonly string[] = [],
): Promise<ChromeCapabilities> {
  return evaluateChromeCapabilities(init, plugins, servers, env, extraTrusted);
}

function expectUnavailable(result: ChromeCapabilities, reason: ChromeUnavailableReason): void {
  expect(result.status).toBe("unavailable");
  if (result.status === "unavailable") {
    expect(result.reason).toBe(reason);
    expect(result.message.length).toBeGreaterThan(0);
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evaluateChromeCapabilities", () => {
  it("pins the built-in trusted app-server versions", () => {
    expect(BUILT_IN_TRUSTED_APP_SERVER_VERSIONS).toEqual([APP_SERVER_VERSION, NEWER_APP_SERVER_VERSION]);
    expect(Object.isFrozen(BUILT_IN_TRUSTED_APP_SERVER_VERSIONS)).toBe(true);
  });

  it.each(BUILT_IN_TRUSTED_APP_SERVER_VERSIONS)(
    "accepts built-in app-server version %s without env or persisted trust",
    async (appServerVersion) => {
      const tree = await createPluginTree();

      const result = await evaluate(initialize(appServerVersion), pluginList(tree.root), mcp(), {});

      expect(result).toMatchObject({ status: "ready", appServerVersion });
    },
  );

  it("fails closed on an app-server version outside the built-in allowlist", async () => {
    const tree = await createPluginTree();

    const result = await evaluate(initialize(UNTRUSTED_APP_SERVER_VERSION), pluginList(tree.root), mcp(), {});

    expectUnavailable(result, "unsupported_app_server_version");
  });

  it("accepts the app-server 0.151.0 mcpServerStatus/list shape", async () => {
    // Mirrors a live 0.151.0 `node_repl` entry: additive `runtimeStatus`
    // (nullable) plus `pluginId`/`serverInfo` and the current tool set. The
    // intersection keeps `McpServerStatus` as the consumed subset while the
    // fixture carries the upstream fields this gate must ignore.
    const tree = await createPluginTree();
    const nodeRepl: McpServerStatus & { runtimeStatus: null; pluginId: null; serverInfo: Record<string, unknown> } = {
      ...server("node_repl", ["js", "js_add_node_module_dir", "js_reset", "turn_ended"]),
      runtimeStatus: null,
      pluginId: null,
      serverInfo: { name: "rmcp", title: null, version: "1.5.0", description: null, icons: null, websiteUrl: null },
    };

    const result = await evaluate(initialize(NEWER_APP_SERVER_VERSION), pluginList(tree.root), mcp([nodeRepl]), {});

    expect(result).toMatchObject({ status: "ready", appServerVersion: NEWER_APP_SERVER_VERSION });
  });

  it.each([CHROME_VERSION, "27.101.55555"])(
    "accepts any plugin version (%s) whose artifacts pass the contract check",
    async (pluginVersion) => {
      const tree = await createPluginTree({ name: "chrome", version: pluginVersion });

      const result = await evaluate(
        initialize(),
        pluginList(tree.root, { localVersion: pluginVersion }),
        mcp(),
      );

      expect(result).toEqual({
        status: "ready",
        pluginVersion,
        appServerVersion: APP_SERVER_VERSION,
        clientPath: await realpath(tree.clientPath),
        nodeReplServerName: "node_repl",
      });
    },
  );

  it("trusts additional app-server versions from OMP_CODEX_CHROME_TRUST", async () => {
    const tree = await createPluginTree();
    const env = { OMP_CODEX_CHROME_TRUST: " 0.150.0 , " };

    const trusted = await evaluate(initialize("0.150.0"), pluginList(tree.root), mcp(), env);
    expect(trusted).toMatchObject({ status: "ready", appServerVersion: "0.150.0" });

    const builtIn = await evaluate(initialize(), pluginList(tree.root), mcp(), env);
    expect(builtIn).toMatchObject({ status: "ready", appServerVersion: APP_SERVER_VERSION });
  });

  it("trusts probe-only extra versions without widening env or persisted trust", async () => {
    const tree = await createPluginTree();

    const withExtra = await evaluate(
      initialize(UNTRUSTED_APP_SERVER_VERSION),
      pluginList(tree.root),
      mcp(),
      {},
      [UNTRUSTED_APP_SERVER_VERSION],
    );
    expect(withExtra).toMatchObject({ status: "ready", appServerVersion: UNTRUSTED_APP_SERVER_VERSION });

    const withoutExtra = await evaluate(initialize(UNTRUSTED_APP_SERVER_VERSION), pluginList(tree.root), mcp(), {});
    expectUnavailable(withoutExtra, "unsupported_app_server_version");
  });

  it("reads persisted app-server trust from the config store", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "omp-chrome-trust-"));
    tempRoots.push(configHome);
    await mkdir(join(configHome, "omp-codex-computer"), { recursive: true });
    await writeFile(
      join(configHome, "omp-codex-computer", "trusted-app-servers.json"),
      JSON.stringify({ appServerVersions: ["0.152.0"] }),
    );
    const tree = await createPluginTree();
    const env = { XDG_CONFIG_HOME: configHome };

    const trusted = await evaluate(initialize("0.152.0"), pluginList(tree.root), mcp(), env);
    expect(trusted).toMatchObject({ status: "ready", appServerVersion: "0.152.0" });
  });

  it("ignores malformed trust entries without widening trust", async () => {
    const tree = await createPluginTree();
    const malformed = [
      "26.900.40000@0.150.0",
      "@0.150.0",
      "0.150 .0",
      "javascript:x",
      "",
      "   ",
    ].join(",");

    const result = await evaluate(
      initialize("0.150.0"),
      pluginList(tree.root),
      mcp(),
      { OMP_CODEX_CHROME_TRUST: malformed },
    );
    expectUnavailable(result, "unsupported_app_server_version");
  });

  it("rejects an unverifiable or untrusted app-server version before touching the plugin", async () => {
    const tree = await createPluginTree();

    const missing = await evaluate(
      { ...initialize(), userAgent: "omp-codex-computer" },
      pluginList(tree.root),
      mcp(),
    );
    const unsupported = await evaluate(initialize("0.150.0"), pluginList(tree.root), mcp());

    expectUnavailable(missing, "app_server_version_unavailable");
    expectUnavailable(unsupported, "unsupported_app_server_version");
  });

  it("rejects a missing or duplicated openai-bundled marketplace", async () => {
    const tree = await createPluginTree();
    const missing: PluginListResponse = {
      marketplaces: [marketplace("openai-curated", [chromePlugin(tree.root)])],
    };
    const duplicated: PluginListResponse = {
      marketplaces: [
        marketplace("openai-bundled", [chromePlugin(tree.root)]),
        marketplace("openai-bundled", []),
      ],
    };

    expectUnavailable(await evaluate(initialize(), missing, mcp()), "marketplace_unavailable");
    expectUnavailable(await evaluate(initialize(), duplicated, mcp()), "marketplace_unavailable");
  });

  it("rejects duplicate and lookalike Chrome plugin identities", async () => {
    const tree = await createPluginTree();
    const duplicate: PluginListResponse = {
      marketplaces: [marketplace("openai-bundled", [
        chromePlugin(tree.root),
        chromePlugin(tree.root),
      ])],
    };
    const wrongId = pluginList(tree.root, { id: "chrome@openai-curated" });
    const wrongName = pluginList(tree.root, { name: "browser" });
    const thirdPartyLookalike: PluginListResponse = {
      marketplaces: [
        marketplace("openai-bundled", [chromePlugin(tree.root)]),
        marketplace("third-party", [chromePlugin(tree.root, { id: "third-party-chrome" })]),
      ],
    };

    expectUnavailable(await evaluate(initialize(), duplicate, mcp()), "plugin_unavailable");
    expectUnavailable(await evaluate(initialize(), wrongId, mcp()), "plugin_unavailable");
    expectUnavailable(await evaluate(initialize(), wrongName, mcp()), "plugin_unavailable");
    expectUnavailable(await evaluate(initialize(), thirdPartyLookalike, mcp()), "plugin_unavailable");
  });

  it.each([
    ["not installed", { installed: false }, "plugin_not_installed"],
    ["disabled", { enabled: false }, "plugin_disabled"],
    ["not AVAILABLE", { availability: "DISABLED_BY_ADMIN" }, "plugin_availability_unavailable"],
  ] as const)("rejects a plugin that is %s", async (_label, overrides, reason) => {
    const tree = await createPluginTree();

    const result = await evaluate(initialize(), pluginList(tree.root, overrides), mcp());

    expectUnavailable(result, reason);
  });

  it("rejects a missing or unsafe plugin version string as untrusted identity", async () => {
    const tree = await createPluginTree();

    const missing = await evaluate(initialize(), pluginList(tree.root, { localVersion: undefined }), mcp());
    const pathShaped = await evaluate(
      initialize(),
      pluginList(tree.root, { localVersion: "/private/version-secret" }),
      mcp(),
    );

    expectUnavailable(missing, "plugin_artifact_untrusted");
    expectUnavailable(pathShaped, "plugin_artifact_untrusted");
  });

  it.each([
    ["missing", undefined],
    ["non-local", { type: "git", path: "/private/untrusted" }],
    ["relative", { type: "local", path: "relative/plugin" }],
    ["extra fields", { type: "local", path: "/private/untrusted", extra: true }],
  ] as const)("rejects a %s plugin source", async (_label, source) => {
    const tree = await createPluginTree();

    const result = await evaluate(initialize(), pluginList(tree.root, { source }), mcp());

    expectUnavailable(result, "plugin_source_untrusted");
    expect(JSON.stringify(result)).not.toContain(tree.root);
  });

  it("requires one unambiguous node_repl server advertising the js tool by name", async () => {
    const tree = await createPluginTree();
    const missing = mcp([server("node_repl", [])]);
    const duplicate = mcp([server("node_repl", ["js"]), server("node_repl", ["js"])]);
    const mismatchedTool = mcp([{
      ...server("node_repl", []),
      tools: { js: { name: "javascript", inputSchema: {} } },
    }]);

    expectUnavailable(await evaluate(initialize(), pluginList(tree.root), missing), "node_repl_unavailable");
    expectUnavailable(await evaluate(initialize(), pluginList(tree.root), duplicate), "node_repl_unavailable");
    expectUnavailable(await evaluate(initialize(), pluginList(tree.root), mismatchedTool), "node_repl_unavailable");
  });

  it("rejects a missing or non-file browser client", async () => {
    const missingTree = await createPluginTree();
    await rm(missingTree.clientPath);
    const nonFileTree = await createPluginTree();
    await rm(nonFileTree.clientPath);
    await mkdir(nonFileTree.clientPath);

    const missing = await evaluate(initialize(), pluginList(missingTree.root), mcp());
    const nonFile = await evaluate(initialize(), pluginList(nonFileTree.root), mcp());

    expectUnavailable(missing, "plugin_artifact_untrusted");
    expectUnavailable(nonFile, "plugin_artifact_untrusted");
  });

  it("requires the manifest name and version to match the selected plugin", async () => {
    const wrongName = await createPluginTree({ name: "browser", version: CHROME_VERSION });
    const wrongVersion = await createPluginTree({ name: "chrome", version: "0.0.0" });
    const malformed = await createPluginTree();
    await writeFile(malformed.manifestPath, "not json");

    expectUnavailable(
      await evaluate(initialize(), pluginList(wrongName.root), mcp()),
      "plugin_artifact_untrusted",
    );
    expectUnavailable(
      await evaluate(initialize(), pluginList(wrongVersion.root), mcp()),
      "plugin_artifact_untrusted",
    );
    expectUnavailable(
      await evaluate(initialize(), pluginList(malformed.root), mcp()),
      "plugin_artifact_untrusted",
    );
  });

  it.each(CHROME_CLIENT_CONTRACT_MARKERS)(
    "fails closed when the client no longer mentions contract marker %s",
    async (marker) => {
      const client = marker === "setupBrowserRuntime"
        ? `export const bootstrap = 1;\n${CHROME_CLIENT_CONTRACT_MARKERS.filter((entry) => entry !== marker).join("\n")}\n`
        : `export function setupBrowserRuntime() {}\n${CHROME_CLIENT_CONTRACT_MARKERS.filter((entry) => entry !== marker).join("\n")}\n`;
      const tree = await createPluginTree({ name: "chrome", version: CHROME_VERSION }, client);

      const result = await evaluate(initialize(), pluginList(tree.root), mcp());

      expectUnavailable(result, "plugin_contract_mismatch");
    },
  );

  it("fails closed when setupBrowserRuntime is present but never exported", async () => {
    const client = `const setupBrowserRuntime = () => {};\n${CHROME_CLIENT_CONTRACT_MARKERS.join("\n")}\n`;
    const tree = await createPluginTree({ name: "chrome", version: CHROME_VERSION }, client);

    const result = await evaluate(initialize(), pluginList(tree.root), mcp());

    expectUnavailable(result, "plugin_contract_mismatch");
  });

  it("accepts the minified export form used by the bundled client", async () => {
    const client = `${CHROME_CLIENT_CONTRACT_MARKERS.join(";")};export{$x as setupBrowserRuntime};\n`;
    const tree = await createPluginTree({ name: "chrome", version: CHROME_VERSION }, client);

    const result = await evaluate(initialize(), pluginList(tree.root), mcp());

    expect(result).toMatchObject({ status: "ready", clientPath: await realpath(tree.clientPath) });
  });

  it("fails closed on an oversized client bundle", async () => {
    const padding = "//".padEnd(8 * 1024 * 1024, "x");
    const client = `export function setupBrowserRuntime() {}\n${CHROME_CLIENT_CONTRACT_MARKERS.join("\n")}\n${padding}\n`;
    const tree = await createPluginTree({ name: "chrome", version: CHROME_VERSION }, client);

    const result = await evaluate(initialize(), pluginList(tree.root), mcp());

    expectUnavailable(result, "plugin_contract_mismatch");
  });

  it("rejects a browser-client symlink that escapes the canonical plugin root", async () => {
    const tree = await createPluginTree();
    const outsideRoot = await mkdtemp(join(tmpdir(), "omp-chrome-outside-"));
    tempRoots.push(outsideRoot);
    const outsideClient = join(outsideRoot, "browser-client.mjs");
    await writeFile(outsideClient, CLIENT_FIXTURE);
    await rm(tree.clientPath);
    await symlink(outsideClient, tree.clientPath);

    const result = await evaluate(initialize(), pluginList(tree.root), mcp());

    expectUnavailable(result, "plugin_artifact_untrusted");
    expect(JSON.stringify(result)).not.toContain(tree.root);
    expect(JSON.stringify(result)).not.toContain(outsideRoot);
  });
});
