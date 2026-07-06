import { describe, expect, it, vi } from "vitest";
import { ComputerUseBackend } from "../src/computer-use-backend";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

class FakeClient {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  responses: Array<unknown | Error> = [];

  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params: params as Record<string, unknown> });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response as T;
  }
}

class FakeThreads {
  ids = ["thread-1"];
  resetCount = 0;

  async getThreadId(): Promise<string> {
    return this.ids[0] ?? "thread-fallback";
  }

  reset(): void {
    this.resetCount++;
    this.ids.shift();
  }
}

describe("ComputerUseBackend", () => {
  it("maps successful tool content", async () => {
    const client = new FakeClient();
    client.responses.push({ content: [{ type: "text", text: "apps" }] });
    const backend = new ComputerUseBackend(client as never, new FakeThreads() as never);

    const result = await backend.callTool("/tmp", "list_apps", {});

    expect(result.content).toEqual([{ type: "text", text: "apps" }]);
    expect(client.calls[0]?.params).toMatchObject({ server: "computer-use", threadId: "thread-1", tool: "list_apps" });
  });

  it("passes exact tool arguments through to the app server", async () => {
    const client = new FakeClient();
    const args = { app: "Safari", nested: { x: 1 }, list: ["a", "b"] };
    client.responses.push({ content: [{ type: "text", text: "ok" }] });
    const backend = new ComputerUseBackend(client as never, new FakeThreads() as never);

    await backend.callTool("/tmp", "inspect", args);

    expect(client.calls[0]?.params.arguments).toBe(args);
  });

  it("maps structured content and meta fields", async () => {
    const client = new FakeClient();
    const structuredContent = { app: "Safari", pid: 123 };
    const meta = { source: "accessibility" };
    client.responses.push({ content: [{ type: "text", text: "ok" }], structuredContent, _meta: meta });
    const backend = new ComputerUseBackend(client as never, new FakeThreads() as never);

    const result = await backend.callTool("/tmp", "inspect", {});

    expect(result.structuredContent).toBe(structuredContent);
    expect(result.meta).toBe(meta);
  });

  it("returns no-content fallback when MCP content is empty", async () => {
    const client = new FakeClient();
    client.responses.push({ content: [] });
    const backend = new ComputerUseBackend(client as never, new FakeThreads() as never);

    const result = await backend.callTool("/tmp", "empty", {});

    expect(result.content).toEqual([{ type: "text", text: "(no content)" }]);
  });

  it("throws when MCP result has isError", async () => {
    const client = new FakeClient();
    client.responses.push({ isError: true, content: [{ type: "text", text: "Invalid app" }] });
    const backend = new ComputerUseBackend(client as never, new FakeThreads() as never);

    await expect(backend.callTool("/tmp", "get_app_state", { app: "Nope" })).rejects.toThrow("Invalid app");
  });

  it("does not retry MCP isError content that mentions stale threads", async () => {
    const client = new FakeClient();
    client.responses.push({ isError: true, content: [{ type: "text", text: "thread not found in app content" }] });
    const threads = new FakeThreads();
    threads.ids = ["thread-1", "thread-2"];
    const backend = new ComputerUseBackend(client as never, threads as never);

    await expect(backend.callTool("/tmp", "get_app_state", { app: "Nope" })).rejects.toThrow(
      "thread not found in app content",
    );
    expect(threads.resetCount).toBe(0);
    expect(client.calls).toHaveLength(1);
  });

  it("retries once after the Computer Use app session was stopped by an MCP error", async () => {
    const client = new FakeClient();
    client.responses.push({
      isError: true,
      content: [
        {
          type: "text",
          text: "This application session has been explicitly stopped by the user for this turn.",
        },
      ],
    });
    client.responses.push({ content: [{ type: "text", text: "ok" }] });
    const threads = new FakeThreads();
    threads.ids = ["thread-1", "thread-2"];
    const resetStoppedSession = vi.fn(async () => {});
    const backend = new ComputerUseBackend(client as never, threads as never, { resetStoppedSession });

    const result = await backend.callTool("/tmp", "list_apps", {});

    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(threads.resetCount).toBe(1);
    expect(resetStoppedSession).toHaveBeenCalledTimes(1);
    expect(client.calls).toHaveLength(2);
  });

  it("retries once with a fresh thread when app-server forgot the thread", async () => {
    const client = new FakeClient();
    client.responses.push(new Error("thread not found: thread-1"));
    client.responses.push({ content: [{ type: "text", text: "ok" }] });
    const threads = new FakeThreads();
    threads.ids = ["thread-1", "thread-2"];
    const backend = new ComputerUseBackend(client as never, threads as never);

    const result = await backend.callTool("/tmp", "list_apps", {});

    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(threads.resetCount).toBe(1);
    expect(client.calls.map((call) => call.params.threadId)).toEqual(["thread-1", "thread-2"]);
  });

  it("bubbles retry failure", async () => {
    const client = new FakeClient();
    client.responses.push(new Error("thread not found: thread-1"));
    client.responses.push(new Error("still broken"));
    const threads = new FakeThreads();
    threads.ids = ["thread-1", "thread-2"];
    const backend = new ComputerUseBackend(client as never, threads as never);

    await expect(backend.callTool("/tmp", "list_apps", {})).rejects.toThrow("still broken");
    expect(threads.resetCount).toBe(1);
  });

  it("bubbles non-thread errors without reset or retry", async () => {
    const client = new FakeClient();
    client.responses.push(new Error("socket closed"));
    const threads = new FakeThreads();
    const backend = new ComputerUseBackend(client as never, threads as never);

    await expect(backend.callTool("/tmp", "list_apps", {})).rejects.toThrow("socket closed");
    expect(threads.resetCount).toBe(0);
    expect(client.calls).toHaveLength(1);
  });

  it("serializes concurrent tool calls", async () => {
    const firstResponse = deferred<{ content: Array<{ type: "text"; text: string }> }>();
    const secondResponse = deferred<{ content: Array<{ type: "text"; text: string }> }>();
    const client = {
      calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
      request<T>(method: string, params: unknown): Promise<T> {
        this.calls.push({ method, params: params as Record<string, unknown> });
        return (this.calls.length === 1 ? firstResponse.promise : secondResponse.promise) as Promise<T>;
      },
    };
    const backend = new ComputerUseBackend(client as never, new FakeThreads() as never);

    const first = backend.callTool("/tmp", "first", {});
    const second = backend.callTool("/tmp", "second", {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.calls.map((call) => call.params.tool)).toEqual(["first"]);

    firstResponse.resolve({ content: [{ type: "text", text: "one" }] });
    await expect(first).resolves.toMatchObject({ content: [{ type: "text", text: "one" }] });
    expect(client.calls.map((call) => call.params.tool)).toEqual(["first", "second"]);

    secondResponse.resolve({ content: [{ type: "text", text: "two" }] });
    await expect(second).resolves.toMatchObject({ content: [{ type: "text", text: "two" }] });
  });
});
