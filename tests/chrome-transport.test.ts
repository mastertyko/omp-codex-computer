import { describe, expect, it, vi } from "vitest";
import type { AppServerClient } from "../src/app-server-client";
import {
  CHROME_PRESS_KEYS,
  ChromeTransport,
  ChromeTransportError,
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

function failure(error: string, phase: string): { content: unknown[] } {
  return { content: [{ type: "text", text: JSON.stringify({ protocol: "omp-codex-computer/chrome-v1", ok: false, error, phase }) }] };
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

    client.responses.push(failure("operation_failed", "action"));
    await expect(transport.execute("/work", identity, { kind: "open" })).rejects.toMatchObject({
      code: "operation_failed", message: "Chrome operation failed (action phase)", phase: "action",
    });
  });

  it("rejects error envelopes without a known program phase", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);

    client.responses.push({ content: [{ type: "text", text: JSON.stringify({
      protocol: "omp-codex-computer/chrome-v1", ok: false, error: "operation_failed",
    }) }] });
    await expect(transport.execute("/work", identity, { kind: "observe" }))
      .rejects.toMatchObject({ code: "protocol_failed" });

    client.responses.push(failure("operation_failed", "sneaky"));
    await expect(transport.execute("/work", identity, { kind: "observe" }))
      .rejects.toMatchObject({ code: "protocol_failed" });
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

  it("accepts the extended finite action set and forwards it in the payload", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);
    const target = { kind: "label", label: "Country" } as const;
    const actions = [
      { kind: "back" },
      { kind: "forward" },
      { kind: "reload" },
      { kind: "select", target, option: "Sweden" },
      { kind: "check", target, checked: true },
    ] as const;

    for (const action of actions) {
      client.responses.push(success({ kind: "snapshot", text: "after", truncated: false, byteLength: 5 }));
      await expect(transport.execute("/work", identity, { kind: "act", action } as never))
        .resolves.toMatchObject({ kind: "snapshot" });
    }
    const payloads = client.calls
      .filter(({ method }) => method === "mcpServer/tool/call")
      .map(getProgram)
      .map(decodePayload) as Array<{ operation: { kind: string; action: { kind: string } } }>;
    expect(payloads.map(({ operation }) => operation.action.kind)).toEqual([
      "back", "forward", "reload", "select", "check",
    ]);
  });

  it("rejects malformed extended actions before dispatch", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);
    const target = { kind: "label", label: "Country" } as const;
    const actions: unknown[] = [
      { kind: "back", url: "https://example.com/" },
      { kind: "select", target },
      { kind: "select", target, option: "" },
      { kind: "select", target, option: "x".repeat(2048) },
      { kind: "check", target, checked: "yes" },
      { kind: "check", target },
    ];
    for (const action of actions) {
      await expect(transport.execute("/work", identity, { kind: "act", action } as never))
        .rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(client.calls.filter(({ method }) => method === "mcpServer/tool/call")).toHaveLength(0);
  });

  it("opens with an optional URL and expects a snapshot result", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);
    client.responses.push(success({ kind: "snapshot", text: "Example Domain", truncated: false, byteLength: 14 }));

    await expect(transport.execute("/work", identity, { kind: "open", url: "https://example.com/" }))
      .resolves.toMatchObject({ kind: "snapshot", text: "Example Domain" });
    expect(decodePayload(getProgram(getToolCall(client)))).toEqual({
      identity,
      operation: { kind: "open", url: "https://example.com/" },
    });

    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pass@example.com/"]) {
      await expect(transport.execute("/work", identity, { kind: "open", url }))
        .rejects.toMatchObject({ code: "invalid_request" });
    }

    client.responses.push(success({ kind: "opened" }));
    await expect(transport.execute("/work", identity, { kind: "open", url: "https://example.com/" }))
      .rejects.toMatchObject({ code: "protocol_failed" });
  });

  it("pages observe snapshots by line offset and bounds the offset", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);
    client.responses.push(success({ kind: "snapshot", text: "tail", truncated: false, byteLength: 4 }));

    await expect(transport.execute("/work", identity, { kind: "observe", offset: 3000 }))
      .resolves.toMatchObject({ kind: "snapshot", text: "tail" });
    expect(decodePayload(getProgram(getToolCall(client)))).toEqual({
      identity,
      operation: { kind: "observe", offset: 3000 },
    });

    for (const offset of [0, -1, 1.5, Number.NaN, 1_000_001]) {
      await expect(transport.execute("/work", identity, { kind: "observe", offset } as never))
        .rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("maps the new program error codes onto benign transport errors", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);
    for (const [code, phase] of [
      ["element_not_found", "locate"],
      ["ambiguous_locator", "locate"],
      ["locate_failed", "locate"],
      ["navigation_failed", "navigate"],
    ] as const) {
      client.responses.push(failure(code, phase));
      await expect(transport.execute("/work", identity, { kind: "observe" }))
        .rejects.toMatchObject({ code, poisons: false, phase });
    }
  });

  it("classifies poisoning versus benign codes on the error type", () => {
    const benign = [
      "unavailable", "invalid_request", "tab_already_open", "tab_not_open",
      "element_not_found", "ambiguous_locator", "locate_failed", "navigation_failed",
      "snapshot_failed", "snapshot_failed_after_action", "close_failed",
    ] as const;
    const poisoning = ["not_prepared", "protocol_failed", "operation_failed", "interrupted", "request_failed"] as const;
    for (const code of benign) expect(new ChromeTransportError(code).poisons).toBe(false);
    for (const code of poisoning) expect(new ChromeTransportError(code).poisons).toBe(true);
  });

  it("generates a visible-aware single-match precheck with bounded action timeouts", async () => {
    const { client, transport } = createTransport();
    await transport.prepare("/work", initialize);
    client.responses.push(success({ kind: "snapshot", text: "after", truncated: false, byteLength: 5 }));
    await transport.execute("/work", identity, {
      kind: "act", action: { kind: "click", target: { kind: "text", text: "Continue" } },
    });

    const program = getProgram(getToolCall(client));
    expect(program).toContain('waitFor({ state: "attached", timeoutMs: locatorWaitTimeoutMs })');
    expect(program).toContain("locator.count()");
    expect(program).toContain('fail("ambiguous_locator")');
    expect(program).toContain('fail("element_not_found")');
    expect(program).toContain("locator.nth(index).isVisible()");
    expect(program).toContain("matches > maxVisibilityProbes");
    expect(program).toContain("snapshotSecondAttemptDelayMs");
    expect(program).toContain("locator.nth(visibleIndex)");
    expect(program).toContain("resolved.click({ timeoutMs: actionTimeoutMs })");
    expect(program).toContain('selectOption({ label: action.option }');
    expect(program).toContain("setChecked(action.checked");
    expect(program).toContain("tab.back()");
    expect(program).toContain("tab.reload()");
    expect(program).toContain("const hasFns = ");
    expect(program).toContain("if (!hasFns(locator, locatorContract)) fail(\"unavailable\");");
    expect(program).toContain("const actionFn = actionContract[action.kind];");
    expect(program).toContain("if (actionFn === undefined || !hasFns(resolved, [actionFn])) fail(\"unavailable\");");
    expect(program).toContain("if (!hasFns(tab, tabContract) || !hasFns(tab.playwright, playwrightContract))");
    expect(program).toContain('if (typeof setupBrowserRuntime !== "function") throw new Error("client contract");');
    expect(program).toContain('if (typeof agentRuntime?.browsers?.get !== "function") throw new Error("client contract");');
    expect(program).toContain('phase = "locate";');
    expect(program.indexOf('phase = "locate";')).toBeLessThan(program.indexOf("resolveSingleMatch(createLocator"));
    expect(program).toContain('? "locate_failed"');
    expect(program).toContain("writeEnvelope({ ok: false, error: code, phase });");
  });

  it("forwards probe-only extra trusted versions into capability evaluation", async () => {
    evaluateChromeCapabilities.mockResolvedValue(readyCapabilities());
    const client = new FakeClient();
    const threads = new FakeThreads();
    const transport = new ChromeTransport(client, threads, {
      extraTrustedAppServerVersions: ["0.151.0"],
    });

    await transport.prepare("/work", initialize);

    expect(evaluateChromeCapabilities).toHaveBeenLastCalledWith(
      initialize,
      undefined,
      undefined,
      process.env,
      ["0.151.0"],
    );

    const bare = createTransport();
    await bare.transport.prepare("/work", initialize);
    expect(evaluateChromeCapabilities).toHaveBeenLastCalledWith(
      initialize,
      undefined,
      undefined,
      process.env,
      [],
    );
  });

  it("retries discovery after a failed prepare instead of pinning the rejection", async () => {
    evaluateChromeCapabilities.mockResolvedValueOnce({
      status: "unavailable", reason: "plugin_disabled", message: "Chrome is unavailable",
    });
    const { client, transport } = createTransport();
    await expect(transport.prepare("/work", initialize)).rejects.toMatchObject({ code: "unavailable" });

    await transport.prepare("/work", initialize);
    client.responses.push(success({ kind: "opened" }));
    await expect(transport.execute("/work", identity, { kind: "open" })).resolves.toEqual({ kind: "opened" });
    expect(client.calls.filter(({ method }) => method === "plugin/list")).toHaveLength(2);
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

    evaluateChromeCapabilities.mockResolvedValueOnce({ status: "unavailable", reason: "unsupported_app_server_version", message: "Chrome is unavailable" });
    const unavailable = createTransport();
    await expect(unavailable.transport.prepare("/work", initialize)).rejects.toMatchObject({
      code: "unavailable", message: "Chrome is unavailable",
    });
  });
});
