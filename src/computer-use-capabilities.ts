import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { COMPUTER_USE_MCP_TOOL_NAMES } from "./computer-use-tools";
import type {
  McpServerStatusListResponse,
  PluginListResponse,
  PluginMarketplaceEntry,
  PluginSummary,
} from "./protocol";

export const DEFAULT_PLUGIN_NAME = "computer-use";
export const DEFAULT_DIRECT_MCP_SERVER_NAME = "computer-use";
export const DEFAULT_NODE_REPL_SERVER_NAME = "node_repl";
export const NODE_REPL_REQUIRED_TOOL_NAMES = Object.freeze(["js"] as const);
const TRUSTED_PLUGIN_MARKETPLACE_NAMES = ["openai-bundled", "openai-curated"] as const;

export interface ComputerUsePluginMatch {
  marketplace: PluginMarketplaceEntry;
  plugin: PluginSummary;
}

export interface ComputerUseServerCapabilities {
  name: string;
  toolNames: string[];
  missingToolNames: string[];
  complete: boolean;
}

export interface ComputerUseCapabilities {
  pluginMatch?: ComputerUsePluginMatch;
  marketplaceRoot?: string;
  pluginRoot?: string;
  direct: ComputerUseServerCapabilities;
  nodeRepl: ComputerUseServerCapabilities;
  preferredRoute?: "sky" | "direct";
}

export function findPlugin(response: PluginListResponse, name: string): ComputerUsePluginMatch | undefined {
  for (const marketplaceName of TRUSTED_PLUGIN_MARKETPLACE_NAMES) {
    const marketplace = response.marketplaces.find((entry) => entry.name === marketplaceName);
    const plugin = marketplace?.plugins.find((entry) => entry.name === name);
    if (marketplace && plugin) return { marketplace, plugin };
  }

  return undefined;
}

export function evaluateComputerUseCapabilities(
  plugins: PluginListResponse,
  mcp: McpServerStatusListResponse,
): ComputerUseCapabilities {
  const pluginMatch = findPlugin(plugins, DEFAULT_PLUGIN_NAME);
  const marketplaceRoot = getMarketplaceRoot(pluginMatch?.marketplace.path);
  const pluginRoot = pluginMatch && marketplaceRoot
    ? getAbsolutePluginRoot(pluginMatch, marketplaceRoot)
    : undefined;
  const direct = evaluateServer(
    mcp,
    DEFAULT_DIRECT_MCP_SERVER_NAME,
    COMPUTER_USE_MCP_TOOL_NAMES,
  );
  const nodeRepl = evaluateServer(
    mcp,
    DEFAULT_NODE_REPL_SERVER_NAME,
    NODE_REPL_REQUIRED_TOOL_NAMES,
  );

  const capabilities: ComputerUseCapabilities = { direct, nodeRepl };
  if (pluginMatch) capabilities.pluginMatch = pluginMatch;
  if (marketplaceRoot) capabilities.marketplaceRoot = marketplaceRoot;
  if (pluginRoot) capabilities.pluginRoot = pluginRoot;

  const pluginReady = !!pluginMatch?.plugin.installed && !!pluginMatch.plugin.enabled;
  const skyComplete = pluginReady
    && pluginRoot !== undefined
    && nodeRepl.complete;
  if (skyComplete) capabilities.preferredRoute = "sky";
  else if (pluginReady && direct.complete) capabilities.preferredRoute = "direct";

  return capabilities;
}

function evaluateServer(
  response: McpServerStatusListResponse,
  name: string,
  requiredToolNames: readonly string[],
): ComputerUseServerCapabilities {
  const server = response.data.find((entry) => entry.name === name);
  const toolNames = server ? Object.keys(server.tools).sort() : [];
  const availableToolNames = new Set(toolNames);
  const missingToolNames = requiredToolNames.filter((toolName) => !availableToolNames.has(toolName));

  return {
    name,
    toolNames,
    missingToolNames,
    complete: missingToolNames.length === 0,
  };
}

function getAbsolutePluginRoot(match: ComputerUsePluginMatch, marketplaceRoot: string): string | undefined {
  if (!match.plugin.source || typeof match.plugin.source !== "object") return undefined;

  const source = match.plugin.source as Record<string, unknown>;
  if (typeof source.path !== "string" || !isAbsolute(source.path)) return undefined;
  return isStrictlyWithin(marketplaceRoot, source.path) ? source.path : undefined;
}

function getMarketplaceRoot(path: string | null | undefined): string | undefined {
  if (typeof path !== "string" || !isAbsolute(path)) return undefined;
  if (basename(path) !== "marketplace.json") return path;

  const metadataDirectory = dirname(path);
  const metadataDirectoryName = basename(metadataDirectory);
  if (metadataDirectoryName === ".claude-plugin" || metadataDirectoryName === ".codex-plugin") {
    return dirname(metadataDirectory);
  }
  if (metadataDirectoryName !== "plugins") return undefined;

  const agentsDirectory = dirname(metadataDirectory);
  return basename(agentsDirectory) === ".agents" ? dirname(agentsDirectory) : undefined;
}

function isStrictlyWithin(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}
