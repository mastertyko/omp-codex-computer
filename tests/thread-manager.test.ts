import { describe, expect, it } from "vitest";
import { CodexThreadManager } from "../src/thread-manager";

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
  calls: Array<{ method: string; params: unknown }> = [];
  nextId = 1;

  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params });
    return {
      thread: {
        id: `thread-${this.nextId++}`,
        sessionId: "session",
        status: {},
        cwd: (params as { cwd: string }).cwd,
        ephemeral: true,
      },
      model: "test",
      modelProvider: "test",
    } as T;
  }
}

describe("CodexThreadManager", () => {
  it("reuses a thread id until reset", async () => {
    const client = new FakeClient();
    const manager = new CodexThreadManager(client as never);

    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-1");
    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-1");
    manager.reset();
    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-2");

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]).toEqual({ method: "thread/start", params: { cwd: "/tmp/project", ephemeral: true } });
  });

  it("returns cached thread metadata for callers that need session context", async () => {
    const client = new FakeClient();
    const manager = new CodexThreadManager(client as never);

    await expect(manager.getThread("/tmp/project")).resolves.toMatchObject({
      id: "thread-1",
      sessionId: "session",
    });
    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-1");

    expect(client.calls).toHaveLength(1);
  });

  it("caches thread ids per cwd and reuses them when switching back", async () => {
    const client = new FakeClient();
    const manager = new CodexThreadManager(client as never);

    await expect(manager.getThreadId("/tmp/project-a")).resolves.toBe("thread-1");
    await expect(manager.getThreadId("/tmp/project-b")).resolves.toBe("thread-2");
    await expect(manager.getThreadId("/tmp/project-a")).resolves.toBe("thread-1");

    expect(client.calls).toEqual([
      { method: "thread/start", params: { cwd: "/tmp/project-a", ephemeral: true } },
      { method: "thread/start", params: { cwd: "/tmp/project-b", ephemeral: true } },
    ]);
  });

  it("shares one in-flight start request during concurrent cold start", async () => {
    const start = deferred<{
      thread: { id: string; sessionId: string; status: Record<string, never>; cwd: string; ephemeral: boolean };
      model: string;
      modelProvider: string;
    }>();
    const client = {
      calls: [] as Array<{ method: string; params: unknown }>,
      request<T>(method: string, params: unknown): Promise<T> {
        this.calls.push({ method, params });
        return start.promise as Promise<T>;
      },
    };
    const manager = new CodexThreadManager(client as never);

    const first = manager.getThreadId("/tmp/project");
    const second = manager.getThreadId("/tmp/project");

    expect(client.calls).toHaveLength(1);
    start.resolve({
      thread: {
        id: "thread-shared",
        sessionId: "session",
        status: {},
        cwd: "/tmp/project",
        ephemeral: true,
      },
      model: "test",
      modelProvider: "test",
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["thread-shared", "thread-shared"]);
  });

  it("starts a new thread after reset clears cached and in-flight state", async () => {
    const client = new FakeClient();
    const manager = new CodexThreadManager(client as never);

    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-1");
    manager.reset();
    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-2");

    expect(client.calls).toHaveLength(2);
  });

  it("does not cache an in-flight thread result that resolves after reset", async () => {
    const firstStart = deferred<{
      thread: { id: string; sessionId: string; status: Record<string, never>; cwd: string; ephemeral: boolean };
      model: string;
      modelProvider: string;
    }>();
    const secondStart = deferred<{
      thread: { id: string; sessionId: string; status: Record<string, never>; cwd: string; ephemeral: boolean };
      model: string;
      modelProvider: string;
    }>();
    const starts = [firstStart, secondStart];
    const client = {
      calls: [] as Array<{ method: string; params: unknown }>,
      request<T>(method: string, params: unknown): Promise<T> {
        this.calls.push({ method, params });
        return starts[this.calls.length - 1].promise as Promise<T>;
      },
    };
    const manager = new CodexThreadManager(client as never);

    const first = manager.getThreadId("/tmp/project");
    manager.reset();
    const second = manager.getThreadId("/tmp/project");

    expect(client.calls).toHaveLength(2);
    secondStart.resolve({
      thread: { id: "thread-new", sessionId: "session", status: {}, cwd: "/tmp/project", ephemeral: true },
      model: "test",
      modelProvider: "test",
    });
    await expect(second).resolves.toBe("thread-new");

    firstStart.resolve({
      thread: { id: "thread-old", sessionId: "session", status: {}, cwd: "/tmp/project", ephemeral: true },
      model: "test",
      modelProvider: "test",
    });
    await expect(first).resolves.toBe("thread-old");

    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-new");
    expect(client.calls).toHaveLength(2);
  });
});
