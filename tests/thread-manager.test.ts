import { describe, expect, it } from "vitest";
import { CodexThreadManager } from "../src/thread-manager";

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
});
