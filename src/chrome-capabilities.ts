import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type {
  InitializeResponse,
  McpServerStatusListResponse,
  PluginListResponse,
} from "./protocol";

import {
  getTrustedAppServerVersions,
  loadPersistedAppServerVersions,
  SAFE_VERSION_PATTERN,
} from "./chrome-trust";

/**
 * Client surface the generated program calls. A plugin update that drops any
 * marker fails closed before bootstrap; the in-program shape handshake covers
 * the rest at runtime. Names generic enough to appear in any bundle (goto,
 * close, first, ...) carry no static signal and are checked only at runtime.
 */
export const CHROME_CLIENT_CONTRACT_MARKERS: readonly string[] = Object.freeze([
  "setupBrowserRuntime",
  "nameSession",
  "domSnapshot",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByTestId",
  "selectOption",
  "setChecked",
]);

const CLIENT_EXPORT_PATTERN = /export\s*(?:\{[^}]*\bsetupBrowserRuntime\b[^}]*\}|(?:async\s+)?function\s+setupBrowserRuntime\b|const\s+setupBrowserRuntime\b)/;

const TRUSTED_MARKETPLACE_NAME = "openai-bundled";
const CHROME_PLUGIN_ID = "chrome@openai-bundled";
const CHROME_PLUGIN_NAME = "chrome";
const NODE_REPL_SERVER_NAME = "node_repl";
const NODE_REPL_TOOL_NAME = "js";
const CLIENT_RELATIVE_PATH = join("scripts", "browser-client.mjs");
const MANIFEST_RELATIVE_PATH = join(".codex-plugin", "plugin.json");
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CLIENT_BYTES = 8 * 1024 * 1024;
const APP_SERVER_USER_AGENT_PATTERN = /^omp-codex-computer\/([0-9A-Za-z][0-9A-Za-z.+-]{0,63})(?=$|[\s(])/;

export type ChromeUnavailableReason =
  | "app_server_version_unavailable"
  | "unsupported_app_server_version"
  | "marketplace_unavailable"
  | "plugin_unavailable"
  | "plugin_not_installed"
  | "plugin_disabled"
  | "plugin_availability_unavailable"
  | "plugin_source_untrusted"
  | "node_repl_unavailable"
  | "plugin_artifact_untrusted"
  | "plugin_contract_mismatch";

export interface ReadyChromeCapabilities {
  status: "ready";
  pluginVersion: string;
  appServerVersion: string;
  clientPath: string;
  nodeReplServerName: string;
}

export interface UnavailableChromeCapabilities {
  status: "unavailable";
  reason: ChromeUnavailableReason;
  message: string;
}

export type ChromeCapabilities = ReadyChromeCapabilities | UnavailableChromeCapabilities;

export interface ChromeObservedVersions {
  appServerVersion?: string;
  pluginVersions: string[];
}

interface RuntimePlugin {
  id?: unknown;
  name?: unknown;
  installed?: unknown;
  enabled?: unknown;
  availability?: unknown;
  localVersion?: unknown;
  source?: unknown;
}

interface RuntimeMarketplace {
  name: string;
  plugins: unknown[];
}

interface SelectedPlugin {
  plugin: RuntimePlugin;
}

type PluginSelection =
  | { status: "selected"; value: SelectedPlugin }
  | { status: "unavailable"; reason: "marketplace_unavailable" | "plugin_unavailable" };

const UNAVAILABLE_MESSAGES: Readonly<Record<ChromeUnavailableReason, string>> = Object.freeze({
  app_server_version_unavailable: "Chrome is unavailable because the Codex app-server version could not be verified.",
  unsupported_app_server_version: "Chrome is unavailable because this Codex app-server version has not been validated. Run /codex-computer trust to contract-check and live-probe the installed stack and trust it on this machine, or set OMP_CODEX_CHROME_TRUST to a comma-separated list of app-server versions.",
  marketplace_unavailable: "Chrome is unavailable because the trusted bundled marketplace is missing or ambiguous.",
  plugin_unavailable: "Chrome is unavailable because the bundled Chrome plugin is missing or ambiguous.",
  plugin_not_installed: "Chrome is unavailable because the bundled Chrome plugin is not installed.",
  plugin_disabled: "Chrome is unavailable because the bundled Chrome plugin is disabled.",
  plugin_availability_unavailable: "Chrome is unavailable because the bundled Chrome plugin is not available.",
  plugin_source_untrusted: "Chrome is unavailable because the bundled Chrome plugin source could not be trusted.",
  node_repl_unavailable: "Chrome is unavailable because node_repl/js is not available unambiguously.",
  plugin_artifact_untrusted: "Chrome is unavailable because the bundled Chrome plugin artifacts could not be trusted.",
  plugin_contract_mismatch: "Chrome is unavailable because the installed Chrome plugin client no longer exposes the automation contract this extension validates. Update omp-codex-computer or report the mismatch.",
});

export async function evaluateChromeCapabilities(
  initialize: InitializeResponse,
  plugins: PluginListResponse,
  mcp: McpServerStatusListResponse,
  env: NodeJS.ProcessEnv = process.env,
  extraTrustedAppServerVersions: readonly string[] = [],
): Promise<ChromeCapabilities> {
  const appServerVersion = extractAppServerVersion(initialize);
  if (!appServerVersion) return unavailable("app_server_version_unavailable");
  const trustedVersions = getTrustedAppServerVersions(env, [
    ...await loadPersistedAppServerVersions(env),
    ...extraTrustedAppServerVersions,
  ]);
  if (!trustedVersions.includes(appServerVersion)) {
    return unavailable("unsupported_app_server_version");
  }

  const selection = selectChromePlugin(plugins);
  if (selection.status === "unavailable") return unavailable(selection.reason);

  const { plugin } = selection.value;
  if (plugin.installed !== true) return unavailable("plugin_not_installed");
  if (plugin.enabled !== true) return unavailable("plugin_disabled");
  if (plugin.availability !== "AVAILABLE") return unavailable("plugin_availability_unavailable");

  // The plugin version is identity (manifest match, status display), not a
  // gate: the artifact and contract checks below validate the actual client.
  const pluginVersion = plugin.localVersion;
  if (typeof pluginVersion !== "string" || !SAFE_VERSION_PATTERN.test(pluginVersion)) {
    return unavailable("plugin_artifact_untrusted");
  }

  const sourcePath = getTrustedLocalSourcePath(plugin.source);
  if (!sourcePath) return unavailable("plugin_source_untrusted");
  if (!hasUnambiguousNodeReplJs(mcp)) return unavailable("node_repl_unavailable");

  const clientPath = await validatePluginArtifacts(sourcePath, pluginVersion);
  if (!clientPath) return unavailable("plugin_artifact_untrusted");
  if (!await validateClientContract(clientPath)) return unavailable("plugin_contract_mismatch");

  return {
    status: "ready",
    pluginVersion,
    appServerVersion,
    clientPath,
    nodeReplServerName: NODE_REPL_SERVER_NAME,
  };
}

/**
 * Static tripwire over the proprietary client bundle: the export and every
 * contract marker must be present. This is a pre-dispatch filter, not a
 * security boundary — identity comes from the marketplace/manifest checks and
 * behavior from the in-program shape handshake.
 */
async function validateClientContract(clientPath: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(clientPath, "utf8");
  } catch {
    return false;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_CLIENT_BYTES) return false;
  if (!CLIENT_EXPORT_PATTERN.test(text)) return false;
  return CHROME_CLIENT_CONTRACT_MARKERS.every((marker) => text.includes(marker));
}

export function getChromeObservedVersions(
  initialize?: InitializeResponse,
  plugins?: PluginListResponse,
): ChromeObservedVersions {
  const appServerVersion = initialize ? extractAppServerVersion(initialize) : undefined;
  const pluginVersions = new Set<string>();
  const marketplaces: unknown = plugins?.marketplaces;

  if (Array.isArray(marketplaces)) {
    for (const value of marketplaces) {
      const marketplace = parseMarketplace(value);
      if (!marketplace || marketplace.name !== TRUSTED_MARKETPLACE_NAME) continue;

      for (const value of marketplace.plugins) {
        const plugin = parsePlugin(value);
        if (!plugin) continue;
        if (plugin.id !== CHROME_PLUGIN_ID || plugin.name !== CHROME_PLUGIN_NAME) continue;
        if (typeof plugin.localVersion !== "string" || !SAFE_VERSION_PATTERN.test(plugin.localVersion)) continue;
        pluginVersions.add(plugin.localVersion);
      }
    }
  }

  return {
    ...(appServerVersion ? { appServerVersion } : {}),
    pluginVersions: [...pluginVersions].sort(),
  };
}

function unavailable(reason: ChromeUnavailableReason): UnavailableChromeCapabilities {
  return { status: "unavailable", reason, message: UNAVAILABLE_MESSAGES[reason] };
}

function extractAppServerVersion(initialize: InitializeResponse): string | undefined {
  const userAgent: unknown = initialize.userAgent;
  if (typeof userAgent !== "string") return undefined;
  return APP_SERVER_USER_AGENT_PATTERN.exec(userAgent)?.[1];
}

function selectChromePlugin(response: PluginListResponse): PluginSelection {
  const values: unknown = response.marketplaces;
  if (!Array.isArray(values)) {
    return { status: "unavailable", reason: "marketplace_unavailable" };
  }

  const marketplaces: RuntimeMarketplace[] = [];
  for (const value of values) {
    const marketplace = parseMarketplace(value);
    if (!marketplace) return { status: "unavailable", reason: "marketplace_unavailable" };
    marketplaces.push(marketplace);
  }

  const trustedMarketplaces = marketplaces.filter((entry) => entry.name === TRUSTED_MARKETPLACE_NAME);
  if (trustedMarketplaces.length !== 1) {
    return { status: "unavailable", reason: "marketplace_unavailable" };
  }

  const candidates: Array<{ marketplace: RuntimeMarketplace; plugin: RuntimePlugin }> = [];
  for (const marketplace of marketplaces) {
    for (const value of marketplace.plugins) {
      const plugin = parsePlugin(value);
      if (!plugin) return { status: "unavailable", reason: "plugin_unavailable" };
      if (plugin.id === CHROME_PLUGIN_ID || plugin.name === CHROME_PLUGIN_NAME) {
        candidates.push({ marketplace, plugin });
      }
    }
  }

  if (candidates.length !== 1) return { status: "unavailable", reason: "plugin_unavailable" };
  const candidate = candidates[0];
  if (!candidate
    || candidate.marketplace !== trustedMarketplaces[0]
    || candidate.plugin.id !== CHROME_PLUGIN_ID
    || candidate.plugin.name !== CHROME_PLUGIN_NAME) {
    return { status: "unavailable", reason: "plugin_unavailable" };
  }

  return { status: "selected", value: { plugin: candidate.plugin } };
}

function getTrustedLocalSourcePath(source: unknown): string | undefined {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined;
  if (Object.keys(source).sort().join(",") !== "path,type") return undefined;
  if (!("type" in source) || !("path" in source)) return undefined;
  if (source.type !== "local" || typeof source.path !== "string" || !isAbsolute(source.path)) {
    return undefined;
  }
  return source.path;
}

function hasUnambiguousNodeReplJs(response: McpServerStatusListResponse): boolean {
  const values: unknown = response.data;
  if (!Array.isArray(values)) return false;

  const nodeReplServers: Array<{ name: unknown; tools: unknown }> = [];
  for (const value of values) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (!("name" in value) || !("tools" in value)) return false;
    const server = { name: value.name, tools: value.tools };
    if (server.name === NODE_REPL_SERVER_NAME) nodeReplServers.push(server);
  }
  if (nodeReplServers.length !== 1) return false;

  const tools = nodeReplServers[0]?.tools;
  if (tools === null || typeof tools !== "object" || Array.isArray(tools) || !("js" in tools)) return false;
  const jsTool = tools.js;
  if (jsTool === null || typeof jsTool !== "object" || Array.isArray(jsTool) || !("name" in jsTool)) {
    return false;
  }
  return jsTool.name === NODE_REPL_TOOL_NAME;
}

async function validatePluginArtifacts(rootPath: string, pluginVersion: string): Promise<string | undefined> {
  try {
    const rootEntry = await lstat(rootPath);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return undefined;

    const canonicalRoot = await realpath(rootPath);
    const clientPath = join(rootPath, CLIENT_RELATIVE_PATH);
    const manifestPath = join(rootPath, MANIFEST_RELATIVE_PATH);
    const [clientEntry, manifestEntry] = await Promise.all([lstat(clientPath), lstat(manifestPath)]);
    if (!clientEntry.isFile() || clientEntry.isSymbolicLink()) return undefined;
    if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink() || manifestEntry.size > MAX_MANIFEST_BYTES) {
      return undefined;
    }

    const [canonicalClient, canonicalManifest] = await Promise.all([
      realpath(clientPath),
      realpath(manifestPath),
    ]);
    if (relative(canonicalRoot, canonicalClient) !== CLIENT_RELATIVE_PATH) return undefined;
    if (relative(canonicalRoot, canonicalManifest) !== MANIFEST_RELATIVE_PATH) return undefined;

    const manifestText = await readFile(canonicalManifest, "utf8");
    const manifest: unknown = JSON.parse(manifestText);
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return undefined;
    if (!("name" in manifest) || !("version" in manifest)) return undefined;
    if (manifest.name !== CHROME_PLUGIN_NAME || manifest.version !== pluginVersion) {
      return undefined;
    }

    return canonicalClient;
  } catch {
    return undefined;
  }
}

function parseMarketplace(value: unknown): RuntimeMarketplace | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!("name" in value) || !("plugins" in value)) return undefined;
  if (typeof value.name !== "string" || !Array.isArray(value.plugins)) return undefined;
  return { name: value.name, plugins: value.plugins };
}

function parsePlugin(value: unknown): RuntimePlugin | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return {
    id: "id" in value ? value.id : undefined,
    name: "name" in value ? value.name : undefined,
    installed: "installed" in value ? value.installed : undefined,
    enabled: "enabled" in value ? value.enabled : undefined,
    availability: "availability" in value ? value.availability : undefined,
    localVersion: "localVersion" in value ? value.localVersion : undefined,
    source: "source" in value ? value.source : undefined,
  };
}
