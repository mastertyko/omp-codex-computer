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

  const pluginReady = !!pluginMatch?.plugin.installed && !!pluginMatch.plugin.enabled;
  const skyComplete = pluginReady && nodeRepl.complete;
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
