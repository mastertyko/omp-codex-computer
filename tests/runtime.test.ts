import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerRequestResponder } from "../src/app-server-client";
import type { AppServerRequest } from "../src/protocol";
import { ComputerUseRuntime, shouldDevAutoAccept } from "../src/runtime";

const originalDevAutoAcceptApps = process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS;

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

function createContext(cwd: string, confirm: () => Promise<boolean>): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    ui: {
      confirm,
      setStatus: () => undefined,
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
      "Codex Computer Use permission",
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
});
