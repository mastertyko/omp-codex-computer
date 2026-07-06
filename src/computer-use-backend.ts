import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { convertCodexContentToOmpContent, type OmpContentBlock } from "./content";
import { logDebug } from "./log";
import { SerialQueue } from "./queue";
import { formatAppTargetResolution, formatInvalidAppDiagnostic, resolveAppTargetFromList } from "./app-target-resolver";
import type { AppServerClient } from "./app-server-client";
import type { CodexThreadManager } from "./thread-manager";

export interface ComputerUseBackendOptions {
  mcpServerName?: string;
  resetStoppedSession?: () => Promise<void>;
}

export interface ComputerUseToolResult {
  content: OmpContentBlock[];
  structuredContent?: unknown;
  meta?: unknown;
}

interface RawMcpToolCallResponse {
  content: unknown;
  structuredContent?: unknown;
  _meta?: unknown;
  isError?: boolean | null;
}

const execFileAsync = promisify(execFile);
function textContentFromRawContent(content: unknown): string {
  return convertCodexContentToOmpContent(content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const STOPPED_APPLICATION_SESSION_TEXT = "This application session has been explicitly stopped by the user for this turn.";

class McpToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolCallError";
  }
}

class ComputerUseSessionStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerUseSessionStoppedError";
  }
}

export class ComputerUseBackend {
  private readonly queue = new SerialQueue();
  private readonly mcpServerName: string;
  private readonly resetStoppedSession: () => Promise<void>;

  constructor(
    private readonly client: Pick<AppServerClient, "request">,
    private readonly threads: Pick<CodexThreadManager, "getThreadId" | "reset">,
    options: ComputerUseBackendOptions = {},
  ) {
    this.mcpServerName = options.mcpServerName ?? "computer-use";
    this.resetStoppedSession = options.resetStoppedSession ?? resetStoppedComputerUseSession;
  }

  async callTool(
    cwd: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ComputerUseToolResult> {
    return this.queue.enqueue(async () => {
      throwIfAborted(signal, `Aborted Computer Use tool call ${tool}`);
      logDebug("computer-use.tool.start", { tool, argKeys: Object.keys(args) });
      return await this.callToolWithRetry(cwd, tool, args, signal);
    });
  }

  async resolveAppTarget(cwd: string, app: string, signal?: AbortSignal): Promise<ComputerUseToolResult> {
    return this.queue.enqueue(async () => {
      throwIfAborted(signal, `Aborted Computer Use app target resolution for ${app}`);
      logDebug("computer-use.resolve-app.start", { app });
      const listApps = await this.callToolWithRetry(cwd, "list_apps", {}, signal);
      const listAppsText = listApps.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const resolution = resolveAppTargetFromList(app, listAppsText);
      const text = formatAppTargetResolution(resolution);
      logDebug("computer-use.resolve-app.end", { app, status: resolution.status });

      return {
        content: [{ type: "text", text }],
        structuredContent: resolution,
      };
    });
  }

  private async callToolOnce(
    cwd: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ComputerUseToolResult> {
    const threadId = await this.threads.getThreadId(cwd);
    throwIfAborted(signal, `Aborted Computer Use tool call ${tool}`);
    const response = await this.client.request<RawMcpToolCallResponse>("mcpServer/tool/call", {
      server: this.mcpServerName,
      threadId,
      tool,
      arguments: args,
    }, undefined, signal);

    if (response.isError) {
      logDebug("computer-use.tool.error", { tool });
      const text = textContentFromRawContent(response.content);
      if (text.includes(STOPPED_APPLICATION_SESSION_TEXT)) throw new ComputerUseSessionStoppedError(text);
      if (tool === "get_app_state" && /\binvalid app\b/i.test(text) && typeof args.app === "string") {
        throw new McpToolCallError(await this.enrichInvalidAppError(cwd, args.app, text, signal));
      }
      throw new McpToolCallError(text || `${this.mcpServerName}.${tool} failed`);
    }

    const content = convertCodexContentToOmpContent(response.content);
    const stoppedSessionText = content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .find((text) => text.includes(STOPPED_APPLICATION_SESSION_TEXT));
    if (stoppedSessionText) throw new ComputerUseSessionStoppedError(stoppedSessionText);

    logDebug("computer-use.tool.end", { tool, contentTypes: content.map((block) => block.type).join(",") });

    return {
      content,
      structuredContent: response.structuredContent,
      meta: response._meta,
    };
  }

  private async callToolWithRetry(
    cwd: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ComputerUseToolResult> {
    try {
      return await this.callToolOnce(cwd, tool, args, signal);
    } catch (error) {
      if (error instanceof McpToolCallError) throw error;

      if (error instanceof ComputerUseSessionStoppedError) {
        logDebug("computer-use.tool.retry-stopped-session", { tool });
        this.threads.reset();
        await this.resetStoppedSession();
        return this.callToolOnce(cwd, tool, args, signal);
      }

      const message = error instanceof Error ? error.message : String(error);
      if (!/thread not found|invalid thread id/i.test(message)) throw error;

      logDebug("computer-use.tool.retry-thread", { tool });
      this.threads.reset();
      return this.callToolOnce(cwd, tool, args, signal);
    }
  }

  private async enrichInvalidAppError(
    cwd: string,
    app: string,
    originalMessage: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const listApps = await this.callToolOnce(cwd, "list_apps", {}, signal);
      const listAppsText = listApps.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      return formatInvalidAppDiagnostic(originalMessage, app, listAppsText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return formatInvalidAppDiagnostic(originalMessage, app, "", message);
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;

  const error = new Error(message);
  error.name = "AbortError";
  throw error;
}

async function resetStoppedComputerUseSession(): Promise<void> {
  try {
    await execFileAsync("killall", ["SkyComputerUseService"], { timeout: 2_000 });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code !== 1) throw error;
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
}
