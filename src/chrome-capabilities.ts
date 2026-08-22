import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type {
  InitializeResponse,
  McpServerStatusListResponse,
  PluginListResponse,
} from "./protocol";

export const CHROME_TRUST_ENV_VAR = "OMP_CODEX_CHROME_TRUST";

export interface ChromeTrustedTuple {
  pluginVersion: string;
  appServerVersion: string;
}

// The built-in allowlist only grows through the CONTRIBUTING review process:
// contract review, focused compatibility tests, and a live open/action/close smoke.
const BUILT_IN_TRUSTED_TUPLES: readonly ChromeTrustedTuple[] = Object.freeze([
  Object.freeze({ pluginVersion: "26.818.31338", appServerVersion: "0.149.0" }),
]);

export const SUPPORTED_CHROME_PLUGIN_VERSIONS: readonly string[] = Object.freeze(
  [...new Set(BUILT_IN_TRUSTED_TUPLES.map((tuple) => tuple.pluginVersion))],
);
export const SUPPORTED_CHROME_APP_SERVER_VERSIONS: readonly string[] = Object.freeze(
  [...new Set(BUILT_IN_TRUSTED_TUPLES.map((tuple) => tuple.appServerVersion))],
);

const TRUSTED_MARKETPLACE_NAME = "openai-bundled";
const CHROME_PLUGIN_ID = "chrome@openai-bundled";
const CHROME_PLUGIN_NAME = "chrome";
const NODE_REPL_SERVER_NAME = "node_repl";
const NODE_REPL_TOOL_NAME = "js";
const CLIENT_RELATIVE_PATH = join("scripts", "browser-client.mjs");
const MANIFEST_RELATIVE_PATH = join(".codex-plugin", "plugin.json");
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SAFE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const APP_SERVER_USER_AGENT_PATTERN = /^omp-codex-computer\/([0-9A-Za-z][0-9A-Za-z.+-]{0,63})(?=$|[\s(])/;

export type ChromeUnavailableReason =
  | "app_server_version_unavailable"
  | "unsupported_version_tuple"
  | "marketplace_unavailable"
  | "plugin_unavailable"
  | "plugin_not_installed"
  | "plugin_disabled"
  | "plugin_availability_unavailable"
  | "plugin_source_untrusted"
  | "node_repl_unavailable"
  | "plugin_artifact_untrusted";

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
  unsupported_version_tuple: "Chrome is unavailable because the installed app-server and Chrome plugin versions are not supported together. After your own contract review and live probe, OMP_CODEX_CHROME_TRUST can trust an additional plugin@app-server tuple.",
  marketplace_unavailable: "Chrome is unavailable because the trusted bundled marketplace is missing or ambiguous.",
  plugin_unavailable: "Chrome is unavailable because the bundled Chrome plugin is missing or ambiguous.",
  plugin_not_installed: "Chrome is unavailable because the bundled Chrome plugin is not installed.",
  plugin_disabled: "Chrome is unavailable because the bundled Chrome plugin is disabled.",
  plugin_availability_unavailable: "Chrome is unavailable because the bundled Chrome plugin is not available.",
  plugin_source_untrusted: "Chrome is unavailable because the bundled Chrome plugin source could not be trusted.",
  node_repl_unavailable: "Chrome is unavailable because node_repl/js is not available unambiguously.",
  plugin_artifact_untrusted: "Chrome is unavailable because the bundled Chrome plugin artifacts could not be trusted.",
});

export function getTrustedChromeTuples(env: NodeJS.ProcessEnv = process.env): readonly ChromeTrustedTuple[] {
  const raw = env[CHROME_TRUST_ENV_VAR];
  if (typeof raw !== "string" || raw.trim().length === 0) return BUILT_IN_TRUSTED_TUPLES;

  const tuples = [...BUILT_IN_TRUSTED_TUPLES];
  const seen = new Set(tuples.map((tuple) => `${tuple.pluginVersion}@${tuple.appServerVersion}`));
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split("@");
    if (parts.length !== 2) continue;
    const [pluginVersion, appServerVersion] = parts;
    // Fail closed: malformed entries add no trust.
    if (pluginVersion === undefined
      || appServerVersion === undefined
      || !SAFE_VERSION_PATTERN.test(pluginVersion)
      || !SAFE_VERSION_PATTERN.test(appServerVersion)
      || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    tuples.push({ pluginVersion, appServerVersion });
  }
  return tuples;
}

export function getTrustedChromeVersions(env: NodeJS.ProcessEnv = process.env): {
  pluginVersions: string[];
  appServerVersions: string[];
} {
  const tuples = getTrustedChromeTuples(env);
  return {
    pluginVersions: [...new Set(tuples.map((tuple) => tuple.pluginVersion))],
    appServerVersions: [...new Set(tuples.map((tuple) => tuple.appServerVersion))],
  };
}

export async function evaluateChromeCapabilities(
  initialize: InitializeResponse,
  plugins: PluginListResponse,
  mcp: McpServerStatusListResponse,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChromeCapabilities> {
  const trustedTuples = getTrustedChromeTuples(env);
  const appServerVersion = extractAppServerVersion(initialize);
  if (!appServerVersion) return unavailable("app_server_version_unavailable");
  if (!trustedTuples.some((tuple) => tuple.appServerVersion === appServerVersion)) {
    return unavailable("unsupported_version_tuple");
  }

  const selection = selectChromePlugin(plugins);
  if (selection.status === "unavailable") return unavailable(selection.reason);

  const { plugin } = selection.value;
  if (plugin.installed !== true) return unavailable("plugin_not_installed");
  if (plugin.enabled !== true) return unavailable("plugin_disabled");
  if (plugin.availability !== "AVAILABLE") return unavailable("plugin_availability_unavailable");

  const pluginVersion = plugin.localVersion;
  if (typeof pluginVersion !== "string"
    || !trustedTuples.some((tuple) =>
      tuple.pluginVersion === pluginVersion && tuple.appServerVersion === appServerVersion)) {
    return unavailable("unsupported_version_tuple");
  }

  const sourcePath = getTrustedLocalSourcePath(plugin.source);
  if (!sourcePath) return unavailable("plugin_source_untrusted");
  if (!hasUnambiguousNodeReplJs(mcp)) return unavailable("node_repl_unavailable");

  const clientPath = await validatePluginArtifacts(sourcePath, pluginVersion);
  if (!clientPath) return unavailable("plugin_artifact_untrusted");

  return {
    status: "ready",
    pluginVersion,
    appServerVersion,
    clientPath,
    nodeReplServerName: NODE_REPL_SERVER_NAME,
  };
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
