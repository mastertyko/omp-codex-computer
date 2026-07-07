import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerRequestResponder } from "../src/app-server-client";
import type { AppServerRequest } from "../src/protocol";
import { ComputerUseRuntime, shouldDevAutoAccept } from "../src/runtime";

const originalDevAutoAcceptApps = process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS;
const originalStatusVisibility = process.env.OMP_CODEX_COMPUTER_STATUS;
const originalIdleTimeoutMs = process.env.OMP_CODEX_COMPUTER_IDLE_TIMEOUT_MS;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function permissionRequest(message: string): AppServerRequest {
  return {
    id: "permission",
    method: "mcpServer/elicitation/request",
    params: { message, serverName: "computer-use" },
  };
}

function createContext(
  cwd: string,
  confirm: () => Promise<boolean>,
  setStatus: (key: string, value: string | undefined) => void = () => undefined,
): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    ui: {
      confirm,
      setStatus,
    },
  } as never as ExtensionContext;
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("shouldDevAutoAccept", () => {
  afterEach(() => {
    if (originalDevAutoAcceptApps === undefined) {
      delete process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS;
    } else {
      process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS = originalDevAutoAcceptApps;
    }
  });

  it("accepts only exact allowlisted app names from permission messages", () => {
    process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS = "Calculator, TextEdit";

    expect(shouldDevAutoAccept("Allow Codex to use Calculator?")).toBe(true);
    expect(shouldDevAutoAccept("Allow Codex to use Safari?")).toBe(false);
    expect(shouldDevAutoAccept("Allow Codex to use Calculator Pro?")).toBe(false);
    expect(shouldDevAutoAccept("Codex requests access to Calculator")).toBe(false);
  });
});

describe("ComputerUseRuntime server requests", () => {
  beforeEach(() => {
    process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS = "";
  });

  afterEach(() => {
    if (originalDevAutoAcceptApps === undefined) {
      delete process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS;
    } else {
      process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS = originalDevAutoAcceptApps;
    }
  });

  it("declines elicitation requests when no UI is available", async () => {
    const runtime = new ComputerUseRuntime();
    const responder = new FakeResponder();

    await runtime.handleServerRequestForTest(permissionRequest("Allow Codex to use Finder?"), responder);

    expect(responder.accepted).toEqual([{ action: "decline", content: null }]);
    expect(responder.rejected).toEqual([]);
  });

  it("accepts elicitation requests when UI confirmation approves", async () => {
    const confirm = vi.fn(async () => true);
    const runtime = new ComputerUseRuntime();
    runtime.setContext(createContext("/tmp/project", confirm));
    const responder = new FakeResponder();

    await runtime.handleServerRequestForTest(permissionRequest("Allow Codex to use TextEdit?"), responder);

    expect(confirm).toHaveBeenCalledWith(
      "Codex permission",
      "Allow Codex to use TextEdit?",
      undefined,
    );
    expect(responder.accepted).toEqual([{ action: "accept", content: {} }]);
    expect(responder.rejected).toEqual([]);
  });

  it("declines elicitation requests when UI confirmation rejects", async () => {
    const runtime = new ComputerUseRuntime();
    runtime.setContext(createContext("/tmp/project", async () => false));
    const responder = new FakeResponder();

    await runtime.handleServerRequestForTest(permissionRequest("Allow Codex to use TextEdit?"), responder);

    expect(responder.accepted).toEqual([{ action: "decline", content: null }]);
    expect(responder.rejected).toEqual([]);
  });

  it("declines elicitation requests when UI confirmation throws", async () => {
    const runtime = new ComputerUseRuntime();
    runtime.setContext(
      createContext("/tmp/project", async () => {
        throw new Error("dialog unavailable");
      }),
    );
    const responder = new FakeResponder();

    await runtime.handleServerRequestForTest(permissionRequest("Allow Codex to use TextEdit?"), responder);

    expect(responder.accepted).toEqual([{ action: "decline", content: null }]);
    expect(responder.rejected).toEqual([]);
  });

  it("rejects unsupported app-server requests", async () => {
    const runtime = new ComputerUseRuntime();
    const responder = new FakeResponder();

    await runtime.handleServerRequestForTest({ id: "unsupported", method: "unknown/request" }, responder);

    expect(responder.accepted).toEqual([]);
    expect(responder.rejected).toHaveLength(1);
    expect(responder.rejected[0]).toMatchObject({ code: -32601 });
  });
});

describe("ComputerUseRuntime lifecycle", () => {
  afterEach(() => {
    if (originalDevAutoAcceptApps === undefined) {
      delete process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS;
    } else {
      process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS = originalDevAutoAcceptApps;
    }

    if (originalStatusVisibility === undefined) {
      delete process.env.OMP_CODEX_COMPUTER_STATUS;
    } else {
      process.env.OMP_CODEX_COMPUTER_STATUS = originalStatusVisibility;
    }

    if (originalIdleTimeoutMs === undefined) {
      delete process.env.OMP_CODEX_COMPUTER_IDLE_TIMEOUT_MS;
    } else {
      process.env.OMP_CODEX_COMPUTER_IDLE_TIMEOUT_MS = originalIdleTimeoutMs;
    }
  });

  it("retries initialize after a rejected request while the client is still running", async () => {
    const runtime = new ComputerUseRuntime();
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = {
      isRunning: () => true,
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (requests.length === 1) throw new Error("initialize failed");
        return { userAgent: "test", codexHome: "/tmp/codex", platformFamily: "test", platformOs: "test" };
      }),
      stop: async () => undefined,
      onServerRequest: () => undefined,
    };
    (runtime as unknown as { client: typeof client }).client = client;

    await expect(runtime.initialize()).rejects.toThrow("initialize failed");
    await expect(runtime.initialize()).resolves.toMatchObject({ userAgent: "test" });

    expect(requests.map((request) => request.method)).toEqual(["initialize", "initialize"]);
  });

  it("keeps the active callTool context while a later call waits", async () => {
    process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS = "";
    const firstResult = deferred<{ content: [] }>();
    const secondResult = deferred<{ content: [] }>();
    const backend = {
      calls: [] as Array<{ cwd: string; tool: string; args: Record<string, unknown> }>,
      callTool(cwd: string, tool: string, args: Record<string, unknown>) {
        this.calls.push({ cwd, tool, args });
        return this.calls.length === 1 ? firstResult.promise : secondResult.promise;
      },
    };
    const client = {
      isRunning: () => true,
      request: vi.fn(async () => ({
        userAgent: "test",
        codexHome: "/tmp/codex",
        platformFamily: "test",
        platformOs: "test",
      })),
      stop: async () => undefined,
      onServerRequest: () => undefined,
    };
    const firstConfirm = vi.fn(async () => true);
    const secondConfirm = vi.fn(async () => true);
    const runtime = new ComputerUseRuntime();
    (runtime as unknown as { client: typeof client; backend: typeof backend }).client = client;
    (runtime as unknown as { client: typeof client; backend: typeof backend }).backend = backend;

    const first = runtime.callTool(createContext("/tmp/first", firstConfirm), "inspect", { app: "First" });
    await flushPromises();
    const second = runtime.callTool(createContext("/tmp/second", secondConfirm), "inspect", { app: "Second" });
    await flushPromises();

    const responder = new FakeResponder();
    await runtime.handleServerRequestForTest(permissionRequest("Allow Codex to use TextEdit?"), responder);

    expect(firstConfirm).toHaveBeenCalledTimes(1);
    expect(secondConfirm).not.toHaveBeenCalled();
    expect(responder.accepted).toEqual([{ action: "accept", content: {} }]);

    firstResult.resolve({ content: [] });
    await expect(first).resolves.toEqual({ content: [] });
    await flushPromises();
    secondResult.resolve({ content: [] });
    await expect(second).resolves.toEqual({ content: [] });
  });

  it("stops the client and returns to idle when the active tool signal aborts mid-call", async () => {
    const controller = new AbortController();
    const setStatus = vi.fn();
    let running = true;
    const abortError = new Error("tool aborted");
    abortError.name = "AbortError";

    const backend = {
      callTool: vi.fn(
        async (_cwd: string, _tool: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
          if (!signal) throw new Error("missing signal");

          return await new Promise<{ content: [] }>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(abortError), { once: true });
          });
        },
      ),
    };
    const client = {
      isRunning: () => running,
      request: vi.fn(async () => ({
        userAgent: "test",
        codexHome: "/tmp/codex",
        platformFamily: "test",
        platformOs: "test",
      })),
      stop: vi.fn(async () => {
        running = false;
      }),
      onServerRequest: () => undefined,
    };
    const runtime = new ComputerUseRuntime();
    const runtimeInternals = runtime as unknown as { client: typeof client; backend: typeof backend };
    runtimeInternals.client = client;
    runtimeInternals.backend = backend;

    const ctx = createContext("/tmp/project", async () => true, setStatus);
    const call = runtime.callTool(ctx, "inspect", { app: "Safari" }, controller.signal);
    await flushPromises();
    expect(backend.callTool).toHaveBeenCalledWith("/tmp/project", "inspect", { app: "Safari" }, controller.signal);

    controller.abort();

    await expect(call).rejects.toMatchObject({ name: "AbortError", message: "tool aborted" });
    await flushPromises();

    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(running).toBe(false);
    expect(setStatus).toHaveBeenCalledWith("codex-computer", "💻 codex: idle");
  });
  it("clears the footer when hidden, suppresses hidden updates, and restores the latest status when shown", async () => {
    const setStatus = vi.fn();
    const runtime = new ComputerUseRuntime();
    const backend = {
      callTool: vi.fn(async () => ({ content: [] })),
    };
    const client = {
      isRunning: () => true,
      request: vi.fn(async () => ({
        userAgent: "test",
        codexHome: "/tmp/codex",
        platformFamily: "test",
        platformOs: "test",
      })),
      stop: async () => undefined,
      onServerRequest: () => undefined,
    };
    const runtimeInternals = runtime as unknown as { client: typeof client; backend: typeof backend };
    runtimeInternals.client = client;
    runtimeInternals.backend = backend;

    runtime.setContext(createContext("/tmp/project", async () => true, setStatus));
    await runtime.callTool(createContext("/tmp/project", async () => true, setStatus), "inspect", { app: "Safari" });

    expect(setStatus).toHaveBeenNthCalledWith(1, "codex-computer", "💻 codex: working: Safari");
    expect(setStatus).toHaveBeenNthCalledWith(2, "codex-computer", "💻 codex: ready");

    runtime.setStatusVisible(false);

    expect(setStatus).toHaveBeenNthCalledWith(3, "codex-computer", undefined);

    const responder = new FakeResponder();
    await runtime.handleServerRequestForTest(permissionRequest("Allow Codex to use TextEdit?"), responder);

    expect(setStatus).toHaveBeenNthCalledWith(4, "codex-computer", undefined);
    expect(responder.accepted).toEqual([{ action: "accept", content: {} }]);

    runtime.setStatusVisible(true);

    expect(setStatus).toHaveBeenNthCalledWith(5, "codex-computer", "💻 codex: permission");
  });

  it("stops the client after the idle timeout elapses following a successful tool call", async () => {
    vi.useFakeTimers();
    process.env.OMP_CODEX_COMPUTER_IDLE_TIMEOUT_MS = "20";

    try {
      const setStatus = vi.fn();
      let running = true;
      const backend = {
        callTool: vi.fn(async () => ({ content: [] })),
      };
      const client = {
        isRunning: () => running,
        request: vi.fn(async () => ({
          userAgent: "test",
          codexHome: "/tmp/codex",
          platformFamily: "test",
          platformOs: "test",
        })),
        stop: vi.fn(async () => {
          running = false;
        }),
        onServerRequest: () => undefined,
      };
      const runtime = new ComputerUseRuntime();
      const runtimeInternals = runtime as unknown as { client: typeof client; backend: typeof backend };
      runtimeInternals.client = client;
      runtimeInternals.backend = backend;

      const ctx = createContext("/tmp/project", async () => true, setStatus);
      await runtime.callTool(ctx, "inspect", { app: "Safari" });

      expect(client.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(19);
      expect(client.stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(client.stop).toHaveBeenCalledTimes(1);
      expect(running).toBe(false);
      expect(setStatus).toHaveBeenCalledWith("codex-computer", "💻 codex: idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults the footer to hidden when OMP_CODEX_COMPUTER_STATUS=off and clears the status key on context set", () => {
    process.env.OMP_CODEX_COMPUTER_STATUS = "off";

    const setStatus = vi.fn();
    const runtime = new ComputerUseRuntime();

    runtime.setContext(createContext("/tmp/project", async () => true, setStatus));

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("codex-computer", undefined);
  });
});
