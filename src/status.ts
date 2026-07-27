import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { AppServerClient } from "./app-server-client";
import {
  DEFAULT_DIRECT_MCP_SERVER_NAME,
  DEFAULT_PLUGIN_NAME,
  evaluateComputerUseCapabilities,
} from "./computer-use-capabilities";
import { ComputerUseTransport, type ComputerUseRoute } from "./computer-use-transport";
import { COMPUTER_USE_MCP_TOOL_NAMES } from "./computer-use-tools";
import type { InitializeResponse, McpServerStatusListResponse, PluginListResponse, PluginSummary } from "./protocol";
import { CodexThreadManager } from "./thread-manager";

export { DEFAULT_PLUGIN_NAME, findPlugin } from "./computer-use-capabilities";

const execFileAsync = promisify(execFile);

export const DEFAULT_CODEX_APP_PATH = "/Applications/Codex.app";
export const DEFAULT_CHATGPT_APP_PATH = "/Applications/ChatGPT.app";
export const DEFAULT_MCP_SERVER_NAME = DEFAULT_DIRECT_MCP_SERVER_NAME;
const EXPECTED_MCP_TOOL_NAME_LOOKUP = Object.fromEntries(
  COMPUTER_USE_MCP_TOOL_NAMES.map((toolName) => [toolName, true] as const),
) as Record<string, true>;

export type ComputerUseStatusReason =
  | "ready"
  | "codex_missing"
  | "marketplace_missing"
  | "plugin_not_installed"
  | "plugin_disabled"
  | "mcp_missing"
  | "mcp_incomplete"
  | "check_failed";

export interface ComputerUseStatus {
  reason: ComputerUseStatusReason;
  message: string;
  codexVersion?: string;
  appServer?: InitializeResponse;
  codexAppPath?: string;
  marketplace?: { name: string; path?: string | null };
  plugin?: PluginSummary;
  transportRoute?: ComputerUseRoute;
  mcpServer?: { name: string; toolNames: string[] };
  nodeReplServer?: { name: string; toolNames: string[] };
  missingToolNames?: string[];
  nodeReplMissingToolNames?: string[];
  extraToolNames?: string[];
  error?: string;
}

export interface StatusEvaluationInput {
  codexVersion?: string;
  codexAppPath?: string;
  codexAppExists?: boolean;
  appServer: InitializeResponse;
  plugins: PluginListResponse;
  mcp: McpServerStatusListResponse;
  transportRoute?: ComputerUseRoute;
  transportError?: string;
}

export async function checkComputerUseStatus(cwd: string): Promise<ComputerUseStatus> {
  let codexVersion: string | undefined;
  try {
    codexVersion = await getCodexVersion();
  } catch (error) {
    return {
      reason: "codex_missing",
      message: "Codex CLI was not found. Install Codex and ensure `codex` is on PATH.",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const [codexAppExists, chatGptAppExists] = await Promise.all([
    pathExists(DEFAULT_CODEX_APP_PATH),
    pathExists(DEFAULT_CHATGPT_APP_PATH),
  ]);
  const codexAppPath = codexAppExists
    ? DEFAULT_CODEX_APP_PATH
    : chatGptAppExists
      ? DEFAULT_CHATGPT_APP_PATH
      : undefined;
  const client = new AppServerClient({ requestTimeoutMs: 60_000 });

  try {
    const appServer = await client.requestWithNotification<InitializeResponse>(
      "initialize",
      {
        clientInfo: { name: "omp-codex-computer", version: "0.1.1" },
        capabilities: { experimentalApi: true },
      },
      "initialized",
    );
    const plugins = await client.request<PluginListResponse>("plugin/list", {});
    const mcp = await client.request<McpServerStatusListResponse>("mcpServerStatus/list", {});
    let transportRoute: ComputerUseRoute | undefined;
    let transportError: string | undefined;
    try {
      const threads = new CodexThreadManager(client);
      const transport = new ComputerUseTransport(client, threads);
      transportRoute = await transport.prepare(cwd, { plugins, mcp });
    } catch (error) {
      transportError = sanitizeTransportError(error);
    }
    return evaluateComputerUseStatus({
      codexVersion,
      codexAppPath,
      appServer,
      plugins,
      mcp,
      transportRoute,
      transportError,
    });
  } catch (error) {
    return {
      reason: "check_failed",
      message: "Computer Use status check failed while talking to Codex app-server.",
      codexVersion,
      codexAppPath,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.stop();
  }
}

export function evaluateComputerUseStatus(input: StatusEvaluationInput): ComputerUseStatus {
  const { codexVersion, appServer, plugins, mcp, transportRoute, transportError } = input;
  const codexAppPath = input.codexAppPath ?? (input.codexAppExists ? DEFAULT_CODEX_APP_PATH : undefined);
  const capabilities = evaluateComputerUseCapabilities(plugins, mcp);
  const { pluginMatch: match, direct, nodeRepl, preferredRoute } = capabilities;
  const capabilityDetails = {
    mcpServer: { name: direct.name, toolNames: direct.toolNames },
    nodeReplServer: { name: nodeRepl.name, toolNames: nodeRepl.toolNames },
  };

  if (!match) {
    return {
      reason: "marketplace_missing",
      message: `No Codex marketplace currently lists ${DEFAULT_PLUGIN_NAME}.`,
      codexVersion,
      appServer,
      codexAppPath,
      ...capabilityDetails,
    };
  }

  const pluginDetails = {
    marketplace: { name: match.marketplace.name, path: match.marketplace.path },
    plugin: match.plugin,
  };
  if (!match.plugin.installed) {
    return {
      reason: "plugin_not_installed",
      message: `${DEFAULT_PLUGIN_NAME} is available in marketplace ${match.marketplace.name}, but is not installed.`,
      codexVersion,
      appServer,
      codexAppPath,
      ...pluginDetails,
      ...capabilityDetails,
    };
  }

  if (!match.plugin.enabled) {
    return {
      reason: "plugin_disabled",
      message: `${DEFAULT_PLUGIN_NAME} is installed but disabled.`,
      codexVersion,
      appServer,
      codexAppPath,
      ...pluginDetails,
      ...capabilityDetails,
    };
  }

  const extraToolNames = direct.toolNames.filter((toolName: string) => !EXPECTED_MCP_TOOL_NAME_LOOKUP[toolName]);
  if (transportError) {
    const status: ComputerUseStatus = {
      reason: "mcp_incomplete",
      message: `${DEFAULT_PLUGIN_NAME} is enabled, but the transport probe failed before a route could be confirmed.`,
      codexVersion,
      appServer,
      codexAppPath,
      ...pluginDetails,
      ...capabilityDetails,
      missingToolNames: direct.missingToolNames,
      nodeReplMissingToolNames: nodeRepl.missingToolNames,
      error: transportError,
    };
    if (extraToolNames.length > 0) status.extraToolNames = extraToolNames;
    return status;
  }

  if (!transportRoute) {
    const missing = direct.toolNames.length === 0 && nodeRepl.toolNames.length === 0;
    const status: ComputerUseStatus = {
      reason: missing ? "mcp_missing" : "mcp_incomplete",
      message: missing
        ? `${DEFAULT_PLUGIN_NAME} is enabled, but neither direct MCP nor node_repl exposes Computer Use tools.`
        : preferredRoute
          ? `${DEFAULT_PLUGIN_NAME} capabilities are available, but no transport route was observed.`
          : `${DEFAULT_PLUGIN_NAME} is enabled, but neither Sky/node_repl nor direct MCP has a complete required tool set.`,
      codexVersion,
      appServer,
      codexAppPath,
      ...pluginDetails,
      ...capabilityDetails,
      missingToolNames: direct.missingToolNames,
      nodeReplMissingToolNames: nodeRepl.missingToolNames,
    };
    if (extraToolNames.length > 0) status.extraToolNames = extraToolNames;
    return status;
  }

  const routeName = transportRoute === "sky" ? "Sky/node_repl" : "direct MCP";
  const status: ComputerUseStatus = {
    reason: "ready",
    message: `Codex Computer Use is installed, enabled, and ready via ${routeName}.`,
    codexVersion,
    appServer,
    codexAppPath,
    ...pluginDetails,
    transportRoute,
    ...capabilityDetails,
  };
  if (extraToolNames.length > 0) status.extraToolNames = extraToolNames;
  return status;
}

function sanitizeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return "Computer Use transport probe failed.";

  const message = error.message.replace(/\s+/g, " ").trim();
  if (message.length === 0) return "Computer Use transport probe failed.";
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

export function formatComputerUseStatus(status: ComputerUseStatus): string {
  const lines = [
    `Computer Use status: ${status.reason}`,
    status.message,
    "",
    `Codex CLI: ${status.codexVersion ?? "unknown"}`,
    `Host app hint: ${status.codexAppPath ? `${status.codexAppPath} (non-authoritative)` : "none found at known paths (non-authoritative)"}`,
  ];

  if (status.appServer) lines.push(`App-server: ${status.appServer.userAgent}`);
  if (status.transportRoute) {
    const routeName = status.transportRoute === "sky" ? "Sky/node_repl" : "direct MCP";
    lines.push(`Transport route: ${status.transportRoute} (${routeName})`);
  }
  if (status.marketplace) {
    lines.push(`Marketplace: ${status.marketplace.name}${status.marketplace.path ? ` (${status.marketplace.path})` : ""}`);
  }
  if (status.plugin) {
    lines.push(
      `Plugin: ${status.plugin.name} installed=${status.plugin.installed} enabled=${status.plugin.enabled} version=${status.plugin.localVersion ?? "unknown"}`,
    );
  }
  if (status.mcpServer) {
    lines.push(`Direct MCP server: ${status.mcpServer.name}`);
    lines.push(`Direct MCP tools: ${formatToolNames(status.mcpServer.toolNames)}`);
  }
  if (status.nodeReplServer) {
    lines.push(`node_repl server: ${status.nodeReplServer.name}`);
    lines.push(`node_repl tools: ${formatToolNames(status.nodeReplServer.toolNames)}`);
  }
  if (status.missingToolNames?.length) {
    lines.push(`Missing direct MCP tools: ${status.missingToolNames.join(", ")}`);
  }
  if (status.nodeReplMissingToolNames?.length) {
    lines.push(`Missing node_repl tools: ${status.nodeReplMissingToolNames.join(", ")}`);
  }
  if (status.extraToolNames?.length) {
    lines.push(`Additional upstream MCP tools not exposed by adapter: ${status.extraToolNames.join(", ")}`);
  }
  if (status.error) lines.push(`Error: ${status.error}`);

  return lines.join("\n");
}

function formatToolNames(toolNames: string[]): string {
  return toolNames.length > 0 ? toolNames.join(", ") : "none";
}

async function getCodexVersion(): Promise<string> {
  const result = await execFileAsync("codex", ["--version"], { timeout: 10_000 });
  return result.stdout.trim() || result.stderr.trim() || "codex found";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
