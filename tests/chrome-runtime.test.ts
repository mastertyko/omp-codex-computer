import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type {
  ServerRequestHandler,
  ServerRequestResponder,
} from "../src/app-server-client";
import { ChromeRuntime } from "../src/chrome-runtime";
import {
  ChromeTransportError,
  type ChromeAction,
  type ChromeOperation,
  type ChromeResult,
  type ChromeTurnIdentity,
} from "../src/chrome-transport";
import type { InitializeResponse } from "../src/protocol";

const INITIALIZE_RESPONSE: InitializeResponse = {
  userAgent: "test",
  codexHome: "/test/codex",
  platformFamily: "unix",
  platformOs: "test",
};
const RESULT = {
  kind: "snapshot",
  text: "test snapshot",
  truncated: false,
  byteLength: 13,
} satisfies ChromeResult;
const CLOSE_ACTION = { kind: "close" } satisfies ChromeAction;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ExecuteCall {
  cwd: string;
  identity: ChromeTurnIdentity;
  operation: ChromeOperation;
  signal?: AbortSignal;
}

class FakeClient {
  running = false;
  initialized = false;
  initializeCalls = 0;
  stopCalls = 0;
  serverRequestHandler: ServerRequestHandler | undefined;
  initializeImpl: (() => Promise<void>) | undefined;

  constructor(private readonly events: string[]) {}

  isRunning(): boolean {
    return this.running;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  async requestWithNotification<TResult = unknown>(
    method: string,
    _params: unknown,
    notificationMethod: string,
    _notificationParams?: unknown,
    _timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<TResult> {
    if (signal?.aborted) throw abortError();
    if (this.initialized) throw new Error("Already initialized");
    if (this.initializeImpl) await this.initializeImpl();
    this.initializeCalls += 1;
    this.events.push(`${method}:${notificationMethod}`);
    this.running = true;
    this.initialized = true;
    return INITIALIZE_RESPONSE as TResult;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.events.push("stop");
    this.running = false;
    this.initialized = false;
  }
}

class FakeThreads {
  resetCalls = 0;

  constructor(private readonly events: string[]) {}

  reset(): void {
    this.resetCalls += 1;
    this.events.push("threads.reset");
  }
}

class FakeTransport {
  prepareCalls: Array<{ cwd: string; initialize: InitializeResponse; signal?: AbortSignal }> = [];
  executeCalls: ExecuteCall[] = [];
  resetCalls = 0;
  executeImpl: (call: ExecuteCall) => Promise<ChromeResult> = async () => RESULT;
  prepareImpl: (() => Promise<void>) | undefined;
  dispatchOnExecute = true;

  constructor(private readonly events: string[]) {}

  reset(): void {
    this.resetCalls += 1;
    this.events.push("transport.reset");
  }

  async prepare(cwd: string, initialize: InitializeResponse, signal?: AbortSignal): Promise<void> {
    this.prepareCalls.push({ cwd, initialize, signal });
    this.events.push("prepare");
    if (this.prepareImpl) await this.prepareImpl();
  }

  async execute(
    cwd: string,
    identity: ChromeTurnIdentity,
    operation: ChromeOperation,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<ChromeResult> {
    const call = { cwd, identity, operation, signal };
    this.executeCalls.push(call);
    this.events.push(`execute:${operation.kind}`);
    if (this.dispatchOnExecute) onDispatch?.();
    return this.executeImpl(call);
  }
}

function createHarness() {
  const events: string[] = [];
  const client = new FakeClient(events);
  const threads = new FakeThreads(events);
  const transport = new FakeTransport(events);
  const runtime = new ChromeRuntime({ client, threads, transport });
  return { client, events, runtime, threads, transport };
}

function createContext(cwd = "/work/project", sessionId = "omp-session"): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
    },
  } as never as ExtensionContext;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function abortError(): Error {
  const error = new Error("aborted in test");
  error.name = "AbortError";
  return error;
}

class FakeResponder implements ServerRequestResponder {
  accepted: unknown[] = [];
  rejected: Array<{ code: number; message: string; data?: unknown }> = [];

  accept(result: unknown): void {
    this.accepted.push(result);
  }

  reject(error: { code: number; message: string; data?: unknown }): void {
    this.rejected.push(error);
  }
}

function createResponder(): FakeResponder {
  return new FakeResponder();
}

describe("ChromeRuntime agent lifecycle", () => {
  it("keeps one opaque browser identity from agent_start through agent_end", async () => {
    const { runtime, transport } = createHarness();
    const ctx = createContext();

    await runtime.beginAgent(ctx);
    await runtime.open(ctx);
    await runtime.observe(ctx);
    await runtime.act(ctx, CLOSE_ACTION);
    await runtime.endAgent();

    const firstRunCalls = transport.executeCalls.slice(0, 4);
    expect(firstRunCalls.map(({ operation }) => operation.kind)).toEqual([
      "open",
      "observe",
      "act",
      "cleanup",
    ]);
    const firstIdentity = firstRunCalls[0]?.identity;
    expect(firstIdentity?.sessionId).toMatch(UUID_PATTERN);
    expect(firstIdentity?.turnId).toMatch(UUID_PATTERN);
    expect(firstIdentity?.sessionId).not.toBe(firstIdentity?.turnId);
    expect(firstRunCalls.every(({ identity }) => identity === firstIdentity)).toBe(true);

    await expect(runtime.open(ctx)).rejects.toThrow("active agent run");

    await runtime.beginAgent(ctx);
    await runtime.open(ctx);
    const secondIdentity = transport.executeCalls.at(-1)?.identity;
    expect(secondIdentity?.sessionId).toMatch(UUID_PATTERN);
    expect(secondIdentity?.turnId).toMatch(UUID_PATTERN);
    expect(secondIdentity).not.toEqual(firstIdentity);
    await runtime.endAgent();
  });

  it("owns an independent dedicated app-server lifecycle per runtime", async () => {
    const first = createHarness();
    const second = createHarness();
    const firstContext = createContext("/work/first", "session-first");
    const secondContext = createContext("/work/second", "session-second");

    await first.runtime.beginAgent(firstContext);
    await second.runtime.beginAgent(secondContext);
    await first.runtime.open(firstContext);
    await second.runtime.open(secondContext);

    expect(first.client.initializeCalls).toBe(1);
    expect(second.client.initializeCalls).toBe(1);
    await first.runtime.endAgent();
    expect(first.client.running).toBe(false);
    expect(second.client.running).toBe(true);

    await second.runtime.observe(secondContext);
    expect(second.client.initializeCalls).toBe(1);
    await second.runtime.endAgent();
  });

  it("serializes browser operations in invocation order", async () => {
    const { runtime, transport } = createHarness();
    const ctx = createContext();
    const firstResult = deferred<ChromeResult>();
    const firstStarted = deferred<void>();

    transport.executeImpl = async ({ operation }) => {
      if (operation.kind !== "open") return RESULT;
      firstStarted.resolve();
      return firstResult.promise;
    };

    await runtime.beginAgent(ctx);
    const openPromise = runtime.open(ctx);
    await firstStarted.promise;
    const observePromise = runtime.observe(ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.executeCalls.map(({ operation }) => operation.kind)).toEqual(["open"]);

    firstResult.resolve(RESULT);
    await expect(openPromise).resolves.toBe(RESULT);
    await expect(observePromise).resolves.toBe(RESULT);
    expect(transport.executeCalls.map(({ operation }) => operation.kind)).toEqual(["open", "observe"]);
    await runtime.endAgent();
  });

  it("reuses the active run when agent_start repeats for the same session and cwd", async () => {
    const { runtime, threads, transport } = createHarness();
    const ctx = createContext();

    await runtime.beginAgent(ctx);
    await runtime.open(ctx);
    const identity = transport.executeCalls[0]?.identity;
    const resetsAfterFirstBegin = {
      threads: threads.resetCalls,
      transport: transport.resetCalls,
    };

    // An automatic continuation's agent_start can be delivered before the
    // previous run's agent_end; same session + cwd means the same logical
    // run, so the browser session and identity survive.
    await runtime.beginAgent(ctx);
    await runtime.observe(ctx);
    expect(transport.executeCalls[1]?.identity).toBe(identity);
    expect(threads.resetCalls).toBe(resetsAfterFirstBegin.threads);
    expect(transport.resetCalls).toBe(resetsAfterFirstBegin.transport);
    await runtime.endAgent();
  });

  it("finishes a stale run and begins fresh when agent_start arrives for another session", async () => {
    const { events, runtime, transport } = createHarness();
    const firstContext = createContext("/work/project", "session-one");
    const secondContext = createContext("/work/project", "session-two");

    await runtime.beginAgent(firstContext);
    await runtime.open(firstContext);
    const firstIdentity = transport.executeCalls[0]?.identity;
    events.length = 0;

    await runtime.beginAgent(secondContext);
    expect(events.slice(0, 2)).toEqual(["execute:cleanup", "stop"]);

    await runtime.open(secondContext);
    const secondIdentity = transport.executeCalls.at(-1)?.identity;
    expect(secondIdentity).not.toEqual(firstIdentity);
    await expect(runtime.open(firstContext)).rejects.toThrow("active OMP session");
    await runtime.endAgent();
  });
});

describe("ChromeRuntime request isolation", () => {
  it("declines every elicitation without inspecting or presenting its contents", async () => {
    const { client } = createHarness();
    const handler = client.serverRequestHandler;
    expect(handler).toBeTypeOf("function");

    const ordinaryResponder = createResponder();
    await handler?.(
      {
        id: "ordinary",
        method: "mcpServer/elicitation/request",
        params: { message: "sensitive page-derived request", schema: { secret: true } },
      },
      ordinaryResponder,
    );
    expect(ordinaryResponder.accepted).toEqual([{ action: "decline", content: null }]);
    expect(ordinaryResponder.rejected).toEqual([]);

    const malformedResponder = createResponder();
    await handler?.(
      { id: "malformed", method: "mcpServer/elicitation/request", params: null },
      malformedResponder,
    );
    expect(malformedResponder.accepted).toEqual([{ action: "decline", content: null }]);
    expect(malformedResponder.rejected).toEqual([]);
  });

  it("rejects every non-elicitation server request with a fixed safe error", async () => {
    const { client } = createHarness();
    const responder = createResponder();

    await client.serverRequestHandler?.(
      { id: "unknown", method: "sensitive/unknown/method", params: { secret: "do-not-reflect" } },
      responder,
    );

    expect(responder.accepted).toEqual([]);
    expect(responder.rejected).toEqual([{
      code: -32601,
      message: "Unsupported Codex app-server request",
    }]);
  });
});

describe("ChromeRuntime cleanup and invalidation", () => {
  it("cleanup-closes before stopping the dedicated child", async () => {
    const { events, runtime } = createHarness();
    const ctx = createContext();

    await runtime.beginAgent(ctx);
    await runtime.open(ctx);
    events.length = 0;
    await runtime.endAgent();

    expect(events).toEqual([
      "execute:cleanup",
      "stop",
      "transport.reset",
      "threads.reset",
    ]);
  });

  it("always stops and clears state when cleanup fails", async () => {
    const { client, events, runtime, transport } = createHarness();
    const ctx = createContext();
    const cleanupFailure = new Error("safe cleanup failure");

    transport.executeImpl = async ({ operation }) => {
      if (operation.kind === "cleanup") throw cleanupFailure;
      return RESULT;
    };

    await runtime.beginAgent(ctx);
    await runtime.open(ctx);
    events.length = 0;
    await expect(runtime.endAgent()).rejects.toBe(cleanupFailure);
    expect(events).toEqual([
      "execute:cleanup",
      "stop",
      "transport.reset",
      "threads.reset",
    ]);
    expect(client.running).toBe(false);

    await runtime.beginAgent(ctx);
    await runtime.endAgent();
  });

  it("keeps a poisoned run unavailable across same-context continuation until restart", async () => {
    const { client, runtime, threads, transport } = createHarness();
    const ctx = createContext();
    const failure = new Error("safe transport failure");
    transport.executeImpl = async () => {
      throw failure;
    };

    await runtime.beginAgent(ctx);
    const resetsBeforeFailure = {
      threads: threads.resetCalls,
      transport: transport.resetCalls,
    };
    await expect(runtime.open(ctx)).rejects.toBe(failure);
    expect(client.stopCalls).toBe(1);
    expect(transport.resetCalls).toBe(resetsBeforeFailure.transport + 1);
    expect(threads.resetCalls).toBe(resetsBeforeFailure.threads + 1);
    expect(transport.executeCalls).toHaveLength(1);

    await expect(runtime.observe(ctx)).rejects.toThrow("remainder of this agent run");
    expect(transport.executeCalls).toHaveLength(1);

    transport.executeImpl = async () => RESULT;
    await runtime.beginAgent(ctx);
    await expect(runtime.open(ctx)).rejects.toThrow("remainder of this agent run");
    expect(transport.executeCalls).toHaveLength(1);

    await runtime.restart();
    await runtime.open(ctx);
    expect(transport.executeCalls).toHaveLength(2);
    expect(transport.executeCalls[1]?.identity).not.toEqual(transport.executeCalls[0]?.identity);
    await runtime.endAgent();
  });

  it("keeps the agent alive after benign side-effect-free failures", async () => {
    const { client, runtime, transport } = createHarness();
    const ctx = createContext();
    const benignCodes = [
      "tab_not_open",
      "tab_already_open",
      "invalid_request",
      "element_not_found",
      "ambiguous_locator",
      "locate_failed",
      "navigation_failed",
      "snapshot_failed",
      "snapshot_failed_after_action",
      "close_failed",
      "unavailable",
    ] as const;
    const remaining = [...benignCodes];
    transport.executeImpl = async () => {
      const code = remaining.shift();
      if (code === undefined) return RESULT;
      throw new ChromeTransportError(code);
    };

    await runtime.beginAgent(ctx);
    for (const code of benignCodes) {
      await expect(runtime.observe(ctx)).rejects.toMatchObject({ code });
    }
    expect(client.stopCalls).toBe(0);
    expect(client.running).toBe(true);

    await expect(runtime.observe(ctx)).resolves.toBe(RESULT);
    expect(transport.executeCalls).toHaveLength(benignCodes.length + 1);
    await runtime.endAgent();
  });

  it("still poisons on uncertain transport failures", async () => {
    for (const code of ["operation_failed", "protocol_failed", "request_failed", "interrupted"] as const) {
      const { client, runtime, transport } = createHarness();
      const ctx = createContext();
      transport.executeImpl = async () => {
        throw new ChromeTransportError(code);
      };

      await runtime.beginAgent(ctx);
      await expect(runtime.open(ctx)).rejects.toMatchObject({ code });
      expect(client.stopCalls).toBe(1);
      await expect(runtime.observe(ctx)).rejects.toThrow("remainder of this agent run");
      await runtime.endAgent();
    }
  });

  it("hard-invalidates an in-flight dispatch when its signal aborts", async () => {
    const { client, runtime, transport } = createHarness();
    const ctx = createContext();
    const controller = new AbortController();
    const started = deferred<void>();

    transport.executeImpl = () => new Promise<ChromeResult>(() => {
      started.resolve();
    });

    await runtime.beginAgent(ctx);
    const operation = runtime.open(ctx, undefined, controller.signal);
    await started.promise;
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(client.stopCalls).toBe(1);
    expect(client.running).toBe(false);
    expect(transport.executeCalls).toHaveLength(1);
    await expect(runtime.open(ctx)).rejects.toThrow("remainder of this agent run");
    expect(transport.executeCalls).toHaveLength(1);
    await runtime.endAgent();
  });

  it("does not poison the active agent for an already-aborted queued call", async () => {
    const { client, runtime, transport } = createHarness();
    const ctx = createContext();
    const controller = new AbortController();
    controller.abort();

    await runtime.beginAgent(ctx);
    await expect(runtime.open(ctx, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(client.initializeCalls).toBe(0);
    expect(client.stopCalls).toBe(0);
    expect(transport.executeCalls).toHaveLength(0);

    await runtime.open(ctx);
    expect(transport.executeCalls).toHaveLength(1);
    await runtime.endAgent();
  });

  it("keeps the run usable when initialize fails before dispatch", async () => {
    const { client, runtime, transport } = createHarness();
    const ctx = createContext();
    let fail = true;
    client.initializeImpl = async () => {
      if (fail) throw new Error("spawn codex ENOENT /secret/local/path");
    };

    await runtime.beginAgent(ctx);
    await expect(runtime.open(ctx)).rejects.toMatchObject({
      code: "unavailable",
      message: "Chrome is unavailable",
    });
    expect(client.stopCalls).toBe(0);
    expect(transport.executeCalls).toHaveLength(0);

    fail = false;
    await expect(runtime.open(ctx)).resolves.toBe(RESULT);
    await runtime.endAgent();
  });

  it("restarts the child when aborted after initialize was accepted", async () => {
    const { client, runtime, transport } = createHarness();
    const ctx = createContext();
    const controller = new AbortController();
    const initializeAccepted = Promise.withResolvers<void>();
    client.initializeImpl = () => {
      client.running = true;
      client.initialized = true;
      initializeAccepted.resolve();
      const rejection = Promise.withResolvers<void>();
      controller.signal.addEventListener("abort", () => rejection.reject(abortError()), { once: true });
      return rejection.promise;
    };

    await runtime.beginAgent(ctx);
    const operation = runtime.open(ctx, undefined, controller.signal);
    await initializeAccepted.promise;
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(client.stopCalls).toBe(1);
    expect(client.running).toBe(false);
    expect(transport.executeCalls).toHaveLength(0);

    client.initializeImpl = undefined;
    await expect(runtime.observe(ctx)).resolves.toBe(RESULT);
    await runtime.endAgent();
  });

  it("keeps the run usable when prepare fails before dispatch", async () => {
    const { client, runtime, transport } = createHarness();
    const ctx = createContext();
    let fail = true;
    transport.prepareImpl = async () => {
      if (fail) throw new ChromeTransportError("protocol_failed");
    };

    await runtime.beginAgent(ctx);
    await expect(runtime.open(ctx)).rejects.toMatchObject({ code: "protocol_failed" });
    expect(client.stopCalls).toBe(0);
    expect(transport.executeCalls).toHaveLength(0);

    fail = false;
    await expect(runtime.open(ctx)).resolves.toBe(RESULT);
    await runtime.endAgent();
  });

  it("stays benign when the transport rejects before sending", async () => {
    const { client, runtime, transport } = createHarness();
    const ctx = createContext();
    transport.dispatchOnExecute = false;
    transport.executeImpl = async () => {
      throw new ChromeTransportError("interrupted");
    };

    await runtime.beginAgent(ctx);
    await expect(runtime.open(ctx)).rejects.toMatchObject({ code: "interrupted" });
    expect(client.stopCalls).toBe(0);

    transport.dispatchOnExecute = true;
    transport.executeImpl = async () => RESULT;
    await expect(runtime.open(ctx)).resolves.toBe(RESULT);
    await runtime.endAgent();
  });

  it("uses the same cleanup-before-stop barrier during shutdown", async () => {
    const { events, runtime } = createHarness();
    const ctx = createContext();

    await runtime.beginAgent(ctx);
    await runtime.open(ctx);
    events.length = 0;
    await runtime.shutdown();
    expect(events.slice(0, 2)).toEqual(["execute:cleanup", "stop"]);
    await expect(runtime.observe(ctx)).rejects.toThrow("active agent run");
  });
});

describe("ChromeRuntime context binding", () => {
  it("rejects a different OMP session or cwd before any app-server dispatch", async () => {
    const { client, runtime, transport } = createHarness();
    const ctx = createContext("/work/project", "session-one");

    await runtime.beginAgent(ctx);
    await expect(runtime.open(createContext("/work/project", "session-two"))).rejects.toThrow(
      "active OMP session",
    );
    await expect(runtime.open(createContext("/work/other", "session-one"))).rejects.toThrow(
      "active working directory",
    );
    expect(client.initializeCalls).toBe(0);
    expect(transport.prepareCalls).toHaveLength(0);
    expect(transport.executeCalls).toHaveLength(0);

    await runtime.open(ctx);
    expect(client.initializeCalls).toBe(1);
    expect(transport.executeCalls).toHaveLength(1);
    await runtime.endAgent();
  });

  it("requires a usable session identity at agent_start", async () => {
    const { runtime } = createHarness();
    const missingSession = { cwd: "/work/project" } as never as ExtensionContext;
    const emptySession = createContext("/work/project", "");

    await expect(runtime.beginAgent(missingSession)).rejects.toThrow("active OMP session");
    await expect(runtime.beginAgent(emptySession)).rejects.toThrow("active OMP session");
    await runtime.beginAgent(createContext());
    await runtime.endAgent();
  });
});

describe("ChromeRuntime explicit restart", () => {
  it("re-arms the active run with a fresh identity", async () => {
    const { client, runtime, transport } = createHarness();
    const ctx = createContext();

    await runtime.beginAgent(ctx);
    await runtime.open(ctx);
    const firstIdentity = transport.executeCalls[0]?.identity;

    await runtime.restart();
    expect(client.stopCalls).toBe(1);
    expect(transport.executeCalls.at(-1)?.operation.kind).toBe("cleanup");

    await runtime.observe(ctx);
    const secondIdentity = transport.executeCalls.at(-1)?.identity;
    expect(secondIdentity?.sessionId).toMatch(UUID_PATTERN);
    expect(secondIdentity).not.toEqual(firstIdentity);
    await runtime.endAgent();
  });

  it("clears poison so the same OMP run can use Chrome again", async () => {
    const { runtime, transport } = createHarness();
    const ctx = createContext();
    transport.executeImpl = async () => {
      throw new ChromeTransportError("operation_failed");
    };

    await runtime.beginAgent(ctx);
    await expect(runtime.open(ctx)).rejects.toMatchObject({ code: "operation_failed" });
    await expect(runtime.observe(ctx)).rejects.toThrow("remainder of this agent run");

    transport.executeImpl = async () => RESULT;
    await runtime.restart();
    await expect(runtime.observe(ctx)).resolves.toBe(RESULT);
    await runtime.endAgent();
  });

  it("stays idle when restarted without an agent", async () => {
    const { runtime } = createHarness();
    await runtime.restart();
    await expect(runtime.observe(createContext())).rejects.toThrow("active agent run");
  });
});
