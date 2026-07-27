import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerClient, AppServerRequestError, type ServerRequestResponder } from "../src/app-server-client";

const spawnMockState = vi.hoisted(() => ({
  child: undefined as unknown,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    if (!spawnMockState.child) throw new Error("No fake process attached");
    return spawnMockState.child;
  }),
}));

interface FakeProcessOptions {
  writeError?: Error;
}

function createFakeProcess(options: FakeProcessOptions = {}) {
  const writes: string[] = [];
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: { write(chunk: string, cb?: (error?: Error | null) => void): boolean };
    kill(signal?: NodeJS.Signals): boolean;
  };

  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = {
    write(chunk: string, cb?: (error?: Error | null) => void) {
      writes.push(chunk);
      cb?.(options.writeError ?? null);
      return true;
    },
  };
  child.kill = () => {
    setTimeout(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    }, 0);
    return true;
  };

  return { child, writes };
}

function attachFakeProcess(client: AppServerClient, options: FakeProcessOptions = {}) {
  const fake = createFakeProcess(options);
  (client as unknown as { process: unknown }).process = fake.child;
  return fake;
}

function startWithFakeProcess(client: AppServerClient, options: FakeProcessOptions = {}) {
  const fake = createFakeProcess(options);
  spawnMockState.child = fake.child;
  client.start();
  return fake;
}

function pendingCount(client: AppServerClient) {
  return (client as unknown as { pending: Map<unknown, unknown> }).pending.size;
}

function deliver(client: AppServerClient, message: unknown) {
  const child = (client as unknown as { process: unknown }).process;
  (client as unknown as { handleLine(child: unknown, line: string): void }).handleLine(child, JSON.stringify(message));
}

async function deliverFromChild(child: { stdout: PassThrough }, message: unknown) {
  child.stdout.write(`${JSON.stringify(message)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AppServerClient", () => {
  afterEach(() => {
    spawnMockState.child = undefined;
    vi.restoreAllMocks();
    delete process.env.OMP_CODEX_COMPUTER_DEBUG;
  });

  it("routes concurrent responses by id", async () => {
    const client = new AppServerClient();
    attachFakeProcess(client);

    const first = client.request("first", {}, 1000);
    const second = client.request("second", {}, 1000);

    deliver(client, { id: 2, result: "two" });
    deliver(client, { id: 1, result: "one" });

    await expect(first).resolves.toBe("one");
    await expect(second).resolves.toBe("two");
  });

  it("preserves JSON-RPC error metadata", async () => {
    const client = new AppServerClient();
    attachFakeProcess(client);
    const data = { reason: "permission denied", retryable: false };

    const request = client.request("boom", {}, 1000);
    deliver(client, { id: 1, error: { code: -32_001, message: "failed", data } });

    const error = await request.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppServerRequestError);
    expect(error).toMatchObject({ message: "failed", code: -32_001, data });
    if (!(error instanceof AppServerRequestError)) throw new Error("Expected an AppServerRequestError");

    const rewritten = error.withMessage("initialize failed");
    expect(rewritten).not.toBe(error);
    expect(rewritten).toMatchObject({ message: "initialize failed", code: -32_001, data });
    expect(rewritten.data).toBe(error.data);
  });

  it("times out unanswered requests", async () => {
    const client = new AppServerClient();
    attachFakeProcess(client);

    await expect(client.request("slow", {}, 5)).rejects.toThrow("Timed out");
  });

  it("keeps timeoutMs=0 requests pending until a response arrives", async () => {
    vi.useFakeTimers();
    try {
      const client = new AppServerClient();
      attachFakeProcess(client);

      const request = client.request("no-deadline", {}, 0);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(pendingCount(client)).toBe(1);
      deliver(client, { id: 1, result: "completed" });
      await expect(request).resolves.toBe("completed");
      expect(pendingCount(client)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a response-coupled notification to the same running child", async () => {
    const client = new AppServerClient();
    const { writes } = startWithFakeProcess(client);
    const params = { clientInfo: { name: "test", version: "1" } };

    const handshake = client.requestWithNotification<{ ready: true }>(
      "initialize",
      params,
      "initialized",
      undefined,
      1000,
    );

    expect(writes).toEqual([`${JSON.stringify({ id: 1, method: "initialize", params })}\n`]);
    deliver(client, { id: 1, result: { ready: true } });

    await expect(handshake).resolves.toEqual({ ready: true });
    expect(writes).toEqual([
      `${JSON.stringify({ id: 1, method: "initialize", params })}\n`,
      `${JSON.stringify({ method: "initialized" })}\n`,
    ]);
  });

  it("rejects without notifying a replacement child after the response", async () => {
    const client = new AppServerClient();
    const first = startWithFakeProcess(client);
    const handshake = client.requestWithNotification(
      "initialize",
      { clientInfo: { name: "test", version: "1" } },
      "initialized",
      undefined,
      1000,
    );

    deliver(client, { id: 1, result: { ready: true } });
    first.child.exitCode = 1;
    first.child.emit("exit", 1, null);

    const second = createFakeProcess();
    spawnMockState.child = second.child;
    client.start();

    await expect(handshake).rejects.toThrow("process changed during notification initialized");
    expect(first.writes).toHaveLength(1);
    expect(second.writes).toEqual([]);
  });

  it("does not spawn a child when notifying a stopped client", async () => {
    const client = new AppServerClient();
    const spawnCallCount = vi.mocked(spawn).mock.calls.length;

    await expect(client.notify("initialized")).rejects.toThrow("process is not running");

    expect(vi.mocked(spawn).mock.calls).toHaveLength(spawnCallCount);
    expect(client.isRunning()).toBe(false);
  });

  it("writes notifications without a JSON-RPC id", async () => {
    const client = new AppServerClient();
    const { writes } = attachFakeProcess(client);

    await client.notify("initialized");

    expect(writes).toEqual([`${JSON.stringify({ method: "initialized" })}\n`]);
    expect(JSON.parse(writes[0] ?? "{}")).not.toHaveProperty("id");
  });

  it("rejects notifications when their stdin write fails", async () => {
    const client = new AppServerClient();
    const { writes } = attachFakeProcess(client, { writeError: new Error("write failed") });

    await expect(client.notify("initialized")).rejects.toThrow("write failed");
    expect(writes).toEqual([`${JSON.stringify({ method: "initialized" })}\n`]);
  });

  it("rejects an in-flight notification when aborted and ignores its late write callback", async () => {
    const client = new AppServerClient();
    const { child, writes } = attachFakeProcess(client);
    let completeWrite: ((error?: Error | null) => void) | undefined;
    child.stdin.write = (chunk, callback) => {
      writes.push(chunk);
      completeWrite = callback;
      return true;
    };
    const controller = new AbortController();

    const notification = client.notify("initialized", undefined, controller.signal);
    const settled = vi.fn();
    notification.then(settled, settled);
    controller.abort();

    await expect(notification).rejects.toMatchObject({ name: "AbortError" });
    expect(settled).toHaveBeenCalledTimes(1);
    completeWrite?.(null);
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed JSON", () => {
    const client = new AppServerClient();
    const { child, writes } = startWithFakeProcess(client);

    expect(() =>
      (client as unknown as { handleLine(child: unknown, line: string): void }).handleLine(child, "not json"),
    ).not.toThrow();
    expect(pendingCount(client)).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("handles app-server requests through registered handler", async () => {
    const client = new AppServerClient();
    const { writes } = attachFakeProcess(client);
    client.onServerRequest((request, responder) => {
      expect(request.method).toBe("mcpServer/elicitation/request");
      responder.accept({ action: "accept", content: {} });
    });

    deliver(client, { id: "abc", method: "mcpServer/elicitation/request", params: { message: "Allow?" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writes.at(-1)).toBe(`${JSON.stringify({ id: "abc", result: { action: "accept", content: {} } })}\n`);
  });

  it("rejects app-server requests when no handler is registered", async () => {
    const client = new AppServerClient();
    const { writes } = attachFakeProcess(client);

    deliver(client, { id: "abc", method: "unknown/request", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = JSON.parse(writes.at(-1) ?? "{}");
    expect(response.id).toBe("abc");
    expect(response.error.message).toContain("No handler");
  });

  it("does not write a stale server-request response to a restarted child", async () => {
    const client = new AppServerClient();
    const first = startWithFakeProcess(client);
    let responder: ServerRequestResponder | undefined;

    client.onServerRequest((_request, capturedResponder) => {
      responder = capturedResponder;
    });

    await deliverFromChild(first.child, { id: "old-request", method: "mcpServer/elicitation/request", params: {} });
    expect(responder).toBeDefined();

    first.child.exitCode = 1;
    first.child.emit("exit", 1, null);

    const second = createFakeProcess();
    spawnMockState.child = second.child;
    client.start();

    responder?.accept({ action: "accept", content: { stale: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(second.writes.join("")).not.toContain("old-request");
    expect(second.writes.join("")).not.toContain("stale");
  });

  it("rejects a pending request promptly when stopped", async () => {
    const client = new AppServerClient({ requestTimeoutMs: 1000 });
    attachFakeProcess(client);

    const request = client.request("pending");
    const rejection = expect(request).rejects.toThrow("Codex app-server stopped");
    await client.stop();

    await rejection;
  });
  it("rejects aborted requests and ignores late responses", async () => {
    const client = new AppServerClient({ requestTimeoutMs: 1000 });
    attachFakeProcess(client);

    const controller = new AbortController();
    const request = client.request("abort-me", {}, 1000, controller.signal);
    const settled = vi.fn();
    request.then(settled, settled);

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(pendingCount(client)).toBe(0);

    expect(() => deliver(client, { id: 1, result: "late" })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(pendingCount(client)).toBe(0);
  });

  it("does not write new requests to a child after stop has begun", async () => {
    const client = new AppServerClient();
    const stopping = startWithFakeProcess(client);
    const stopPromise = client.stop();
    const fresh = createFakeProcess();
    spawnMockState.child = fresh.child;

    const request = client.request("after-stop", {}, 1000);

    expect(stopping.writes).toHaveLength(0);
    expect(fresh.writes).toHaveLength(1);

    await deliverFromChild(fresh.child, { id: 1, result: "fresh" });
    await expect(request).resolves.toBe("fresh");
    await stopPromise;
  });

  it("summarizes debug stderr without forwarding raw stderr", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.OMP_CODEX_COMPUTER_DEBUG = "1";
    const client = new AppServerClient();
    const { child } = startWithFakeProcess(client);
    const rawChunk = "secret app-server stderr\n";

    child.stderr.write(rawChunk);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining(rawChunk));
  });

  it("clears running process state after child error", () => {
    const client = new AppServerClient();
    const { child } = startWithFakeProcess(client);

    child.emit("error", new Error("spawn failed"));

    expect(client.isRunning()).toBe(false);
  });

  it("clears running process state after child exit", () => {
    const client = new AppServerClient();
    const { child } = startWithFakeProcess(client);

    child.exitCode = 1;
    child.emit("exit", 1, null);

    expect(client.isRunning()).toBe(false);
  });

  it("rejects stdin write callback errors and ignores later responses for that id", async () => {
    const client = new AppServerClient();
    attachFakeProcess(client, { writeError: new Error("write failed") });

    await expect(client.request("write-fails")).rejects.toThrow("write failed");
    expect(pendingCount(client)).toBe(0);

    expect(() => deliver(client, { id: 1, result: "late" })).not.toThrow();
    expect(pendingCount(client)).toBe(0);
  });
});
