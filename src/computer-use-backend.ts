import { convertCodexContentToOmpContent, type OmpContentBlock } from "./content";
import { logDebug } from "./log";
import { SerialQueue } from "./queue";
import {
  formatAppTargetResolution,
  formatInvalidAppDiagnostic,
  resolveAppTargetFromList,
  resolveAppTargetFromStructuredList,
} from "./app-target-resolver";
import { AppServerRequestError, type AppServerClient } from "./app-server-client";
import type { CodexThreadManager } from "./thread-manager";
import {
  ComputerUseTransport,
  SkyComputerUseError,
  type RawComputerUseToolCallResponse,
} from "./computer-use-transport";

export interface ComputerUseBackendOptions {
  mcpServerName?: string;
}

export interface ComputerUseToolResult {
  content: OmpContentBlock[];
  structuredContent?: unknown;
  meta?: unknown;
}

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
  private readonly transport: ComputerUseTransport;

  constructor(
    client: Pick<AppServerClient, "request">,
    private readonly threads: Pick<CodexThreadManager, "getThreadId" | "reset">,
    options: ComputerUseBackendOptions = {},
  ) {
    this.transport = new ComputerUseTransport(client, threads, {
      directMcpServerName: options.mcpServerName,
    });
  }

  reset(): void {
    this.threads.reset();
    this.transport.reset();
  }

  async callTool(
    cwd: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ComputerUseToolResult> {
    return this.queue.enqueue(async () => {
      throwIfAborted(signal, `Aborted Computer Use tool call ${tool}`);
      logDebug("computer-use.tool.start", { tool });
      return await this.callToolWithRetry(cwd, tool, args, signal);
    });
  }

  async resolveAppTarget(cwd: string, app: string, signal?: AbortSignal): Promise<ComputerUseToolResult> {
    return this.queue.enqueue(async () => {
      throwIfAborted(signal, `Aborted Computer Use app target resolution for ${app}`);
      logDebug("computer-use.resolve-app.start", { tool: "list_apps" });
      const listApps = await this.callToolWithRetry(cwd, "list_apps", {}, signal);
      const listAppsText = listApps.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const resolution = resolveAppTargetFromStructuredList(app, listApps.structuredContent)
        ?? resolveAppTargetFromList(app, listAppsText);
      const text = formatAppTargetResolution(resolution);
      logDebug("computer-use.resolve-app.end", { tool: "list_apps" });

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
    let response: RawComputerUseToolCallResponse;
    try {
      response = await this.transport.callTool(cwd, tool, args, signal);
    } catch (error) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      if (getNumericErrorCode(error) === -10012
        || originalMessage.includes(STOPPED_APPLICATION_SESSION_TEXT)) throw error;
      if (tool === "get_app_state" && isInvalidAppError(error) && typeof args.app === "string") {
        const enrichedMessage = await this.enrichInvalidAppError(cwd, args.app, originalMessage, signal);
        if (error instanceof SkyComputerUseError) throw error.withMessage(enrichedMessage);
        if (error instanceof AppServerRequestError) throw error.withMessage(enrichedMessage);
        throw new McpToolCallError(enrichedMessage);
      }
      throw error;
    }

    if (response.isError) {
      logDebug("computer-use.tool.error", { route: response.route, tool });
      const text = textContentFromRawContent(response.content);
      if (text.includes(STOPPED_APPLICATION_SESSION_TEXT)) throw new ComputerUseSessionStoppedError(text);
      if (tool === "get_app_state" && /\binvalid app\b/i.test(text) && typeof args.app === "string") {
        throw new McpToolCallError(await this.enrichInvalidAppError(cwd, args.app, text, signal));
      }
      throw new McpToolCallError(text || `${tool} failed through the ${response.route} transport`);
    }

    const content = convertCodexContentToOmpContent(response.content);
    const stoppedSessionText = content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .find((text) => text.includes(STOPPED_APPLICATION_SESSION_TEXT));
    if (stoppedSessionText) throw new ComputerUseSessionStoppedError(stoppedSessionText);

    logDebug("computer-use.tool.end", {
      route: response.route,
      tool,
      blockTypes: content.map((block) => block.type).join(","),
    });

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
    mayRetryStaleThread = true,
  ): Promise<ComputerUseToolResult> {
    try {
      return await this.callToolOnce(cwd, tool, args, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stoppedSession = error instanceof ComputerUseSessionStoppedError
        || getNumericErrorCode(error) === -10012
        || message.includes(STOPPED_APPLICATION_SESSION_TEXT);
      if (stoppedSession) {
        logDebug("computer-use.tool.reset-stopped-session", {
          tool,
          errorCode: getNumericErrorCode(error),
        });
        this.reset();
        throw error;
      }

      if (error instanceof McpToolCallError) throw error;
      const staleThread = /thread not found|invalid thread id/i.test(message);
      const preDispatch = !(error instanceof SkyComputerUseError) || error.phase === "bootstrap";
      if (!mayRetryStaleThread || !staleThread || !preDispatch) throw error;

      logDebug("computer-use.tool.reset-thread", {
        tool,
        errorCode: getNumericErrorCode(error),
      });
      this.reset();
      return this.callToolWithRetry(cwd, tool, args, signal, false);
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
      return formatInvalidAppDiagnostic(originalMessage, app, listAppsText, undefined, listApps.structuredContent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ComputerUseSessionStoppedError
        || getNumericErrorCode(error) === -10012
        || message.includes(STOPPED_APPLICATION_SESSION_TEXT)) throw error;
      return formatInvalidAppDiagnostic(originalMessage, app, "", message);
    }
  }
}

function isInvalidAppError(error: unknown): boolean {
  return getNumericErrorCode(error) === -10010
    || (error instanceof Error && /\binvalid app\b/i.test(error.message));
}

function getNumericErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;

  const error = new Error(message);
  error.name = "AbortError";
  throw error;
}

