import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AppServerClient, type ServerRequestResponder } from "./app-server-client";
import { ComputerUseBackend, type ComputerUseToolResult } from "./computer-use-backend";
import { logDebug } from "./log";
import type { AppServerRequest, InitializeResponse } from "./protocol";
import { SerialQueue } from "./queue";
import { CodexThreadManager } from "./thread-manager";

const CLIENT_INFO = { name: "omp-codex-computer", version: "0.1.0" } as const;
const COMPUTER_STATUS_KEY = "codex-computer";
const COMPUTER_STATUS_LABEL = "💻 codex";
const STATUS_DISABLED_VALUES: Record<string, true> = {
  "0": true,
  false: true,
  off: true,
  no: true,
  disabled: true,
  hidden: true,
  hide: true,
};
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const PERMISSION_FALLBACK_MESSAGE = "Codex requests permission to continue.";

type ContextWithSignal = ExtensionContext & { signal?: AbortSignal };

export class ComputerUseRuntime {
  readonly client = new AppServerClient({ requestTimeoutMs: 120_000 });
  readonly threads = new CodexThreadManager(this.client);
  readonly backend = new ComputerUseBackend(this.client, this.threads);
  private readonly callToolQueue = new SerialQueue();

  private latestContext: ExtensionContext | undefined;
  private initializePromise: Promise<InitializeResponse> | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private statusVisible = getStatusVisibleByDefault();
  private statusValue = "idle";

  constructor() {
    this.client.onServerRequest((request, responder) => this.handleServerRequest(request, responder));
  }

  setContext(ctx: ExtensionContext): void {
    this.latestContext = ctx;
    if (!this.statusVisible) this.renderStatus();
  }

  resetSession(): void {
    this.threads.reset();
  }

  setStatusVisible(visible: boolean): void {
    this.statusVisible = visible;
    this.renderStatus();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    const shutdownPromise = this.shutdownOnce();
    this.shutdownPromise = shutdownPromise;
    try {
      await shutdownPromise;
    } finally {
      if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = undefined;
    }
  }

  private async shutdownOnce(): Promise<void> {
    logDebug("runtime.shutdown");
    this.clearIdleTimer();
    this.initializePromise = undefined;
    this.threads.reset();
    await this.client.stop();
    this.setStatus("idle");
  }

  async initialize(): Promise<InitializeResponse> {
    const shutdownPromise = this.shutdownPromise;
    if (shutdownPromise) await shutdownPromise;

    if (!this.client.isRunning()) {
      this.initializePromise = undefined;
      this.threads.reset();
    }
    if (this.initializePromise) return this.initializePromise;

    const initializePromise = this.client
      .request<InitializeResponse>("initialize", {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true },
      })
      .then(async (response) => {
        await this.client.notify("initialized");
        return response;
      })
      .catch((error: unknown) => {
        if (this.initializePromise === initializePromise) this.initializePromise = undefined;
        throw error;
      });

    this.initializePromise = initializePromise;
    return initializePromise;
  }

  callTool(
    ctx: ExtensionContext,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ComputerUseToolResult> {
    const contextSignal = signal ?? (ctx as ContextWithSignal).signal;
    if (contextSignal?.aborted) return Promise.reject(createAbortError(`Aborted Computer Use tool call ${tool}`));

    const runtimeContext = contextSignal && !(ctx as ContextWithSignal).signal
      ? ({ ...ctx, signal: contextSignal } as ExtensionContext)
      : ctx;

    this.clearIdleTimer();
    return this.callToolQueue.enqueue(() => this.callToolOnce(runtimeContext, tool, args));
  }

  resolveAppTarget(ctx: ExtensionContext, app: string, signal?: AbortSignal): Promise<ComputerUseToolResult> {
    const contextSignal = signal ?? (ctx as ContextWithSignal).signal;
    if (contextSignal?.aborted) return Promise.reject(createAbortError(`Aborted Computer Use app target resolution for ${app}`));

    const runtimeContext = contextSignal && !(ctx as ContextWithSignal).signal
      ? ({ ...ctx, signal: contextSignal } as ExtensionContext)
      : ctx;

    this.clearIdleTimer();
    return this.callToolQueue.enqueue(() => this.resolveAppTargetOnce(runtimeContext, app));
  }

  private async resolveAppTargetOnce(ctx: ExtensionContext, app: string): Promise<ComputerUseToolResult> {
    const signal = (ctx as ContextWithSignal).signal;
    this.setContext(ctx);

    const abortShutdown = () => {
      void this.shutdown().catch((error: unknown) => {
        logDebug("runtime.shutdown.abort-error", { message: error instanceof Error ? error.message : String(error) });
      });
    };
    signal?.addEventListener("abort", abortShutdown, { once: true });

    if (signal?.aborted) {
      abortShutdown();
      throw createAbortError(`Aborted Computer Use app target resolution for ${app}`);
    }

    this.clearIdleTimer();
    this.setStatus(`resolving: ${app}`);

    try {
      await this.initialize();
      if (signal?.aborted) throw createAbortError(`Aborted Computer Use app target resolution for ${app}`);
      const result = await this.backend.resolveAppTarget(ctx.cwd, app, signal);
      this.setStatus("ready");
      return result;
    } catch (error) {
      if (signal?.aborted) {
        this.setStatus("idle");
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw createAbortError(`Aborted Computer Use app target resolution for ${app}`);
      }

      this.setStatus("error");
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortShutdown);
      if (!signal?.aborted) this.scheduleIdleShutdown();
    }
  }

  private async callToolOnce(
    ctx: ExtensionContext,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ComputerUseToolResult> {
    const signal = (ctx as ContextWithSignal).signal;
    this.setContext(ctx);

    const abortShutdown = () => {
      void this.shutdown().catch((error: unknown) => {
        logDebug("runtime.shutdown.abort-error", { message: error instanceof Error ? error.message : String(error) });
      });
    };
    signal?.addEventListener("abort", abortShutdown, { once: true });

    if (signal?.aborted) {
      abortShutdown();
      throw createAbortError(`Aborted Computer Use tool call ${tool}`);
    }

    this.clearIdleTimer();
    this.setStatus(typeof args.app === "string" ? `working: ${args.app}` : "working");

    try {
      await this.initialize();
      if (signal?.aborted) throw createAbortError(`Aborted Computer Use tool call ${tool}`);
      const result = await this.backend.callTool(ctx.cwd, tool, args, signal);
      this.setStatus("ready");
      return result;
    } catch (error) {
      if (signal?.aborted) {
        this.setStatus("idle");
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw createAbortError(`Aborted Computer Use tool call ${tool}`);
      }

      this.setStatus("error");
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortShutdown);
      if (!signal?.aborted) this.scheduleIdleShutdown();
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
    let approved: boolean;
    try {
      approved = await ctx.ui.confirm(
        "Codex permission",
        message,
        signal ? { signal } : undefined,
      );
    } catch {
      logDebug("elicitation.decline.confirm-error", { serverName: params.serverName });
      responder.accept({ action: "decline", content: null });
      return;
    }

    logDebug(approved ? "elicitation.accept.user" : "elicitation.decline.user", { serverName: params.serverName });
    responder.accept({ action: approved ? "accept" : "decline", content: approved ? {} : null });
  }

  private setStatus(value: string): void {
    this.statusValue = value;
    this.renderStatus();
  }

  private renderStatus(): void {
    const ctx = this.latestContext;
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus(COMPUTER_STATUS_KEY, this.statusVisible ? `${COMPUTER_STATUS_LABEL}: ${this.statusValue}` : undefined);
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
      void this.shutdown().catch((error: unknown) => {
        logDebug("runtime.shutdown.idle-error", { message: error instanceof Error ? error.message : String(error) });
      });
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

function getStatusVisibleByDefault(): boolean {
  const value = process.env.OMP_CODEX_COMPUTER_STATUS?.trim().toLowerCase();
  return value === undefined || STATUS_DISABLED_VALUES[value] !== true;
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

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
