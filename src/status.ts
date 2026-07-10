import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppServerClient } from "./app-server-client";
import { COMPUTER_USE_MCP_TOOL_NAMES } from "./computer-use-tools";
import type { InitializeResponse, McpServerStatusListResponse } from "./protocol";
import { CodexThreadManager } from "./thread-manager";

const execFileAsync = promisify(execFile);

export const DEFAULT_MCP_SERVER_NAME = "computer-use";
const EXPECTED_MCP_TOOL_NAME_LOOKUP = Object.fromEntries(
  COMPUTER_USE_MCP_TOOL_NAMES.map((toolName) => [toolName, true] as const),
) as Record<string, true>;

export type ComputerUseStatusReason =
  | "ready"
  | "codex_missing"
  | "mcp_missing"
  | "mcp_incomplete"
  | "check_failed";

export interface ComputerUseStatus {
  reason: ComputerUseStatusReason;
  message: string;
  codexVersion?: string;
  appServer?: InitializeResponse;
  mcpServer?: { name: string; toolNames: string[] };
  missingToolNames?: string[];
  extraToolNames?: string[];
  error?: string;
}

export interface StatusEvaluationInput {
  codexVersion?: string;
  appServer: InitializeResponse;
  mcp: McpServerStatusListResponse;
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

  const client = new AppServerClient({ requestTimeoutMs: 60_000 });
  const threads = new CodexThreadManager(client);

  try {
    const appServer = await client.request<InitializeResponse>("initialize", {
      clientInfo: { name: "omp-codex-computer", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    await client.notify("initialized");

    const threadId = await threads.getThreadId(cwd);
    const data: McpServerStatusListResponse["data"] = [];
    let cursor: string | null | undefined;
    do {
      const page = await client.request<McpServerStatusListResponse>(
        "mcpServerStatus/list",
        cursor ? { threadId, cursor } : { threadId },
      );
      data.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);

    return evaluateComputerUseStatus({ codexVersion, appServer, mcp: { data } });
  } catch (error) {
    return {
      reason: "check_failed",
      message: "Computer Use status check failed while talking to Codex app-server.",
      codexVersion,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.stop();
  }
}

export function evaluateComputerUseStatus(input: StatusEvaluationInput): ComputerUseStatus {
  const { codexVersion, appServer, mcp } = input;
  const server = mcp.data.find((entry) => entry.name === DEFAULT_MCP_SERVER_NAME);
  if (!server || Object.keys(server.tools).length === 0) {
    return {
      reason: "mcp_missing",
      message: `${DEFAULT_MCP_SERVER_NAME} MCP server/tools are not available.`,
      codexVersion,
      appServer,
    };
  }

  const toolNames = Object.keys(server.tools).sort();
  const missingToolNames = COMPUTER_USE_MCP_TOOL_NAMES.filter((toolName) => !Object.hasOwn(server.tools, toolName));
  const extraToolNames = toolNames.filter((toolName) => !EXPECTED_MCP_TOOL_NAME_LOOKUP[toolName]);
  if (missingToolNames.length > 0) {
    const status: ComputerUseStatus = {
      reason: "mcp_incomplete",
      message: `${DEFAULT_MCP_SERVER_NAME} MCP server is missing required tools: ${missingToolNames.join(", ")}.`,
      codexVersion,
      appServer,
      mcpServer: { name: server.name, toolNames },
      missingToolNames,
    };
    if (extraToolNames.length > 0) status.extraToolNames = extraToolNames;
    return status;
  }

  const status: ComputerUseStatus = {
    reason: "ready",
    message: "Codex Computer Use is exposing all required MCP tools.",
    codexVersion,
    appServer,
    mcpServer: { name: server.name, toolNames },
  };
  if (extraToolNames.length > 0) status.extraToolNames = extraToolNames;
  return status;
}

export function formatComputerUseStatus(status: ComputerUseStatus): string {
  const lines = [
    `Computer Use status: ${status.reason}`,
    status.message,
    "",
    `Codex CLI: ${status.codexVersion ?? "unknown"}`,
  ];

  if (status.appServer) lines.push(`App-server: ${status.appServer.userAgent}`);
  if (status.mcpServer) {
    lines.push(`MCP server: ${status.mcpServer.name}`);
    lines.push(`MCP tools: ${status.mcpServer.toolNames.join(", ")}`);
  }
  if (status.missingToolNames?.length) lines.push(`Missing MCP tools: ${status.missingToolNames.join(", ")}`);
  if (status.extraToolNames?.length) {
    lines.push(`Additional upstream MCP tools not exposed by adapter: ${status.extraToolNames.join(", ")}`);
  }
  if (status.error) lines.push(`Error: ${status.error}`);

  return lines.join("\n");
}

async function getCodexVersion(): Promise<string> {
  const result = await execFileAsync("codex", ["--version"], { timeout: 10_000 });
  return result.stdout.trim() || result.stderr.trim() || "codex found";
}

