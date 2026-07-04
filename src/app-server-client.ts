import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { logDebug } from "./log";
import type { AppServerNotification, AppServerRequest, AppServerResponse, RequestId } from "./protocol";

export interface AppServerClientOptions {
  codexCommand?: string;
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ServerRequestResponder {
  accept(result: unknown): void;
  reject(error: { code: number; message: string; data?: unknown }): void;
}

export type ServerRequestHandler = (
  request: AppServerRequest,
  responder: ServerRequestResponder,
) => void | Promise<void>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class AppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private stdout: ReadlineInterface | undefined;
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private serverRequestHandler: ServerRequestHandler | undefined;

  constructor(private readonly options: AppServerClientOptions = {}) {}

  start(): void {
    if (this.process) return;

    const codex = this.options.codexCommand ?? "codex";
    logDebug("app-server.spawn", { codex });
    const child = spawn(codex, ["app-server", "--listen", "stdio://"], {
      stdio: "pipe",
      env: { ...process.env, ...this.options.env },
    });

    this.process = child;
    this.stdout = createInterface({ input: child.stdout });
    this.stdout.on("line", (line) => this.handleLine(line));

    child.stderr.on("data", (chunk) => {
      if (process.env.OMP_CODEX_COMPUTER_DEBUG === "1") {
        process.stderr.write(`[codex-app-server] ${String(chunk)}`);
      }
    });

    child.on("error", (error) => {
      logDebug("app-server.error", { message: error.message });
      this.rejectAll(error);
    });
    child.on("exit", (code, signal) => {
      logDebug("app-server.exit", { code, signal });
      this.rejectAll(new Error(`Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
      this.process = undefined;
      this.stdout?.close();
      this.stdout = undefined;
    });
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    this.stdout?.close();
    this.stdout = undefined;

    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        done();
      });
      child.kill("SIGTERM");
    });
  }

  isRunning(): boolean {
    return !!this.process && this.process.exitCode === null;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<TResult> {
    this.start();

    const child = this.process;
    if (!child) throw new Error("Codex app-server process is not running");

    const id = this.nextId++;
    const message: AppServerRequest = params === undefined ? { id, method } : { id, method, params };

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server response to ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });

      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      if (process.env.OMP_CODEX_COMPUTER_DEBUG === "1") {
        process.stderr.write(`[codex-app-server:invalid-json] ${line}\n`);
      }
      return;
    }

    if (!message || typeof message !== "object") return;
    const object = message as Record<string, unknown>;

    if ("id" in object && typeof object.method === "string") {
      void this.handleServerRequest(object as unknown as AppServerRequest);
      return;
    }

    if ("id" in object) {
      this.handleResponse(object as unknown as AppServerResponse);
      return;
    }

    if (typeof object.method === "string") {
      const notification = object as unknown as AppServerNotification;
      logDebug("app-server.notification", { method: notification.method });
    }
  }

  private handleResponse(response: AppServerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }

  private async handleServerRequest(request: AppServerRequest): Promise<void> {
    const handler = this.serverRequestHandler;
    if (!handler) {
      this.sendServerRequestError(request.id, { code: -32601, message: `No handler for server request ${request.method}` });
      return;
    }

    try {
      await handler(request, {
        accept: (result) => this.sendServerRequestResult(request.id, result),
        reject: (error) => this.sendServerRequestError(request.id, error),
      });
    } catch (error) {
      this.sendServerRequestError(request.id, {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sendServerRequestResult(id: RequestId, result: unknown): void {
    this.process?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private sendServerRequestError(id: RequestId, error: { code: number; message: string; data?: unknown }): void {
    this.process?.stdin.write(`${JSON.stringify({ id, error })}\n`);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
