import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AppServerRequestError, type AppServerClient } from "../src/app-server-client";
import { ComputerUseBackend } from "../src/computer-use-backend";
import { COMPUTER_USE_MCP_TOOL_NAMES } from "../src/computer-use-tools";
import type { McpServerStatus, McpServerStatusListResponse, PluginListResponse } from "../src/protocol";

const SKY_PROTOCOL = "omp-codex-computer/sky-v1";
const TEST_ROOT = mkdtempSync(join(tmpdir(), "omp-computer-use-backend-"));
const MARKETPLACE_ROOT = join(TEST_ROOT, "marketplace");
const PLUGIN_ROOT = join(MARKETPLACE_ROOT, "computer-use");
const WRAPPER_PATH = join(PLUGIN_ROOT, "scripts", "computer-use-client.mjs");

mkdirSync(dirname(WRAPPER_PATH), { recursive: true });
writeFileSync(WRAPPER_PATH, "export const fixture = true;\n");
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
}

interface ToolRequest extends RecordedRequest {
  params: Record<string, unknown> & {
    server: string;
    threadId: string;
    tool: string;
    arguments: Record<string, unknown>;
  };
}

function server(name: string, toolNames: readonly string[]): McpServerStatus {
  return {
    name,
    authStatus: "not_required",
    tools: Object.fromEntries(toolNames.map((toolName) => [toolName, { name: toolName, inputSchema: {} }])),
    resources: [],
    resourceTemplates: [],
  };
}

function currentPluginList(): PluginListResponse {
  return {
    marketplaces: [
      {
        name: "openai-bundled",
        path: MARKETPLACE_ROOT,
        plugins: [
          {
            id: "computer-use",
            name: "computer-use",
            installed: true,
            enabled: true,
            installPolicy: "bundled",
            authPolicy: "none",
            source: { path: PLUGIN_ROOT },
          },
        ],
      },
    ],
  };
}

function skySuccess(phase: "bootstrap" | "dispatch", result?: unknown): Record<string, unknown> {
  const envelope: Record<string, unknown> = { protocol: SKY_PROTOCOL, ok: true, phase };
  if (result !== undefined) envelope.result = result;
  return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
}

function skyError(phase: "bootstrap" | "dispatch", error: Record<string, unknown>): Record<string, unknown> {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ protocol: SKY_PROTOCOL, ok: false, phase, error }) }],
  };
}

class FakeClient implements Pick<AppServerClient, "request"> {
  readonly calls: RecordedRequest[] = [];
  readonly toolResponses: unknown[] = [];
  readonly events = new EventEmitter();
  pluginResponse: PluginListResponse = currentPluginList();
  mcpResponse: McpServerStatusListResponse = {
    data: [server("computer-use", COMPUTER_USE_MCP_TOOL_NAMES)],
  };

  async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const call = {
      method,
      params: (params ?? {}) as Record<string, unknown>,
      timeoutMs,
      signal,
    };
    this.calls.push(call);

    if (method === "plugin/list") return this.pluginResponse as unknown as T;
    if (method === "mcpServerStatus/list") return this.mcpResponse as unknown as T;
    if (method !== "mcpServer/tool/call") throw new Error(`Unexpected request: ${method}`);
    this.events.emit("toolRequest");
    if (this.toolResponses.length === 0) throw new Error("No queued MCP tool response");

    const response = this.toolResponses.shift();
    if (response instanceof Error) throw response;
    return (await response) as T;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolRequests(client: FakeClient): ToolRequest[] {
  return client.calls.filter((call): call is ToolRequest =>
    call.method === "mcpServer/tool/call"
    && typeof call.params.server === "string"
    && typeof call.params.threadId === "string"
    && typeof call.params.tool === "string"
    && isRecord(call.params.arguments));
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
    client.toolResponses.push({ content: [{ type: "text", text: "apps" }] });
    const backend = new ComputerUseBackend(client, new FakeThreads());

    const result = await backend.callTool("/tmp", "list_apps", {});

    expect(result.content).toEqual([{ type: "text", text: "apps" }]);
    expect(toolRequests(client)[0]?.params).toMatchObject({
      server: "computer-use",
      threadId: "thread-1",
      tool: "list_apps",
    });
  });

  it("passes exact direct tool arguments through to the app server", async () => {
    const client = new FakeClient();
    const args = {
      app: "Safari",
      element_index: "4",
      click_count: 2,
      mouse_button: "left",
    };
    client.toolResponses.push({ content: [{ type: "text", text: "ok" }] });
    const backend = new ComputerUseBackend(client, new FakeThreads());

    await backend.callTool("/tmp", "click", args);

    expect(toolRequests(client)[0]?.params.arguments).toBe(args);
  });

  it("maps structured content and meta fields", async () => {
    const client = new FakeClient();
    const structuredContent = { app: "Safari", pid: 123 };
    const meta = { source: "accessibility" };
    client.toolResponses.push({ content: [{ type: "text", text: "ok" }], structuredContent, _meta: meta });
    const backend = new ComputerUseBackend(client, new FakeThreads());

    const result = await backend.callTool("/tmp", "get_app_state", { app: "Safari" });

    expect(result.structuredContent).toBe(structuredContent);
    expect(result.meta).toBe(meta);
  });

  it("returns no-content fallback when MCP content is empty", async () => {
    const client = new FakeClient();
    client.toolResponses.push({ content: [] });
    const backend = new ComputerUseBackend(client, new FakeThreads());

    const result = await backend.callTool("/tmp", "press_key", { app: "Safari", key: "ESCAPE" });

    expect(result.content).toEqual([{ type: "text", text: "(no content)" }]);
  });

  it("preserves AppServerRequestError metadata while enriching Invalid app code -10010", async () => {
    const client = new FakeClient();
    const data = { requestId: "request-42", details: { app: "missing" } };
    client.toolResponses.push(new AppServerRequestError("Invalid app", -10010, data));
    client.toolResponses.push({
      content: [
        {
          type: "text",
          text: "Dudo CUA Test — /tmp/DudoCUATest.app/ — dev.dudo.cua-smoke [running]",
        },
      ],
    });
    const threads = new FakeThreads();
    const backend = new ComputerUseBackend(client, threads);

    const thrown = await backend.callTool("/tmp", "get_app_state", { app: "/repo/target/debug/dudo" })
      .catch((error) => error);

    if (!(thrown instanceof AppServerRequestError)) throw new Error("Expected AppServerRequestError");
    expect(thrown.code).toBe(-10010);
    expect(thrown.data).toBe(data);
    const message = thrown.message;
    expect(message).toContain("Invalid app");
    expect(message).toContain("Plugin diagnosis:");
    expect(message).toContain("local development GUI apps launched as raw executables");
    expect(message).toContain("bundle id or .app bundle path");
    expect(toolRequests(client).map((call) => call.params.tool)).toEqual(["get_app_state", "list_apps"]);
    expect(toolRequests(client)[1]?.params).toMatchObject({
      server: "computer-use",
      threadId: "thread-1",
      tool: "list_apps",
    });
    expect(threads.resetCount).toBe(0);
  });

  it("resolves an app from oversized structured content when text is truncated", async () => {
    const client = new FakeClient();
    const apps = Array.from({ length: 512 }, (_, index) => ({
      id: `com.example.app-${index}`,
      displayName: `Example App ${index}`,
    }));
    client.toolResponses.push({
      content: [{ type: "text", text: JSON.stringify(apps.slice(0, 2)) }],
      structuredContent: apps,
    });
    const backend = new ComputerUseBackend(client, new FakeThreads());

    const result = await backend.resolveAppTarget("/tmp", "Example App 511");

    expect(result.structuredContent).toMatchObject({
      status: "resolved",
      registeredAppCount: 512,
      target: {
        displayName: "Example App 511",
        upstreamAddress: "com.example.app-511",
      },
    });
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("com.example.app-511") }),
    ]);
    expect(toolRequests(client).map((call) => call.params.tool)).toEqual(["list_apps"]);
  });

  it("uses oversized structured content while enriching Invalid app diagnostics", async () => {
    const client = new FakeClient();
    const apps = Array.from({ length: 512 }, (_, index) => ({
      id: `com.example.app-${index}`,
      displayName: `Example App ${index}`,
    }));
    client.toolResponses.push(new AppServerRequestError("Invalid app", -10010));
    client.toolResponses.push({
      content: [{ type: "text", text: JSON.stringify(apps.slice(0, 2)) }],
      structuredContent: apps,
    });
    const backend = new ComputerUseBackend(client, new FakeThreads());

    const thrown = await backend.callTool("/tmp", "get_app_state", { app: "Example App 511" })
      .catch((error) => error);

    if (!(thrown instanceof AppServerRequestError)) throw new Error("Expected AppServerRequestError");
    expect(thrown.message).toContain("Resolved app target.");
    expect(thrown.message).toContain("recommendedAddress: com.example.app-511");
    expect(toolRequests(client).map((call) => call.params.tool)).toEqual(["get_app_state", "list_apps"]);
  });

  it("does not perform Invalid app diagnostic lookups for write tools", async () => {
    const client = new FakeClient();
    client.toolResponses.push({ isError: true, content: [{ type: "text", text: "Invalid app" }] });
    const backend = new ComputerUseBackend(client, new FakeThreads());

    await expect(
      backend.callTool("/tmp", "click", { app: "/repo/target/debug/dudo", x: 12, y: 34 }),
    ).rejects.toThrow("Invalid app");
    expect(toolRequests(client).map((call) => call.params.tool)).toEqual(["click"]);
  });

  it("does not retry MCP isError content that mentions stale threads", async () => {
    const client = new FakeClient();
    client.toolResponses.push({
      isError: true,
      content: [{ type: "text", text: "thread not found in app content" }],
    });
    const threads = new FakeThreads();
    threads.ids = ["thread-1", "thread-2"];
    const backend = new ComputerUseBackend(client, threads);

    await expect(backend.callTool("/tmp", "get_app_state", { app: "Nope" })).rejects.toThrow(
      "thread not found in app content",
    );
    expect(threads.resetCount).toBe(0);
    expect(toolRequests(client)).toHaveLength(1);
  });

  it("resets local state and does not replay a stopped read call", async () => {
    const client = new FakeClient();
    const stoppedError = new AppServerRequestError("Computer Use session stopped", -10012, {
      reason: "user_stopped",
    });
    client.toolResponses.push(stoppedError);
    const threads = new FakeThreads();
    threads.ids = ["thread-1", "thread-2"];
    const backend = new ComputerUseBackend(client, threads);

    const thrown = await backend.callTool("/tmp", "list_apps", {}).catch((error) => error);

    expect(thrown).toBe(stoppedError);
    expect(threads.resetCount).toBe(1);
    expect(toolRequests(client).map((call) => call.params.threadId)).toEqual(["thread-1"]);
  });

  it("retries a mutating call only when a stale thread fails before Sky dispatch", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList();
    client.mcpResponse = { data: [server("node_repl", ["js"])] };
    client.toolResponses.push(
      new Error("thread not found: thread-1"),
      skySuccess("bootstrap"),
      skySuccess("dispatch", null),
    );
    const threads = new FakeThreads();
    threads.ids = ["thread-1", "thread-2"];
    const backend = new ComputerUseBackend(client, threads);

    const result = await backend.callTool("/tmp", "click", { app: "Calculator", x: 12, y: 34 });

    expect(result.content).toEqual([{ type: "text", text: "(no content)" }]);
    expect(threads.resetCount).toBe(1);
    const calls = toolRequests(client);
    expect(calls.map((call) => call.params.threadId)).toEqual(["thread-1", "thread-2", "thread-2"]);
    expect(calls.map((call) => call.params.arguments.title)).toEqual([
      "Computer Use bootstrap",
      "Computer Use bootstrap",
      "Computer Use: click",
    ]);
    expect(calls.filter((call) => call.params.arguments.title === "Computer Use: click")).toHaveLength(1);
  });

  it("does not replay a Sky dispatch error whose message mentions a stale thread", async () => {
    const client = new FakeClient();
    client.pluginResponse = currentPluginList();
    client.mcpResponse = { data: [server("node_repl", ["js"])] };
    client.toolResponses.push(
      skySuccess("bootstrap"),
      skyError("dispatch", { name: "DispatchError", message: "thread not found after dispatch" }),
    );
    const threads = new FakeThreads();
    threads.ids = ["thread-1", "thread-2"];
    const backend = new ComputerUseBackend(client, threads);

    await expect(
      backend.callTool("/tmp", "click", { app: "Calculator", x: 12, y: 34 }),
    ).rejects.toThrow("thread not found after dispatch");

    expect(threads.resetCount).toBe(0);
    const calls = toolRequests(client);
    expect(calls.map((call) => call.params.arguments.title)).toEqual([
      "Computer Use bootstrap",
      "Computer Use: click",
    ]);
    expect(calls.filter((call) => call.params.arguments.title === "Computer Use: click")).toHaveLength(1);
  });

  it("resets local state and does not replay a stopped mutating call", async () => {
    const client = new FakeClient();
    client.toolResponses.push({
      isError: true,
      content: [
        {
          type: "text",
          text: "This application session has been explicitly stopped by the user for this turn.",
        },
      ],
    });
    const threads = new FakeThreads();
    const backend = new ComputerUseBackend(client, threads);

    await expect(
      backend.callTool("/tmp", "click", { app: "Calculator", x: 12, y: 34 }),
    ).rejects.toThrow("explicitly stopped");

    expect(threads.resetCount).toBe(1);
    expect(toolRequests(client).map((call) => call.params.tool)).toEqual(["click"]);
  });

  it("bubbles retry failure", async () => {
    const client = new FakeClient();
    client.toolResponses.push(new Error("thread not found: thread-1"), new Error("still broken"));
    const threads = new FakeThreads();
    threads.ids = ["thread-1", "thread-2"];
    const backend = new ComputerUseBackend(client, threads);

    await expect(backend.callTool("/tmp", "list_apps", {})).rejects.toThrow("still broken");
    expect(threads.resetCount).toBe(1);
    expect(toolRequests(client)).toHaveLength(2);
  });

  it("bubbles non-thread errors without reset or retry", async () => {
    const client = new FakeClient();
    client.toolResponses.push(new Error("socket closed"));
    const threads = new FakeThreads();
    const backend = new ComputerUseBackend(client, threads);

    await expect(backend.callTool("/tmp", "list_apps", {})).rejects.toThrow("socket closed");
    expect(threads.resetCount).toBe(0);
    expect(toolRequests(client)).toHaveLength(1);
  });

  it("serializes concurrent tool calls", async () => {
    const responses = new EventEmitter();
    const client = new FakeClient();
    client.toolResponses.push(
      once(responses, "firstResponse").then(([response]) => response),
      once(responses, "secondResponse").then(([response]) => response),
    );
    const backend = new ComputerUseBackend(client, new FakeThreads());
    const firstDispatched = once(client.events, "toolRequest");

    const first = backend.callTool("/tmp", "list_apps", {});
    const second = backend.callTool("/tmp", "get_app_state", { app: "Calculator" });
    await firstDispatched;

    expect(toolRequests(client).map((call) => call.params.tool)).toEqual(["list_apps"]);

    const secondDispatched = once(client.events, "toolRequest");
    responses.emit("firstResponse", { content: [{ type: "text", text: "one" }] });
    await expect(first).resolves.toMatchObject({ content: [{ type: "text", text: "one" }] });
    await secondDispatched;
    expect(toolRequests(client).map((call) => call.params.tool)).toEqual(["list_apps", "get_app_state"]);

    responses.emit("secondResponse", { content: [{ type: "text", text: "two" }] });
    await expect(second).resolves.toMatchObject({ content: [{ type: "text", text: "two" }] });
  });
});
