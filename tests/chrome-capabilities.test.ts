import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SUPPORTED_CHROME_APP_SERVER_VERSIONS,
  SUPPORTED_CHROME_PLUGIN_VERSIONS,
  evaluateChromeCapabilities,
  type ChromeCapabilities,
  type ChromeUnavailableReason,
} from "../src/chrome-capabilities";
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
const tempRoots: string[] = [];

interface PluginTree {
  root: string;
  clientPath: string;
  manifestPath: string;
}

async function createPluginTree(
  manifest: unknown = { name: "chrome", version: CHROME_VERSION },
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
    writeFile(clientPath, "export function setupBrowserRuntime() {}\n"),
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

function expectUnavailable(result: ChromeCapabilities, reason: ChromeUnavailableReason): void {
  expect(result.status).toBe("unavailable");
  if (result.status !== "unavailable") throw new Error("Expected unavailable Chrome capabilities");
  expect(result.reason).toBe(reason);
  expect(result.message).toMatch(/^Chrome is unavailable /);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evaluateChromeCapabilities", () => {
  it("pins the only supported plugin and app-server versions", () => {
    expect(SUPPORTED_CHROME_PLUGIN_VERSIONS).toEqual([CHROME_VERSION]);
    expect(SUPPORTED_CHROME_APP_SERVER_VERSIONS).toEqual([APP_SERVER_VERSION]);
    expect(Object.isFrozen(SUPPORTED_CHROME_PLUGIN_VERSIONS)).toBe(true);
    expect(Object.isFrozen(SUPPORTED_CHROME_APP_SERVER_VERSIONS)).toBe(true);
  });

  it("accepts only the trusted exact tuple, local artifacts, manifest, and node_repl/js", async () => {
    const tree = await createPluginTree();

    const result = await evaluateChromeCapabilities(initialize(), pluginList(tree.root), mcp());

    expect(result).toEqual({
      status: "ready",
      pluginVersion: CHROME_VERSION,
      appServerVersion: APP_SERVER_VERSION,
      clientPath: await realpath(tree.clientPath),
      nodeReplServerName: "node_repl",
    });
  });

  it("rejects an unverifiable or unsupported app-server version before trusting the plugin", async () => {
    const tree = await createPluginTree();

    const missing = await evaluateChromeCapabilities(
      { ...initialize(), userAgent: "omp-codex-computer" },
      pluginList(tree.root),
      mcp(),
    );
    const unsupported = await evaluateChromeCapabilities(initialize("0.150.0"), pluginList(tree.root), mcp());

    expectUnavailable(missing, "app_server_version_unavailable");
    expectUnavailable(unsupported, "unsupported_version_tuple");
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

    expectUnavailable(await evaluateChromeCapabilities(initialize(), missing, mcp()), "marketplace_unavailable");
    expectUnavailable(await evaluateChromeCapabilities(initialize(), duplicated, mcp()), "marketplace_unavailable");
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

    expectUnavailable(await evaluateChromeCapabilities(initialize(), duplicate, mcp()), "plugin_unavailable");
    expectUnavailable(await evaluateChromeCapabilities(initialize(), wrongId, mcp()), "plugin_unavailable");
    expectUnavailable(await evaluateChromeCapabilities(initialize(), wrongName, mcp()), "plugin_unavailable");
    expectUnavailable(await evaluateChromeCapabilities(initialize(), thirdPartyLookalike, mcp()), "plugin_unavailable");
  });

  it.each([
    ["not installed", { installed: false }, "plugin_not_installed"],
    ["disabled", { enabled: false }, "plugin_disabled"],
    ["not AVAILABLE", { availability: "DISABLED_BY_ADMIN" }, "plugin_availability_unavailable"],
  ] as const)("rejects a plugin that is %s", async (_label, overrides, reason) => {
    const tree = await createPluginTree();

    const result = await evaluateChromeCapabilities(initialize(), pluginList(tree.root, overrides), mcp());

    expectUnavailable(result, reason);
  });

  it("rejects an unsupported plugin version", async () => {
    const tree = await createPluginTree({ name: "chrome", version: "26.818.31339" });

    const result = await evaluateChromeCapabilities(
      initialize(),
      pluginList(tree.root, { localVersion: "26.818.31339" }),
      mcp(),
    );

    expectUnavailable(result, "unsupported_version_tuple");
  });

  it.each([
    ["missing", undefined],
    ["non-local", { type: "git", path: "/private/untrusted" }],
    ["relative", { type: "local", path: "relative/plugin" }],
    ["extra fields", { type: "local", path: "/private/untrusted", extra: true }],
  ] as const)("rejects a %s plugin source", async (_label, source) => {
    const tree = await createPluginTree();

    const result = await evaluateChromeCapabilities(initialize(), pluginList(tree.root, { source }), mcp());

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

    expectUnavailable(await evaluateChromeCapabilities(initialize(), pluginList(tree.root), missing), "node_repl_unavailable");
    expectUnavailable(await evaluateChromeCapabilities(initialize(), pluginList(tree.root), duplicate), "node_repl_unavailable");
    expectUnavailable(await evaluateChromeCapabilities(initialize(), pluginList(tree.root), mismatchedTool), "node_repl_unavailable");
  });

  it("rejects a missing or non-file browser client", async () => {
    const missingTree = await createPluginTree();
    await rm(missingTree.clientPath);
    const nonFileTree = await createPluginTree();
    await rm(nonFileTree.clientPath);
    await mkdir(nonFileTree.clientPath);

    const missing = await evaluateChromeCapabilities(initialize(), pluginList(missingTree.root), mcp());
    const nonFile = await evaluateChromeCapabilities(initialize(), pluginList(nonFileTree.root), mcp());

    expectUnavailable(missing, "plugin_artifact_untrusted");
    expectUnavailable(nonFile, "plugin_artifact_untrusted");
  });

  it("requires the manifest name and version to match the selected plugin", async () => {
    const wrongName = await createPluginTree({ name: "browser", version: CHROME_VERSION });
    const wrongVersion = await createPluginTree({ name: "chrome", version: "0.0.0" });
    const malformed = await createPluginTree();
    await writeFile(malformed.manifestPath, "not json");

    expectUnavailable(
      await evaluateChromeCapabilities(initialize(), pluginList(wrongName.root), mcp()),
      "plugin_artifact_untrusted",
    );
    expectUnavailable(
      await evaluateChromeCapabilities(initialize(), pluginList(wrongVersion.root), mcp()),
      "plugin_artifact_untrusted",
    );
    expectUnavailable(
      await evaluateChromeCapabilities(initialize(), pluginList(malformed.root), mcp()),
      "plugin_artifact_untrusted",
    );
  });

  it("rejects a browser-client symlink that escapes the canonical plugin root", async () => {
    const tree = await createPluginTree();
    const outsideRoot = await mkdtemp(join(tmpdir(), "omp-chrome-outside-"));
    tempRoots.push(outsideRoot);
    const outsideClient = join(outsideRoot, "browser-client.mjs");
    await writeFile(outsideClient, "export const compromised = true;\n");
    await rm(tree.clientPath);
    await symlink(outsideClient, tree.clientPath);

    const result = await evaluateChromeCapabilities(initialize(), pluginList(tree.root), mcp());

    expectUnavailable(result, "plugin_artifact_untrusted");
    expect(JSON.stringify(result)).not.toContain(tree.root);
    expect(JSON.stringify(result)).not.toContain(outsideRoot);
  });
});
