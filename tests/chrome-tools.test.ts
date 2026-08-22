import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import type { ChromeRuntime } from "../src/chrome-runtime";
import { CHROME_TOOL_NAMES, registerChromeTools } from "../src/chrome-tools";
import type { ChromeResult } from "../src/chrome-transport";

type FakePi = {
  zod: typeof z;
  tools: unknown[];
  registerTool(tool: unknown): void;
};

type RegisteredTool = {
  name: string;
  approval?: string;
  defaultInactive?: boolean;
  parameters: { safeParse: (value: unknown) => { success: boolean } };
  execute: (...args: unknown[]) => Promise<unknown>;
};

function createFakePi(zodApi: typeof z = z): FakePi {
  const tools: unknown[] = [];
  return {
    zod: zodApi,
    tools,
    registerTool(tool: unknown): void {
      tools.push(tool);
    },
  };
}

function createContext() {
  return { cwd: "/tmp/project", hasUI: false };
}

function getTool(pi: FakePi, name: string): RegisteredTool {
  const tool = pi.tools.find((entry) => typeof entry === "object" && entry !== null && "name" in entry && entry.name === name);
  if (!tool || typeof tool !== "object") throw new Error(`missing tool ${name}`);
  return tool as RegisteredTool;
}

function runtimeReturning(result: ChromeResult) {
  return {
    open: vi.fn(async () => result),
    observe: vi.fn(async () => result),
    act: vi.fn(async () => result),
  };

}

describe("registerChromeTools", () => {
  it("registers exactly the three inactive tools with the required approvals", () => {
    const pi = createFakePi();
    registerChromeTools(pi as never, runtimeReturning({ kind: "opened" }) as unknown as ChromeRuntime);

    expect(CHROME_TOOL_NAMES).toEqual(["chrome_open", "chrome_observe", "chrome_act"]);
    expect(pi.tools.map((tool) => {
      if (typeof tool !== "object" || tool === null || !("name" in tool) || typeof tool.name !== "string") {
        throw new Error("registered tool has no name");
      }
      return tool.name;
    })).toEqual([...CHROME_TOOL_NAMES]);
    expect(pi.tools).toHaveLength(3);
    expect(getTool(pi, "chrome_open")).toMatchObject({ approval: "write", defaultInactive: true });
    expect(getTool(pi, "chrome_observe")).toMatchObject({ approval: "read", defaultInactive: true });
    expect(getTool(pi, "chrome_act")).toMatchObject({ approval: "write", defaultInactive: true });
  });

  it("loads with the OMP Zod-compatible surface that omits discriminatedUnion", () => {
    const compatibleZod = new Proxy(z, {
      get(target, property, receiver) {
        if (property === "discriminatedUnion") return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    const pi = createFakePi(compatibleZod);

    expect(() => registerChromeTools(
      pi as never,
      runtimeReturning({ kind: "opened" }) as unknown as ChromeRuntime,
    )).not.toThrow();
    expect(pi.tools).toHaveLength(3);
  });

  it("uses strict schemas with only the optional open url and observe offset", () => {
    const pi = createFakePi();
    registerChromeTools(pi as never, runtimeReturning({ kind: "opened" }) as unknown as ChromeRuntime);

    const open = getTool(pi, "chrome_open").parameters;
    expect(open.safeParse({}).success).toBe(true);
    expect(open.safeParse({ url: "https://example.com/" }).success).toBe(true);
    expect(open.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
    expect(open.safeParse({ url: "https://example.com/", unexpected: true }).success).toBe(false);

    const observe = getTool(pi, "chrome_observe").parameters;
    expect(observe.safeParse({}).success).toBe(true);
    expect(observe.safeParse({ offset: 3000 }).success).toBe(true);
    expect(observe.safeParse({ offset: 0 }).success).toBe(false);
    expect(observe.safeParse({ offset: 1.5 }).success).toBe(false);
    expect(observe.safeParse({ offset: 1_000_001 }).success).toBe(false);
    expect(observe.safeParse({ unexpected: true }).success).toBe(false);
  });

  it("accepts only the strict finite Chrome action union", () => {
    const pi = createFakePi();
    registerChromeTools(pi as never, runtimeReturning({ kind: "opened" }) as unknown as ChromeRuntime);
    const schema = getTool(pi, "chrome_act").parameters;
    const target = { kind: "role", role: "button", name: "Continue" };

    expect(schema.safeParse({ action: { kind: "navigate", url: "https://example.com/path" } }).success).toBe(true);
    expect(schema.safeParse({ action: { kind: "click", target } }).success).toBe(true);
    expect(schema.safeParse({ action: { kind: "fill", target, value: "hello" } }).success).toBe(true);
    expect(schema.safeParse({ action: { kind: "press", target, key: "Enter" } }).success).toBe(true);
    expect(schema.safeParse({ action: { kind: "close" } }).success).toBe(true);

    expect(schema.safeParse({ action: { kind: "click", target, selector: "#danger" } }).success).toBe(false);
    expect(schema.safeParse({ action: { kind: "click", target: { kind: "regex", value: ".*" } } }).success).toBe(false);
    expect(schema.safeParse({ action: { kind: "press", target, key: "Ctrl+R" } }).success).toBe(false);
    expect(schema.safeParse({ action: { kind: "unsupported" } }).success).toBe(false);
  });

  it("accepts the extended semantic actions and enforces UTF-8 byte bounds", () => {
    const pi = createFakePi();
    registerChromeTools(pi as never, runtimeReturning({ kind: "opened" }) as unknown as ChromeRuntime);
    const schema = getTool(pi, "chrome_act").parameters;
    const target = { kind: "label", label: "Country" };

    expect(schema.safeParse({ action: { kind: "back" } }).success).toBe(true);
    expect(schema.safeParse({ action: { kind: "forward" } }).success).toBe(true);
    expect(schema.safeParse({ action: { kind: "reload" } }).success).toBe(true);
    expect(schema.safeParse({ action: { kind: "select", target, option: "Sweden" } }).success).toBe(true);
    expect(schema.safeParse({ action: { kind: "check", target, checked: true } }).success).toBe(true);

    expect(schema.safeParse({ action: { kind: "back", url: "https://example.com/" } }).success).toBe(false);
    expect(schema.safeParse({ action: { kind: "select", target } }).success).toBe(false);
    expect(schema.safeParse({ action: { kind: "check", target, checked: "yes" } }).success).toBe(false);

    // 600 characters of two-byte UTF-8 exceed the 1024-byte locator bound.
    const multibyte = "Å".repeat(600);
    expect(schema.safeParse({ action: { kind: "click", target: { kind: "text", text: multibyte } } }).success).toBe(false);
    expect(schema.safeParse({ action: { kind: "select", target, option: multibyte } }).success).toBe(false);
    // 20000 two-byte characters pass the char cap but exceed the 32768-byte bound.
    expect(schema.safeParse({ action: { kind: "fill", target, value: "Å".repeat(20_000) } }).success).toBe(false);
    expect(schema.safeParse({ action: { kind: "fill", target, value: "x".repeat(32_768) } }).success).toBe(true);
    // URLs with embedded whitespace are rejected to mirror the transport.
    expect(schema.safeParse({ action: { kind: "navigate", url: "https://example.com/a b" } }).success).toBe(false);
  });

  it("rejects unsafe URLs and malformed semantic locators", () => {
    const pi = createFakePi();
    registerChromeTools(pi as never, runtimeReturning({ kind: "opened" }) as unknown as ChromeRuntime);
    const schema = getTool(pi, "chrome_act").parameters;

    for (const url of ["file:///tmp/x", "javascript:alert(1)", "https://user:pass@example.com", "chrome://settings"]) {
      expect(schema.safeParse({ action: { kind: "navigate", url } }).success).toBe(false);
    }
    expect(schema.safeParse({ action: { kind: "click", target: { kind: "role", role: "" } } }).success).toBe(false);
    expect(schema.safeParse({ action: { kind: "fill", target: { kind: "text", text: "Submit" }, value: "x" } }).success).toBe(true);
  });

  it("forwards open, observe, and their parameters with the abort signal", async () => {
    const pi = createFakePi();
    const runtime = runtimeReturning({ kind: "snapshot", text: "snapshot", truncated: false, byteLength: 8 });
    registerChromeTools(pi as never, runtime as unknown as ChromeRuntime);
    const ctx = createContext();
    const controller = new AbortController();

    await getTool(pi, "chrome_observe").execute("call-1", {}, controller.signal, undefined, ctx);
    expect(runtime.observe).toHaveBeenCalledWith(ctx, undefined, controller.signal);

    await getTool(pi, "chrome_observe").execute("call-2", { offset: 3000 }, undefined, undefined, ctx);
    expect(runtime.observe).toHaveBeenLastCalledWith(ctx, 3000, undefined);

    await getTool(pi, "chrome_open").execute("call-3", { url: "https://example.com/" }, controller.signal, undefined, ctx);
    expect(runtime.open).toHaveBeenLastCalledWith(ctx, "https://example.com/", controller.signal);
  });

  it("dispatches once and exposes only safe result fields", async () => {
    const pi = createFakePi();
    const runtime = runtimeReturning({
      kind: "snapshot",
      text: "Visible page text",
      truncated: true,
      byteLength: 123,
    });
    registerChromeTools(pi as never, runtime as unknown as ChromeRuntime);
    const ctx = createContext();
    const action = { kind: "click", target: { kind: "text", text: "Continue" } };

    const result = await getTool(pi, "chrome_act").execute("call-1", { action }, undefined, undefined, ctx);

    expect(runtime.act).toHaveBeenCalledWith(ctx, action);
    expect(result).toEqual({
      content: [{ type: "text", text: "Visible page text" }],
      details: { kind: "snapshot", truncated: true, byteLength: 123 },
    });
    expect(JSON.stringify(result)).not.toContain("url");
    expect(JSON.stringify(result)).not.toContain("title");
    expect(JSON.stringify(result)).not.toContain("tab");
    expect(JSON.stringify(result)).not.toContain("metadata");
  });

  it("does not expose page text for open or close results", async () => {
    const pi = createFakePi();
    const runtime = runtimeReturning({ kind: "opened" });
    registerChromeTools(pi as never, runtime as unknown as ChromeRuntime);
    const openResult = await getTool(pi, "chrome_open").execute("call-1", {}, undefined, undefined, createContext());
    expect(openResult).toEqual({
      content: [{ type: "text", text: "Chrome tab opened." }],
      details: { kind: "opened", truncated: false, byteLength: 0 },
    });

    runtime.act.mockResolvedValue({ kind: "closed" });
    const closeResult = await getTool(pi, "chrome_act").execute(
      "call-2",
      { action: { kind: "close" } },
      undefined,
      undefined,
      createContext(),
    );
    expect(closeResult).toEqual({
      content: [{ type: "text", text: "Chrome tab closed." }],
      details: { kind: "closed", truncated: false, byteLength: 0 },
    });
  });
});
