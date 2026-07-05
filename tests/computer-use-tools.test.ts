import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import type { ComputerUseRuntime } from "../src/runtime";
import { COMPUTER_USE_TOOL_NAMES, registerComputerUseTools } from "../src/computer-use-tools";

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
    ]);
    expect(pi.tools.map((tool) => (tool as { name: string }).name)).toEqual(COMPUTER_USE_TOOL_NAMES);
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
});
