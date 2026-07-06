import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import type { ComputerUseRuntime } from "../src/runtime";
import { COMPUTER_USE_MCP_TOOL_NAMES, COMPUTER_USE_TOOL_NAMES, registerComputerUseTools } from "../src/computer-use-tools";

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
  return tool as {
    approval?: string;
    defaultInactive?: boolean;
    execute: (...args: unknown[]) => Promise<unknown>;
    mcpServerName?: string;
    mcpToolName?: string;
    parameters: { safeParse: (value: unknown) => { success: boolean } };
  };
}

describe("registerComputerUseTools", () => {
  it("registers the Computer Use tools in the public order", () => {
    const pi = createFakePi();
    const runtime = { callTool: vi.fn() } as unknown as ComputerUseRuntime;

    registerComputerUseTools(pi as never, runtime);

    expect(COMPUTER_USE_TOOL_NAMES).toEqual([
      "computer_use_list_apps",
      "computer_use_get_app_state",
      "computer_use_click",
      "computer_use_type_text",
      "computer_use_press_key",
      "computer_use_scroll",
      "computer_use_drag",
      "computer_use_set_value",
      "computer_use_select_text",
      "computer_use_perform_secondary_action",
      "computer_use_resolve_app",
    ]);
    expect(pi.tools.map((tool) => (tool as { name: string }).name)).toEqual(COMPUTER_USE_TOOL_NAMES);
  });

  it("keeps local diagnostic tools out of the upstream MCP tool requirement list", () => {
    expect(COMPUTER_USE_MCP_TOOL_NAMES).toEqual([
      "list_apps",
      "get_app_state",
      "click",
      "type_text",
      "press_key",
      "scroll",
      "drag",
      "set_value",
      "select_text",
      "perform_secondary_action",
    ]);
    expect(COMPUTER_USE_MCP_TOOL_NAMES).not.toContain("computer_use_resolve_app");
  });

  it("registers resolve-app as a local read-only diagnostic tool and executes it without forwarding to upstream MCP", async () => {
    const pi = createFakePi();
    const ctx = createContext();
    const runtime = {
      callTool: vi.fn(),
      resolveAppTarget: vi.fn(async () => ({
        content: [{ type: "text", text: "resolved" }],
        structuredContent: { status: "unresolved" },
      })),
    };
    registerComputerUseTools(pi as never, runtime as unknown as ComputerUseRuntime);

    const tool = getRegisteredTool(pi, "computer_use_resolve_app");
    const result = await tool.execute("call-1", { app: "dudo" }, undefined, undefined, ctx);

    expect(tool).toMatchObject({
      approval: "read",
      defaultInactive: true,
    });
    expect(tool.mcpServerName).toBeUndefined();
    expect(tool.mcpToolName).toBeUndefined();
    expect(runtime.resolveAppTarget).toHaveBeenCalledWith(ctx, "dudo");
    expect(runtime.callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      content: [{ type: "text", text: "resolved" }],
      details: { hasStructuredContent: true },
    });
  });

  it("forwards execute calls to the matching MCP tool and summarizes payload shape", async () => {
    const pi = createFakePi();
    const runtime = {
      callTool: vi.fn(async () => ({
        content: [
          { type: "text", text: "secret visible text" },
          { type: "image", data: "secret base64", mimeType: "image/png" },
          { type: "text", text: "more text" },
        ],
        structuredContent: { app: "Finder" },
        meta: { trace: "hidden" },
      })),
    };
    registerComputerUseTools(pi as never, runtime as unknown as ComputerUseRuntime);

    const tool = pi.tools.find((entry) => (entry as { name: string }).name === "computer_use_click") as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };
    const params = { app: "Finder", x: 12, y: 34 };
    const result = await tool.execute("call-1", params, undefined, undefined, createContext());

    expect(runtime.callTool).toHaveBeenCalledWith(createContext(), "click", params);
    expect(result).toEqual({
      content: [
        { type: "text", text: "secret visible text" },
        { type: "image", data: "secret base64", mimeType: "image/png" },
        { type: "text", text: "more text" },
      ],
      details: {
        contentTypes: ["text", "image"],
        counts: { text: 2, image: 1 },
        hasStructuredContent: true,
        hasMeta: true,
      },
    });
    expect(JSON.stringify((result as { details: unknown }).details)).not.toContain("secret");
  });

  it("forwards the provided AbortSignal into runtime tool calls", async () => {
    const pi = createFakePi();
    const runtime = {
      callTool: vi.fn(async () => ({ content: [] })),
    };
    registerComputerUseTools(pi as never, runtime as unknown as ComputerUseRuntime);

    const tool = pi.tools.find((entry) => (entry as { name: string }).name === "computer_use_click") as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };
    const params = { app: "Finder", x: 12, y: 34 };
    const controller = new AbortController();
    const ctx = createContext();

    await tool.execute("call-1", params, controller.signal, undefined, ctx);

    expect(runtime.callTool).toHaveBeenCalledWith(ctx, "click", params, controller.signal);
  });

  it("registers specific parameter schemas for model-visible tool arguments", () => {
    const pi = createFakePi();
    const runtime = { callTool: vi.fn() } as unknown as ComputerUseRuntime;
    registerComputerUseTools(pi as never, runtime);

    expect(getRegisteredTool(pi, "computer_use_list_apps").parameters.safeParse({}).success).toBe(true);

    const getAppState = getRegisteredTool(pi, "computer_use_get_app_state").parameters;
    expect(getAppState.safeParse({}).success).toBe(false);
    expect(getAppState.safeParse({ app: "Finder" }).success).toBe(true);

    const resolveApp = getRegisteredTool(pi, "computer_use_resolve_app").parameters;
    expect(resolveApp.safeParse({}).success).toBe(false);
    expect(resolveApp.safeParse({ app: "pid:29156" }).success).toBe(true);

    const typeText = getRegisteredTool(pi, "computer_use_type_text").parameters;
    expect(typeText.safeParse({ app: "Finder" }).success).toBe(false);
    expect(typeText.safeParse({ app: "Finder", text: "hello" }).success).toBe(true);

    const click = getRegisteredTool(pi, "computer_use_click").parameters;
    expect(click.safeParse({ element_index: "1" }).success).toBe(false);
    expect(click.safeParse({ app: "Finder", element_index: "1" }).success).toBe(true);
    expect(click.safeParse({ app: "Finder", x: 12, y: 34 }).success).toBe(true);
  });
});
