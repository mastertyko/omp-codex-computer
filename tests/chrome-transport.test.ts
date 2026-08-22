import { describe, expect, it, vi } from "vitest";
import type { AppServerClient } from "../src/app-server-client";
import {
  CHROME_PRESS_KEYS,
  ChromeTransport,
} from "../src/chrome-transport";
import type { InitializeResponse } from "../src/protocol";
import type { CodexThreadInfo, CodexThreadManager } from "../src/thread-manager";

const { evaluateChromeCapabilities } = vi.hoisted(() => ({ evaluateChromeCapabilities: vi.fn() }));
vi.mock("../src/chrome-capabilities", () => ({ evaluateChromeCapabilities }));

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
}

class FakeClient implements Pick<AppServerClient, "request"> {
  readonly calls: RecordedCall[] = [];
  readonly responses: unknown[] = [];

  async request<TResult = unknown>(method: string, params?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<TResult> {
    this.calls.push({ method, params: (params ?? {}) as Record<string, unknown>, timeoutMs, signal });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response as TResult;
  }
}

class FakeThreads implements Pick<CodexThreadManager, "getThread"> {
  readonly calls: string[] = [];
  constructor(private readonly thread: CodexThreadInfo = { id: "thread-1", sessionId: "server-session-1" }) {}

  async getThread(cwd: string): Promise<CodexThreadInfo> {
    this.calls.push(cwd);
    return this.thread;
  }
}

const initialize: InitializeResponse = {
  userAgent: "codex-cli/0.149.0",
  codexHome: "/private/not-returned",
  platformFamily: "unix",
  platformOs: "macos",
};
const identity = { sessionId: "omp-session", turnId: "omp-turn" };

function readyCapabilities() {
  return {
    status: "ready",
    pluginVersion: "26.818.31338",
    appServerVersion: "0.149.0",
    clientPath: "/trusted/chrome/scripts/browser-client.mjs",
    nodeReplServerName: "node_repl",
  };
}

function success(result: unknown): { content: unknown[] } {
  return { content: [{ type: "text", text: JSON.stringify({ protocol: "omp-codex-computer/chrome-v1", ok: true, result }) }] };
}

function failure(error: string): { content: unknown[] } {
  return { content: [{ type: "text", text: JSON.stringify({ protocol: "omp-codex-computer/chrome-v1", ok: false, error }) }] };
}

function createTransport() {
  evaluateChromeCapabilities.mockResolvedValue(readyCapabilities());
  const client = new FakeClient();
  const threads = new FakeThreads();
  return { client, threads, transport: new ChromeTransport(client, threads) };
}

function getToolCall(client: FakeClient): RecordedCall {
  const call = client.calls.find(({ method }) => method === "mcpServer/tool/call");
  if (!call) throw new Error("Expected node_repl call");
  return call;
}

function getProgram(call: RecordedCall): string {
  const args = call.params.arguments;
  if (!args || typeof args !== "object" || typeof (args as Record<string, unknown>).code !== "string") {
    throw new Error("Expected generated program");
  }
  return (args as Record<string, string>).code;
}

function decodePayload(program: string): unknown {
  const match = /Buffer\.from\(("[A-Za-z0-9+/=]+"), "base64"\)/u.exec(program);
  if (!match?.[1]) throw new Error("Expected encoded payload");
  return JSON.parse(Buffer.from(JSON.parse(match[1]), "base64").toString("utf8"));
}

describe("ChromeTransport", () => {
  it("discovers once and sends strict fixed-program requests with canonical metadata", async () => {
    const { client, threads, transport } = createTransport();
    await transport.prepare("/work", initialize);
    client.responses.push(success({ kind: "opened" }));

    await expect(transport.execute("/work", identity, { kind: "open" })).resolves.toEqual({ kind: "opened" });
    expect(client.calls.map(({ method }) => method)).toEqual([
      "plugin/list", "mcpServerStatus/list", "mcpServer/tool/call",
    ]);
    expect(threads.calls).toEqual(["/work"]);
    const call = getToolCall(client);
    expect(call.params).toMatchObject({
      server: "node_repl",
      threadId: "thread-1",
      tool: "js",
      arguments: { title: "Chrome operation", timeout_ms: 120_000 },
      _meta: { "x-codex-turn-metadata": {
        session_id: "omp-session", thread_id: "thread-1", turn_id: "omp-turn", request_kind: "turn",
      } },
    });
    const program = getProgram(call);
    expect(program).toContain("omp-codex-computer/chrome-v1");
    expect(program).toContain("setupBrowserRuntime");
    expect(program).toContain('browsers.get("chrome")');
    expect(program).toContain('browser.nameSession("OMP Chrome")');
    expect(program).toContain("tabs.new()");
    expect(program).toContain("playwright.domSnapshot()");
    expect(program).not.toContain("browser.user");
    expect(program).not.toContain("tabs.list");
    expect(program).not.toContain("tabs.get");
    expect(program).not.toContain("evaluate(");
    expect(program).not.toContain("computer_use");
    expect(program).not.toContain("cdp");
    expect(program).not.toContain("retry");
    expect(decodePayload(program)).toEqual({ identity, operation: { kind: "open" } });
  });

  it("uses one implicit tab and performs cleanup without exposing a tab handle", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);
    client.responses.push(
      success({ kind: "opened" }),
      success({ kind: "snapshot", text: "opened", truncated: false, byteLength: 6 }),
      success({ kind: "snapshot", text: "clicked", truncated: false, byteLength: 7 }),
      success({ kind: "closed" }),
      success({ kind: "closed" }),
    );

    await transport.execute("/work", identity, { kind: "open" });
    await transport.execute("/work", identity, { kind: "observe" });
    await transport.execute("/work", identity, {
      kind: "act", action: { kind: "click", target: { kind: "role", role: "button", name: "Continue" } },
    });
    await transport.execute("/work", identity, { kind: "act", action: { kind: "close" } });
    await transport.execute("/work", identity, { kind: "cleanup" });

    const programs = client.calls.filter(({ method }) => method === "mcpServer/tool/call").map(getProgram);
    const payloads = programs.map(decodePayload) as Array<{ operation: { kind: string } }>;
    expect(payloads).toHaveLength(5);
    expect(payloads.filter(({ operation }) => operation.kind === "open")).toHaveLength(1);
    expect(payloads.filter(({ operation }) => operation.kind === "cleanup")).toHaveLength(1);
    expect(programs.every((program) => !program.includes("tabId") && !program.includes("browserId"))).toBe(true);
  });

  it("rejects unsafe URLs, selectors, extra fields, and unsafe keys before dispatch", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);
    const actions: unknown[] = [
      { kind: "navigate", url: "javascript:alert(1)" },
      { kind: "navigate", url: "https://user:password@example.com/" },
      { kind: "navigate", url: "file:///etc/passwd" },
      { kind: "click", target: { kind: "css", selector: "button" } },
      { kind: "click", target: { kind: "text", text: "button", regex: true } },
      { kind: "press", target: { kind: "text", text: "button" }, key: "Control+R" },
      { kind: "fill", target: { kind: "text", text: "field" }, value: "x", extra: true },
    ];
    for (const action of actions) {
      await expect(transport.execute("/work", identity, { kind: "act", action } as never))
        .rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(client.calls.filter(({ method }) => method === "mcpServer/tool/call")).toHaveLength(0);
    expect(CHROME_PRESS_KEYS).not.toContain("Control+R");
  });

  it("caps snapshots independently by UTF-8 bytes and line count and returns only safe metadata", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);
    const oversizedBytes = "界".repeat(60_000);
    const oversizedLines = Array.from({ length: 4_000 }, (_, index) => `line-${index}`).join("\n");
    client.responses.push(
      success({ kind: "snapshot", text: oversizedBytes, truncated: false, byteLength: Buffer.byteLength(oversizedBytes) }),
      success({ kind: "snapshot", text: oversizedLines, truncated: false, byteLength: Buffer.byteLength(oversizedLines) }),
    );

    for (const expectedLineCount of [2, 3_000]) {
      const result = await transport.execute("/work", identity, { kind: "observe" });
      expect(result.kind).toBe("snapshot");
      if (result.kind !== "snapshot") throw new Error("Expected snapshot");
      expect(result.truncated).toBe(true);
      expect(result.byteLength).toBe(Buffer.byteLength(result.text, "utf8"));
      expect(result.byteLength).toBeLessThanOrEqual(50 * 1024);
      expect(result.text.split("\n")).toHaveLength(expectedLineCount);
      expect(result.text).toContain("[Output truncated]");
      expect(result).not.toHaveProperty("url");
      expect(result).not.toHaveProperty("title");
      expect(result).not.toHaveProperty("tabId");
    }
  });

  it("requires exactly one envelope and discards raw metadata and errors", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);
    const malformedResponses: unknown[] = [
      { content: [] },
      { content: [{ type: "text", text: "not json" }] },
      { content: [
        { type: "text", text: JSON.stringify({ protocol: "omp-codex-computer/chrome-v1", ok: true, result: { kind: "opened" } }) },
        { type: "text", text: JSON.stringify({ protocol: "omp-codex-computer/chrome-v1", ok: true, result: { kind: "opened" } }) },
      ] },
    ];
    for (const response of malformedResponses) {
      client.responses.push(response);
      await expect(transport.execute("/work", identity, { kind: "open" })).rejects.toMatchObject({ code: "protocol_failed" });
    }

    client.responses.push({
      content: [{ type: "text", text: JSON.stringify({ protocol: "omp-codex-computer/chrome-v1", ok: true, result: { kind: "opened" } }) }],
      _meta: { secret: "not surfaced" },
    });
    await expect(transport.execute("/work", identity, { kind: "open" })).resolves.toEqual({ kind: "opened" });

    client.responses.push(failure("operation_failed"));
    await expect(transport.execute("/work", identity, { kind: "open" })).rejects.toMatchObject({
      code: "operation_failed", message: "Chrome operation failed",
    });
  });

  it("propagates aborts and request errors without retry or fallback", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);
    const controller = new AbortController();
    controller.abort();
    await expect(transport.execute("/work", identity, { kind: "open" }, controller.signal))
      .rejects.toMatchObject({ code: "interrupted" });
    expect(client.calls.filter(({ method }) => method === "mcpServer/tool/call")).toHaveLength(0);

    client.responses.push(new Error("secret url/title"));
    await expect(transport.execute("/work", identity, { kind: "open" }))
      .rejects.toMatchObject({ code: "request_failed", message: "Chrome transport request failed" });
    expect(client.calls.filter(({ method }) => method === "mcpServer/tool/call")).toHaveLength(1);
  });

  it("resets preparation and fails closed when capability discovery is unavailable", async () => {
    const { client, threads, transport } = createTransport();
    await transport.prepare("/work", initialize);
    client.responses.push(success({ kind: "opened" }));
    await transport.execute("/work", identity, { kind: "open" });
    transport.reset();
    await expect(transport.execute("/work", identity, { kind: "observe" })).rejects.toMatchObject({ code: "not_prepared" });

    client.responses.push({ content: [] });
    await transport.prepare("/work", initialize);
    expect(client.calls.filter(({ method }) => method === "plugin/list")).toHaveLength(2);
    expect(threads.calls).toEqual(["/work", "/work"]);

    evaluateChromeCapabilities.mockResolvedValueOnce({ status: "unavailable", reason: "unsupported_version_tuple", message: "Chrome is unavailable" });
    const unavailable = createTransport();
    await expect(unavailable.transport.prepare("/work", initialize)).rejects.toMatchObject({
      code: "unavailable", message: "Chrome is unavailable",
    });
  });
});
