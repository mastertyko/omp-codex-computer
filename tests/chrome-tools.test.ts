import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import type { ComputerUseRuntime } from "../src/runtime";
import { CHROME_TOOL_NAMES, registerChromeTools } from "../src/chrome-tools";

function createFakePi() {
  const tools: unknown[] = [];
  return {
    zod: z,
    tools,
    registerTool(tool: unknown): void {
      tools.push(tool);
    },
  };
}

function createContext() {
  return { cwd: "/tmp/project", hasUI: false };
}

function getRegisteredTool(pi: ReturnType<typeof createFakePi>, name: string) {
  const tool = pi.tools.find((entry) => (entry as { name: string }).name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool as { parameters: { safeParse: (value: unknown) => { success: boolean } } };
}

describe("registerChromeTools", () => {
  it("registers the Chrome tools in a stable public order", () => {
    const pi = createFakePi();
    const runtime = { callChromeTool: vi.fn() } as unknown as ComputerUseRuntime;

    registerChromeTools(pi as never, runtime);

    expect(CHROME_TOOL_NAMES).toContain("codex_chrome_list_browsers");
    expect(CHROME_TOOL_NAMES).toContain("codex_chrome_get_visible_dom");
    expect(CHROME_TOOL_NAMES).toContain("codex_chrome_dom_click");
    expect(CHROME_TOOL_NAMES).toContain("codex_chrome_screenshot");
    expect(pi.tools.map((tool) => (tool as { name: string }).name)).toEqual(CHROME_TOOL_NAMES);
  });

  it("forwards execute calls to matching Chrome backend tools", async () => {
    const pi = createFakePi();
    const runtime = {
      callChromeTool: vi.fn(async () => ({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { ok: true },
      })),
    };
    registerChromeTools(pi as never, runtime as unknown as ComputerUseRuntime);

    const tool = pi.tools.find((entry) => (entry as { name: string }).name === "codex_chrome_goto") as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };
    const params = { url: "https://example.com" };
    const result = await tool.execute("call-1", params, undefined, undefined, createContext());

    expect(runtime.callChromeTool).toHaveBeenCalledWith(createContext(), "goto", params);
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: {
        contentTypes: ["text"],
        counts: { text: 1 },
        hasStructuredContent: true,
        hasMeta: false,
      },
    });
  });

  it("registers parameter schemas for important Chrome workflows", () => {
    const pi = createFakePi();
    const runtime = { callChromeTool: vi.fn() } as unknown as ComputerUseRuntime;
    registerChromeTools(pi as never, runtime);

    expect(getRegisteredTool(pi, "codex_chrome_list_browsers").parameters.safeParse({}).success).toBe(true);
    expect(getRegisteredTool(pi, "codex_chrome_goto").parameters.safeParse({}).success).toBe(false);
    expect(getRegisteredTool(pi, "codex_chrome_goto").parameters.safeParse({ url: "https://example.com" }).success).toBe(true);
    expect(getRegisteredTool(pi, "codex_chrome_dom_click").parameters.safeParse({ node_id: 12 }).success).toBe(true);
    expect(getRegisteredTool(pi, "codex_chrome_type_text").parameters.safeParse({ text: "hello" }).success).toBe(true);
  });

  it("keeps the coordinate double-click schema aligned with Chrome API options", () => {
    const pi = createFakePi();
    const runtime = { callChromeTool: vi.fn() } as unknown as ComputerUseRuntime;
    registerChromeTools(pi as never, runtime);

    const schema = z.toJSONSchema(getRegisteredTool(pi, "codex_chrome_double_click").parameters as never) as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).toHaveProperty("x");
    expect(schema.properties).toHaveProperty("y");
    expect(schema.properties).toHaveProperty("keypress");
    expect(schema.properties).not.toHaveProperty("button");
  });
});
