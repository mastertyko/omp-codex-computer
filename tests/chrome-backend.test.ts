import { describe, expect, it, vi } from "vitest";
import { buildChromeToolSpec, ChromeBackend } from "../src/chrome-backend";

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
  resetCount = 0;
  threads = [
    { id: "thread-1", sessionId: "session-1" },
    { id: "thread-2", sessionId: "session-2" },
  ];

  async getThread(): Promise<{ id: string; sessionId: string }> {
    return this.threads[0] ?? { id: "fallback", sessionId: "fallback-session" };
  }

  reset(): void {
    this.resetCount++;
    this.threads.shift();
  }
}

describe("ChromeBackend", () => {
  it("calls node_repl js with Codex turn metadata and browser-client setup", async () => {
    const client = new FakeClient();
    client.responses.push({ content: [{ type: "text", text: "[]" }] });
    const backend = new ChromeBackend(client as never, new FakeThreads() as never, {
      browserClientPath: "/plugins/chrome/scripts/browser-client.mjs",
      createTurnId: () => "turn-1",
    });

    const result = await backend.callTool("/tmp/project", "list_browsers", {});

    expect(result.content).toEqual([{ type: "text", text: "[]" }]);
    expect(client.calls[0]).toMatchObject({
      method: "mcpServer/tool/call",
      params: {
        server: "node_repl",
        threadId: "thread-1",
        tool: "js",
        _meta: {
          "x-codex-turn-metadata": {
            session_id: "session-1",
            thread_id: "thread-1",
            turn_id: "turn-1",
          },
        },
      },
    });
    const args = client.calls[0]?.params.arguments as { code: string; title: string };
    expect(args.title).toBe("Chrome list_browsers");
    expect(args.code).toContain("/plugins/chrome/scripts/browser-client.mjs");
    expect(args.code).toContain("agent.browsers.list()");
  });

  it("builds action code that selects a tab and verifies with a summary", async () => {
    const client = new FakeClient();
    client.responses.push({ content: [{ type: "text", text: "{\"ok\":true}" }] });
    const backend = new ChromeBackend(client as never, new FakeThreads() as never, {
      createTurnId: () => "turn-1",
    });

    await backend.callTool("/tmp/project", "dom_click", { tab_id: "tab-1", node_id: 12 });

    const args = client.calls[0]?.params.arguments as { code: string };
    expect(args.code).toContain("browser.tabs.get(input.tab_id)");
    expect(args.code).toContain("tab.dom_cua.click");
    expect(args.code).toContain("node_id");
    expect(args.code).toContain("summarizeTab(tab)");
  });

  it("normalizes Chrome action arguments to the documented browser API shape", () => {
    const domScrollCode = buildChromeToolSpec("dom_scroll", { y: 200 }).code;
    expect(domScrollCode).toContain("x: input.x ?? 0");

    const doubleClickCode = buildChromeToolSpec("double_click", { x: 10, y: 20 }).code;
    expect(doubleClickCode).toContain("await tab.cua.double_click({");
    expect(doubleClickCode).toContain("x: input.x");
    expect(doubleClickCode).toContain("y: input.y");
    expect(doubleClickCode).not.toContain('tab.cua.double_click(pickDefined(["x", "y", "button", "keypress"]))');
  });

  it("throws readable text returned by node_repl errors", async () => {
    const client = new FakeClient();
    client.responses.push({ isError: true, content: [{ type: "text", text: "Chrome unavailable" }] });
    const backend = new ChromeBackend(client as never, new FakeThreads() as never);

    await expect(backend.callTool("/tmp/project", "list_browsers", {})).rejects.toThrow("Chrome unavailable");
  });

  it("retries once when app-server forgot the backing thread", async () => {
    const client = new FakeClient();
    client.responses.push(new Error("thread not found"));
    client.responses.push({ content: [{ type: "text", text: "ok" }] });
    const threads = new FakeThreads();
    const backend = new ChromeBackend(client as never, threads as never, {
      createTurnId: vi.fn(() => "turn"),
    });

    await expect(backend.callTool("/tmp/project", "list_browsers", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });

    expect(threads.resetCount).toBe(1);
    expect(client.calls.map((call) => call.params.threadId)).toEqual(["thread-1", "thread-2"]);
  });
});
