import { describe, expect, it } from "vitest";
import { CodexThreadManager } from "../src/thread-manager";

function deferred<T>() {
  return Promise.withResolvers<T>();
}

const PLUGIN_ROOT = "/tmp/computer-use";
const PLUGIN_LIST = {
  marketplaces: [{
    name: "openai-bundled",
    plugins: [{
      id: "computer-use@openai-bundled",
      installed: true,
      enabled: true,
      source: { type: "local", path: PLUGIN_ROOT },
    }],
  }],
};

function threadStartParams(cwd: string) {
  return {
    cwd,
    ephemeral: true,
    config: {
      "mcp_servers.computer-use.enabled": true,
      "mcp_servers.computer-use.cwd": PLUGIN_ROOT,
    },
  };
}

class FakeClient {
  calls: Array<{ method: string; params: unknown }> = [];
  nextId = 1;

  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "plugin/list") return PLUGIN_LIST as T;
    if (method !== "thread/start") throw new Error(`Unexpected method: ${method}`);
    if (!params || typeof params !== "object" || !("cwd" in params) || typeof params.cwd !== "string") {
      throw new Error("thread/start is missing cwd");
    }

    return {
      thread: {
        id: `thread-${this.nextId++}`,
        sessionId: "session",
        status: {},
        cwd: params.cwd,
        ephemeral: true,
      },
      model: "test",
      modelProvider: "test",
    } as T;
  }
}

describe("CodexThreadManager", () => {
  it("discovers and enables the current Computer Use plugin for each thread", async () => {
    const client = new FakeClient();
    const manager = new CodexThreadManager(client as never);

    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-1");
    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-1");

    expect(client.calls).toEqual([
      { method: "plugin/list", params: {} },
      { method: "thread/start", params: threadStartParams("/tmp/project") },
    ]);
  });

  it("rediscovers the plugin and starts a new thread after reset", async () => {
    const client = new FakeClient();
    const manager = new CodexThreadManager(client as never);

    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-1");
    manager.reset();
    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-2");

    expect(client.calls.map((call) => call.method)).toEqual([
      "plugin/list",
      "thread/start",
      "plugin/list",
      "thread/start",
    ]);
  });

  it("returns cached thread metadata for callers that need session context", async () => {
    const client = new FakeClient();
    const manager = new CodexThreadManager(client as never);

    await expect(manager.getThread("/tmp/project")).resolves.toMatchObject({
      id: "thread-1",
      sessionId: "session",
    });
    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-1");

    expect(client.calls).toHaveLength(2);
  });

  it("caches thread ids per cwd and reuses the discovered plugin root", async () => {
    const client = new FakeClient();
    const manager = new CodexThreadManager(client as never);

    await expect(manager.getThreadId("/tmp/project-a")).resolves.toBe("thread-1");
    await expect(manager.getThreadId("/tmp/project-b")).resolves.toBe("thread-2");
    await expect(manager.getThreadId("/tmp/project-a")).resolves.toBe("thread-1");

    expect(client.calls).toEqual([
      { method: "plugin/list", params: {} },
      { method: "thread/start", params: threadStartParams("/tmp/project-a") },
      { method: "thread/start", params: threadStartParams("/tmp/project-b") },
    ]);
  });

  it("shares one plugin discovery and start request during concurrent cold start", async () => {
    const pluginList = deferred<typeof PLUGIN_LIST>();
    const startRequested = deferred<void>();
    const start = deferred<{
      thread: { id: string; sessionId: string; status: Record<string, never>; cwd: string; ephemeral: boolean };
      model: string;
      modelProvider: string;
    }>();
    const client = {
      calls: [] as Array<{ method: string; params: unknown }>,
      request<T>(method: string, params: unknown): Promise<T> {
        this.calls.push({ method, params });
        if (method === "plugin/list") return pluginList.promise as Promise<T>;
        startRequested.resolve();
        return start.promise as Promise<T>;
      },
    };
    const manager = new CodexThreadManager(client as never);

    const first = manager.getThreadId("/tmp/project");
    const second = manager.getThreadId("/tmp/project");

    expect(client.calls).toEqual([{ method: "plugin/list", params: {} }]);
    pluginList.resolve(PLUGIN_LIST);
    await startRequested.promise;
    expect(client.calls).toEqual([
      { method: "plugin/list", params: {} },
      { method: "thread/start", params: threadStartParams("/tmp/project") },
    ]);
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
    const startRequests = [deferred<void>(), deferred<void>()];
    let startIndex = 0;
    const client = {
      calls: [] as Array<{ method: string; params: unknown }>,
      request<T>(method: string, params: unknown): Promise<T> {
        this.calls.push({ method, params });
        if (method === "plugin/list") return Promise.resolve(PLUGIN_LIST as T);
        const index = startIndex++;
        startRequests[index].resolve();
        return starts[index].promise as Promise<T>;
      },
    };
    const manager = new CodexThreadManager(client as never);

    const first = manager.getThreadId("/tmp/project");
    await startRequests[0].promise;
    manager.reset();
    const second = manager.getThreadId("/tmp/project");
    await startRequests[1].promise;

    expect(client.calls).toHaveLength(4);
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
    expect(client.calls).toHaveLength(4);
  });

  it("fails before thread start when the Computer Use plugin is unavailable", async () => {
    const client = {
      calls: [] as Array<{ method: string; params: unknown }>,
      async request<T>(method: string, params: unknown): Promise<T> {
        this.calls.push({ method, params });
        return { marketplaces: [] } as T;
      },
    };
    const manager = new CodexThreadManager(client as never);

    await expect(manager.getThreadId("/tmp/project")).rejects.toThrow(
      "Codex Computer Use plugin is not installed and enabled",
    );
    expect(client.calls).toEqual([{ method: "plugin/list", params: {} }]);
  });
});
