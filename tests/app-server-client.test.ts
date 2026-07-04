import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AppServerClient } from "../src/app-server-client";

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
  (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify(message));
}

describe("AppServerClient", () => {
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

  it("rejects JSON-RPC errors", async () => {
    const client = new AppServerClient();
    attachFakeProcess(client);

    const request = client.request("boom", {}, 1000);
    deliver(client, { id: 1, error: { code: -1, message: "failed" } });

    await expect(request).rejects.toThrow("failed");
  });

  it("times out unanswered requests", async () => {
    const client = new AppServerClient();
    attachFakeProcess(client);

    await expect(client.request("slow", {}, 5)).rejects.toThrow("Timed out");
  });

  it("ignores malformed JSON", () => {
    const client = new AppServerClient();
    attachFakeProcess(client);

    expect(() => (client as unknown as { handleLine(line: string): void }).handleLine("not json")).not.toThrow();
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

  it("rejects a pending request promptly when stopped", async () => {
    const client = new AppServerClient({ requestTimeoutMs: 1000 });
    attachFakeProcess(client);

    const request = client.request("pending");
    const rejection = expect(request).rejects.toThrow("Codex app-server stopped");
    await client.stop();

    await rejection;
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
