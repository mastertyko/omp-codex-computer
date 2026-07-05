import { convertCodexContentToOmpContent, type OmpContentBlock } from "./content";
import { logDebug } from "./log";
import { SerialQueue } from "./queue";
import type { AppServerClient } from "./app-server-client";
import type { CodexThreadManager } from "./thread-manager";

export interface ComputerUseBackendOptions {
  mcpServerName?: string;
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

export class ComputerUseBackend {
  private readonly queue = new SerialQueue();
  private readonly mcpServerName: string;

  constructor(
    private readonly client: Pick<AppServerClient, "request">,
    private readonly threads: Pick<CodexThreadManager, "getThreadId" | "reset">,
    options: ComputerUseBackendOptions = {},
  ) {
    this.mcpServerName = options.mcpServerName ?? "computer-use";
  }

  async callTool(cwd: string, tool: string, args: Record<string, unknown>): Promise<ComputerUseToolResult> {
    return this.queue.enqueue(async () => {
      logDebug("computer-use.tool.start", { tool, argKeys: Object.keys(args) });
      try {
        return await this.callToolOnce(cwd, tool, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/thread not found|invalid thread id/i.test(message)) throw error;

        logDebug("computer-use.tool.retry-thread", { tool });
        this.threads.reset();
        return this.callToolOnce(cwd, tool, args);
      }
    });
  }

  private async callToolOnce(cwd: string, tool: string, args: Record<string, unknown>): Promise<ComputerUseToolResult> {
    const threadId = await this.threads.getThreadId(cwd);
    const response = await this.client.request<RawMcpToolCallResponse>("mcpServer/tool/call", {
      server: this.mcpServerName,
      threadId,
      tool,
      arguments: args,
    });

    if (response.isError) {
      logDebug("computer-use.tool.error", { tool });
      const text = convertCodexContentToOmpContent(response.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      throw new Error(text || `${this.mcpServerName}.${tool} failed`);
    }

    const content = convertCodexContentToOmpContent(response.content);
    logDebug("computer-use.tool.end", { tool, contentTypes: content.map((block) => block.type).join(",") });

    return {
      content,
      structuredContent: response.structuredContent,
      meta: response._meta,
    };
  }
}
