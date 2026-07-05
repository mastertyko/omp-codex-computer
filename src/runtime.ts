import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AppServerClient, type ServerRequestResponder } from "./app-server-client";
import { ComputerUseBackend, type ComputerUseToolResult } from "./computer-use-backend";
import { logDebug } from "./log";
import type { AppServerRequest, InitializeResponse } from "./protocol";
import { CodexThreadManager } from "./thread-manager";

const CLIENT_INFO = { name: "omp-codex-computer", version: "0.1.0" } as const;
const STATUS_KEY = "codex-computer";
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const PERMISSION_FALLBACK_MESSAGE = "Codex Computer Use requests permission to continue.";

type ContextWithSignal = ExtensionContext & { signal?: AbortSignal };

export class ComputerUseRuntime {
  readonly client = new AppServerClient({ requestTimeoutMs: 120_000 });
  readonly threads = new CodexThreadManager(this.client);
  readonly backend = new ComputerUseBackend(this.client, this.threads);

  private latestContext: ExtensionContext | undefined;
  private initializePromise: Promise<InitializeResponse> | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.client.onServerRequest((request, responder) => this.handleServerRequest(request, responder));
  }

  setContext(ctx: ExtensionContext): void {
    this.latestContext = ctx;
  }

  resetSession(): void {
    this.threads.reset();
  }

  async shutdown(): Promise<void> {
    logDebug("runtime.shutdown");
    this.clearIdleTimer();
    this.initializePromise = undefined;
    this.threads.reset();
    await this.client.stop();
    this.setStatus("idle");
  }

  async initialize(): Promise<InitializeResponse> {
    if (!this.client.isRunning()) {
      this.initializePromise = undefined;
      this.threads.reset();
    }

    this.initializePromise ??= this.client.request<InitializeResponse>("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
    return this.initializePromise;
  }

  async callTool(ctx: ExtensionContext, tool: string, args: Record<string, unknown>): Promise<ComputerUseToolResult> {
    this.setContext(ctx);
    this.clearIdleTimer();
    this.setStatus(typeof args.app === "string" ? `working: ${args.app}` : "working");

    try {
      await this.initialize();
      const result = await this.backend.callTool(ctx.cwd, tool, args);
      this.setStatus("ready");
      return result;
    } catch (error) {
      this.setStatus("error");
      throw error;
    } finally {
      this.scheduleIdleShutdown();
    }
  }

  async handleServerRequestForTest(request: AppServerRequest, responder: ServerRequestResponder): Promise<void> {
    await this.handleServerRequest(request, responder);
  }

  private async handleServerRequest(request: AppServerRequest, responder: ServerRequestResponder): Promise<void> {
    if (request.method !== "mcpServer/elicitation/request") {
      responder.reject({
        code: -32601,
        message: `Unsupported Codex app-server request: ${request.method}`,
      });
      return;
    }

    const params = getElicitationParams(request.params);
    const message = params.message ?? PERMISSION_FALLBACK_MESSAGE;
    this.setStatus("permission");
    logDebug("elicitation.request", {
      method: request.method,
      serverName: params.serverName,
      hasMessage: params.message !== undefined,
    });

    if (shouldDevAutoAccept(message)) {
      logDebug("elicitation.accept.dev", { serverName: params.serverName });
      responder.accept({ action: "accept", content: {} });
      return;
    }

    const ctx = this.latestContext;
    if (!ctx?.hasUI) {
      logDebug("elicitation.decline.no-ui", { serverName: params.serverName });
      responder.accept({ action: "decline", content: null });
      return;
    }

    const signal = (ctx as ContextWithSignal).signal;
    const approved = await ctx.ui.confirm(
      "Codex Computer Use permission",
      message,
      signal ? { signal } : undefined,
    );
    logDebug(approved ? "elicitation.accept.user" : "elicitation.decline.user", { serverName: params.serverName });
    responder.accept({ action: approved ? "accept" : "decline", content: approved ? {} : null });
  }

  private setStatus(value: string): void {
    const ctx = this.latestContext;
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, `Codex Computer: ${value}`);
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    const timeoutMs = getIdleTimeoutMs();
    if (timeoutMs === undefined) return;

    this.idleTimer = setTimeout(() => {
      void this.shutdown();
    }, timeoutMs);
    this.idleTimer.unref();
  }
}

export function shouldDevAutoAccept(message: string): boolean {
  const apps = (process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS ?? "")
    .split(",")
    .map((app) => app.trim())
    .filter(Boolean);
  if (apps.length === 0) return false;

  const match = /^Allow Codex to use (.+?)\?$/.exec(message.trim());
  if (!match) return false;

  const requestedApp = match[1].trim();
  return apps.some((app) => app.localeCompare(requestedApp, undefined, { sensitivity: "accent" }) === 0);
}

function getElicitationParams(params: unknown): { message?: string; serverName?: string } {
  if (!params || typeof params !== "object") return {};

  const record = params as Record<string, unknown>;
  return {
    message: typeof record.message === "string" ? record.message : undefined,
    serverName: typeof record.serverName === "string" ? record.serverName : undefined,
  };
}

function getIdleTimeoutMs(): number | undefined {
  const raw = process.env.OMP_CODEX_COMPUTER_IDLE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_IDLE_TIMEOUT_MS;

  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) return undefined;

  const parsed = Number.parseInt(normalized, 10);
  if (parsed <= 0) return undefined;
  return parsed;
}
