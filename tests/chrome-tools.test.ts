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

  it("uses strict empty schemas for open and observe", () => {
    const pi = createFakePi();
    registerChromeTools(pi as never, runtimeReturning({ kind: "opened" }) as unknown as ChromeRuntime);

    for (const name of ["chrome_open", "chrome_observe"]) {
      const schema = getTool(pi, name).parameters;
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ unexpected: true }).success).toBe(false);
    }
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

  it("forwards observe calls and their abort signal", async () => {
    const pi = createFakePi();
    const runtime = runtimeReturning({ kind: "snapshot", text: "snapshot", truncated: false, byteLength: 8 });
    registerChromeTools(pi as never, runtime as unknown as ChromeRuntime);
    const ctx = createContext();
    const controller = new AbortController();

    await getTool(pi, "chrome_observe").execute("call-1", {}, controller.signal, undefined, ctx);

    expect(runtime.observe).toHaveBeenCalledWith(ctx, controller.signal);
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
