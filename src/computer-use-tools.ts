import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { OmpContentBlock } from "./content";
import type { ComputerUseToolResult } from "./computer-use-backend";
import type { ComputerUseRuntime } from "./runtime";

export const COMPUTER_USE_TOOL_NAMES = [
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
] as const;

const COMPUTER_USE_TOOLS = [
  {
    name: "computer_use_list_apps",
    mcpToolName: "list_apps",
    label: "List Apps",
    description: "List visible applications and windows available for Computer Use.",
    approval: "read",
  },
  {
    name: "computer_use_get_app_state",
    mcpToolName: "get_app_state",
    label: "Get App State",
    description: "Inspect the current state of an application for Computer Use.",
    approval: "read",
  },
  {
    name: "computer_use_click",
    mcpToolName: "click",
    label: "Click",
    description: "Click a target in an application through Computer Use.",
    approval: "write",
  },
  {
    name: "computer_use_type_text",
    mcpToolName: "type_text",
    label: "Type Text",
    description: "Type text into an application through Computer Use.",
    approval: "write",
  },
  {
    name: "computer_use_press_key",
    mcpToolName: "press_key",
    label: "Press Key",
    description: "Press a key or keyboard shortcut through Computer Use.",
    approval: "write",
  },
  {
    name: "computer_use_scroll",
    mcpToolName: "scroll",
    label: "Scroll",
    description: "Scroll within an application through Computer Use.",
    approval: "write",
  },
  {
    name: "computer_use_drag",
    mcpToolName: "drag",
    label: "Drag",
    description: "Drag from one point to another through Computer Use.",
    approval: "write",
  },
  {
    name: "computer_use_set_value",
    mcpToolName: "set_value",
    label: "Set Value",
    description: "Set the value of a control through Computer Use.",
    approval: "write",
  },
  {
    name: "computer_use_select_text",
    mcpToolName: "select_text",
    label: "Select Text",
    description: "Select text in an application through Computer Use.",
    approval: "write",
  },
  {
    name: "computer_use_perform_secondary_action",
    mcpToolName: "perform_secondary_action",
    label: "Secondary Action",
    description: "Perform a secondary action such as a contextual click through Computer Use.",
    approval: "write",
  },
] as const satisfies ReadonlyArray<{
  name: (typeof COMPUTER_USE_TOOL_NAMES)[number];
  mcpToolName: string;
  label: string;
  description: string;
  approval: "read" | "write";
}>;

export const COMPUTER_USE_MCP_TOOL_NAMES = Object.freeze(COMPUTER_USE_TOOLS.map((tool) => tool.mcpToolName));

export function registerComputerUseTools(pi: ExtensionAPI, runtime: ComputerUseRuntime): void {
  const parametersByTool = createParameterSchemas(pi);

  for (const tool of COMPUTER_USE_TOOLS) {
    const definition = {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: parametersByTool[tool.name],
      defaultInactive: true,
      approval: tool.approval,
      mcpServerName: "computer-use",
      mcpToolName: tool.mcpToolName,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        const result = await runtime.callTool(ctx, tool.mcpToolName, params as Record<string, unknown>);
        return {
          content: result.content,
          details: summarizeResult(result),
        };
      },
    };
    pi.registerTool(definition as Parameters<ExtensionAPI["registerTool"]>[0]);
  }
}

function createParameterSchemas(pi: ExtensionAPI): Record<(typeof COMPUTER_USE_TOOL_NAMES)[number], unknown> {
  const z = pi.zod;
  const app = z.string().describe("The application to inspect or control.");
  const elementIndex = z.string().describe("The target element index from the app state.");

  return {
    computer_use_list_apps: z.object({}),
    computer_use_get_app_state: z.object({
      app,
    }).passthrough(),
    computer_use_click: z.object({
      app,
      element_index: elementIndex.optional(),
      x: z.number().describe("The x coordinate to click.").optional(),
      y: z.number().describe("The y coordinate to click.").optional(),
      click_count: z.number().describe("The number of clicks to perform.").optional(),
      mouse_button: z.enum(["left", "right", "middle"]).describe("The mouse button to click.").optional(),
    }).passthrough(),
    computer_use_type_text: z.object({
      app,
      text: z.string().describe("The text to type."),
    }).passthrough(),
    computer_use_press_key: z.object({
      app,
      key: z.string().describe("The key or keyboard shortcut to press."),
    }).passthrough(),
    computer_use_scroll: z.object({
      app,
      element_index: elementIndex,
      direction: z.enum(["up", "down", "left", "right"]).describe("The scroll direction."),
      pages: z.number().describe("The number of pages to scroll.").optional(),
    }).passthrough(),
    computer_use_drag: z.object({
      app,
      from_x: z.number().describe("The drag start x coordinate."),
      from_y: z.number().describe("The drag start y coordinate."),
      to_x: z.number().describe("The drag end x coordinate."),
      to_y: z.number().describe("The drag end y coordinate."),
    }).passthrough(),
    computer_use_set_value: z.object({
      app,
      element_index: elementIndex,
      value: z.string().describe("The value to set."),
    }).passthrough(),
    computer_use_select_text: z.object({
      app,
      element_index: elementIndex,
      text: z.string().describe("The text to select."),
      selection: z.enum(["text", "cursor_before", "cursor_after"]).describe("The selection behavior.").optional(),
      prefix: z.string().describe("Text before the target selection.").optional(),
      suffix: z.string().describe("Text after the target selection.").optional(),
    }).passthrough(),
    computer_use_perform_secondary_action: z.object({
      app,
      element_index: elementIndex,
      action: z.string().describe("The secondary action to perform."),
    }).passthrough(),
  };
}

interface ComputerUseToolSummary {
  contentTypes: string[];
  counts: Record<string, number>;
  hasStructuredContent: boolean;
  hasMeta: boolean;
}

function summarizeResult(result: ComputerUseToolResult): ComputerUseToolSummary {
  const counts: Record<string, number> = {};
  const contentTypes: string[] = [];

  for (const block of result.content) {
    const type = getContentType(block);
    counts[type] = (counts[type] ?? 0) + 1;
    if (!contentTypes.includes(type)) contentTypes.push(type);
  }

  return {
    contentTypes,
    counts,
    hasStructuredContent: result.structuredContent !== undefined,
    hasMeta: result.meta !== undefined,
  };
}

function getContentType(block: OmpContentBlock): string {
  return typeof block.type === "string" ? block.type : "unknown";
}
