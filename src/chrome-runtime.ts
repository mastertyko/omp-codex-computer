import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  AppServerClient,
  type ServerRequestHandler,
} from "./app-server-client";
import {
  ChromeTransport,
  ChromeTransportError,
  type ChromeAction,
  type ChromeOperation,
  type ChromeResult,
  type ChromeTurnIdentity,
} from "./chrome-transport";
import type { InitializeResponse } from "./protocol";
import { SerialQueue } from "./queue";
import { CodexThreadManager } from "./thread-manager";
import { CLIENT_INFO } from "./client-info";

const REQUEST_TIMEOUT_MS = 120_000;
const ELICITATION_METHOD = "mcpServer/elicitation/request";

interface ChromeRuntimeClient {
  isRunning(): boolean;
  onServerRequest(handler: ServerRequestHandler): void;
  requestWithNotification<TResult = unknown>(
    method: string,
    params: unknown,
    notificationMethod: string,
    notificationParams?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<TResult>;
  stop(): Promise<void>;
}

interface ChromeRuntimeDependencies {
  client: ChromeRuntimeClient;
  threads: Pick<CodexThreadManager, "reset">;
  transport: Pick<ChromeTransport, "prepare" | "execute" | "reset">;
}

interface ActiveAgent {
  readonly cwd: string;
  readonly ompSessionId: string;
  readonly identity: ChromeTurnIdentity;
  prepared: boolean;
  dispatched: boolean;
}

type RuntimeState =
  | { kind: "idle" }
  | { kind: "active"; agent: ActiveAgent }
  | { kind: "ending" }
  | { kind: "poisoned"; agent: ActiveAgent };

export class ChromeRuntime {
  private readonly client: ChromeRuntimeClient;
  private readonly threads: Pick<CodexThreadManager, "reset">;
  private readonly transport: Pick<ChromeTransport, "prepare" | "execute" | "reset">;
  private readonly queue = new SerialQueue();

  private state: RuntimeState = { kind: "idle" };
  private initializePromise: Promise<InitializeResponse> | undefined;

  constructor(dependencies?: ChromeRuntimeDependencies) {
    if (dependencies) {
      this.client = dependencies.client;
      this.threads = dependencies.threads;
      this.transport = dependencies.transport;
    } else {
      const client = new AppServerClient({ requestTimeoutMs: REQUEST_TIMEOUT_MS });
      const threads = new CodexThreadManager(client);
      this.client = client;
      this.threads = threads;
      this.transport = new ChromeTransport(client, threads);
    }

    this.client.onServerRequest((request, responder) => {
      if (request.method === ELICITATION_METHOD) {
        responder.accept({ action: "decline", content: null });
        return;
      }

      responder.reject({
        code: -32601,
        message: "Unsupported Codex app-server request",
      });
    });
  }

  beginAgent(ctx: ExtensionContext): Promise<void> {
    return this.queue.enqueue(async () => {
      const { cwd, sessionId } = readContextIdentity(ctx);

      // OMP delivers lifecycle events for automatic continuations (auto-retry,
      // todo/plan continuations, ...) without ordering guarantees: the next
      // run's agent_start can arrive before -- or without -- the previous
      // run's agent_end. A repeated start for the same OMP session and cwd is
      // the same logical run continuing, so the active browser session (and
      // its opaque identity) is kept. Any other non-idle state is a stale or
      // invalidated run: finish it, then start fresh.
      if (this.state.kind === "active") {
        const { agent } = this.state;
        if (agent.ompSessionId === sessionId && agent.cwd === cwd) return;
        await this.finishStaleAgent();
      } else if (this.state.kind !== "idle") {
        await this.finishStaleAgent();
      }

      this.initializePromise = undefined;
      this.transport.reset();
      this.threads.reset();
      this.state = {
        kind: "active",
        agent: {
          cwd,
          ompSessionId: sessionId,
          identity: {
            sessionId: randomUUID(),
            turnId: randomUUID(),
          },
          prepared: false,
          dispatched: false,
        },
      };
    });
  }

  endAgent(): Promise<void> {
    return this.queue.enqueue(() => this.finishAgent());
  }

  open(ctx: ExtensionContext, url?: string, signal?: AbortSignal): Promise<ChromeResult> {
    return this.run(ctx, url === undefined ? { kind: "open" } : { kind: "open", url }, signal);
  }

  observe(ctx: ExtensionContext, offset?: number, signal?: AbortSignal): Promise<ChromeResult> {
    return this.run(ctx, offset === undefined ? { kind: "observe" } : { kind: "observe", offset }, signal);
  }

  act(ctx: ExtensionContext, action: ChromeAction, signal?: AbortSignal): Promise<ChromeResult> {
    return this.run(ctx, { kind: "act", action }, signal);
  }

  shutdown(): Promise<void> {
    return this.queue.enqueue(() => this.finishAgent());
  }

  /**
   * Explicit user-invoked restart (/codex-computer restart): finish the
   * current run (cleanup + child stop), then re-arm the same OMP run with a
   * fresh browser identity. This intentionally clears poison — a human chose
   * to restart; the model still never gets an automatic retry of an
   * uncertain action.
   */
  restart(): Promise<void> {
    return this.queue.enqueue(async () => {
      const agent = this.state.kind === "active" || this.state.kind === "poisoned"
        ? this.state.agent
        : undefined;
      try {
        await this.finishAgent();
      } catch {
        // Teardown failure must not block the explicit restart; finishAgent
        // has already invalidated all state before rethrowing.
      }
      if (!agent) return;
      this.state = {
        kind: "active",
        agent: {
          cwd: agent.cwd,
          ompSessionId: agent.ompSessionId,
          identity: {
            sessionId: randomUUID(),
            turnId: randomUUID(),
          },
          prepared: false,
          dispatched: false,
        },
      };
    });
  }

  private run(ctx: ExtensionContext, operation: ChromeOperation, signal?: AbortSignal): Promise<ChromeResult> {
    return this.queue.enqueue(async () => {
      const agent = this.requireActiveAgent(ctx);
      if (signal?.aborted) throw createAbortError();

      let dispatched = false;
      try {
        const initialize = await waitForAbort(this.initialize(signal), signal);
        if (signal?.aborted) throw createAbortError();
        if (!this.client.isRunning()) throw new Error("Chrome app-server is unavailable");

        if (!agent.prepared) {
          await waitForAbort(this.transport.prepare(agent.cwd, initialize, signal), signal);
          if (signal?.aborted) throw createAbortError();
          if (!this.client.isRunning()) throw new Error("Chrome app-server is unavailable");
          agent.prepared = true;
        }

        const result = await waitForAbort(
          this.transport.execute(agent.cwd, agent.identity, operation, signal, () => {
            agent.dispatched = true;
            dispatched = true;
          }),
          signal,
        );
        if (signal?.aborted) throw createAbortError();
        if (!this.client.isRunning()) throw new Error("Chrome app-server is unavailable");
        return result;
      } catch (error) {
        // Nothing dispatched for THIS operation is proven side-effect free:
        // aborts during initialize/prepare, bootstrap unavailability, and
        // pre-send rejections leave the run usable. Once dispatched, only
        // benign transport errors are proven side-effect free; anything else
        // (unknown errors, uncertain dispatch outcomes) poisons the run.
        const benign = !dispatched || (error instanceof ChromeTransportError && !error.poisons);
        if (!benign) await this.poison(agent);
        if (signal?.aborted) throw createAbortError();
        throw error;
      }
    }, signal);
  }

  private requireActiveAgent(ctx: ExtensionContext): ActiveAgent {
    if (this.state.kind === "poisoned") {
      throw new Error("Chrome is unavailable for the remainder of this agent run");
    }
    if (this.state.kind !== "active") {
      throw new Error("Chrome requires an active agent run");
    }

    const { cwd, sessionId } = readContextIdentity(ctx);
    if (sessionId !== this.state.agent.ompSessionId) {
      throw new Error("Chrome request does not match the active OMP session");
    }
    if (cwd !== this.state.agent.cwd) {
      throw new Error("Chrome request does not match the active working directory");
    }
    return this.state.agent;
  }

  private async initialize(signal?: AbortSignal): Promise<InitializeResponse> {
    if (this.initializePromise) {
      if (!this.client.isRunning()) throw new Error("Chrome app-server is unavailable");
      return this.initializePromise;
    }

    const initializePromise = this.client.requestWithNotification<InitializeResponse>(
      "initialize",
      {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true },
      },
      "initialized",
      undefined,
      REQUEST_TIMEOUT_MS,
      signal,
    ).catch((error: unknown) => {
      if (this.initializePromise === initializePromise) this.initializePromise = undefined;
      // Raw app-server spawn/handshake errors must not reach the model verbatim.
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ChromeTransportError("unavailable");
    });

    this.initializePromise = initializePromise;
    return initializePromise;
  }

  private async poison(agent: ActiveAgent): Promise<void> {
    if (this.state.kind === "active" && this.state.agent === agent) {
      this.state = { kind: "poisoned", agent };
    }
    this.initializePromise = undefined;

    try {
      await this.client.stop();
    } catch {
      // The original operation error is the useful failure. State is still invalidated below.
    } finally {
      this.transport.reset();
      this.threads.reset();
    }
  }

  private async finishAgent(): Promise<void> {
    const active = this.state.kind === "active" ? this.state.agent : undefined;
    this.state = { kind: "ending" };

    let failure: unknown;
    if (active?.dispatched) {
      try {
        if (!this.client.isRunning()) throw new Error("Chrome app-server is unavailable during cleanup");
        await this.transport.execute(active.cwd, active.identity, { kind: "cleanup" });
      } catch (error) {
        failure = error;
      }
    }

    try {
      await this.client.stop();
    } catch (error) {
      failure ??= error;
    }

    this.initializePromise = undefined;
    try {
      this.transport.reset();
    } catch (error) {
      failure ??= error;
    }
    try {
      this.threads.reset();
    } catch (error) {
      failure ??= error;
    }
    this.state = { kind: "idle" };

    if (failure !== undefined) throw failure;
  }

  /**
   * Finish a stale or invalidated run so a new agent_start can begin fresh.
   * The stale run's cleanup failure is not the new run's failure: finishAgent
   * has already invalidated all state before rethrowing.
   */
  private async finishStaleAgent(): Promise<void> {
    try {
      await this.finishAgent();
    } catch {
      // Swallowed: the new run must start regardless.
    }
  }
}

function readContextIdentity(ctx: ExtensionContext): { cwd: string; sessionId: string } {
  if (typeof ctx.cwd !== "string" || ctx.cwd.length === 0) {
    throw new Error("Chrome requires a valid working directory");
  }

  const sessionManager = (ctx as Partial<ExtensionContext>).sessionManager;
  if (!sessionManager || typeof sessionManager.getSessionId !== "function") {
    throw new Error("Chrome requires an active OMP session");
  }

  let sessionId: unknown;
  try {
    sessionId = sessionManager.getSessionId();
  } catch {
    throw new Error("Chrome requires an active OMP session");
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Chrome requires an active OMP session");
  }

  return { cwd: ctx.cwd, sessionId };
}

function waitForAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function createAbortError(): Error {
  const error = new Error("Chrome operation aborted");
  error.name = "AbortError";
  return error;
}
