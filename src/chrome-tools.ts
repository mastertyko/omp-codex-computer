import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ChromeAction, ChromeResult } from "./chrome-transport";
import type { ChromeRuntime } from "./chrome-runtime";

export const CHROME_TOOL_NAMES = Object.freeze([
  "chrome_open",
  "chrome_observe",
  "chrome_act",
] as const);

type ChromeToolName = (typeof CHROME_TOOL_NAMES)[number];

type ChromeToolDetails = {
  kind: ChromeResult["kind"];
  truncated: boolean;
  byteLength: number;
};

type ToolDefinition = {
  name: ChromeToolName;
  label: string;
  description: string;
  approval: "read" | "write";
};

const TOOLS: readonly ToolDefinition[] = [
  {
    name: "chrome_open",
    label: "Open Chrome",
    description: "Open the single agent-owned Chrome tab for an explicit web task.",
    approval: "write",
  },
  {
    name: "chrome_observe",
    label: "Observe Chrome",
    description: "Read the current snapshot from the single agent-owned Chrome tab.",
    approval: "read",
  },
  {
    name: "chrome_act",
    label: "Act in Chrome",
    description: "Perform one safe, explicit action in the single agent-owned Chrome tab.",
    approval: "write",
  },
] as const;

export function registerChromeTools(pi: ExtensionAPI, runtime: ChromeRuntime): void {
  const schemas = createParameterSchemas(pi);

  for (const tool of TOOLS) {
    const definition = {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: schemas[tool.name],
      defaultInactive: true,
      approval: tool.approval,
      async execute(
        _toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        let result: ChromeResult;
        switch (tool.name) {
          case "chrome_open":
            result = signal ? await runtime.open(ctx, signal) : await runtime.open(ctx);
            break;
          case "chrome_observe":
            result = signal ? await runtime.observe(ctx, signal) : await runtime.observe(ctx);
            break;
          case "chrome_act": {
            const actParams = params as { action: ChromeAction };
            result = signal ? await runtime.act(ctx, actParams.action, signal) : await runtime.act(ctx, actParams.action);
            break;
          }
        }
        return shapeResult(result);
      },
    };
    pi.registerTool(definition as Parameters<ExtensionAPI["registerTool"]>[0]);
  }
}

function createParameterSchemas(pi: ExtensionAPI): Record<ChromeToolName, unknown> {
  const z = pi.zod;
  const strictObject = <T extends Record<string, unknown>>(shape: T) => z.object(shape).strict();
  const nonEmpty = (description: string) => z.string().min(1).describe(description);
  const locator = z.union([
    strictObject({
      kind: z.literal("role"),
      role: nonEmpty("The semantic ARIA role."),
      name: z.string().min(1).optional().describe("The accessible name, when needed."),
    }),
    strictObject({
      kind: z.literal("text"),
      text: nonEmpty("The visible text to match."),
    }),
    strictObject({
      kind: z.literal("label"),
      label: nonEmpty("The form label to match."),
    }),
    strictObject({
      kind: z.literal("placeholder"),
      placeholder: nonEmpty("The placeholder to match."),
    }),
    strictObject({
      kind: z.literal("test_id"),
      testId: nonEmpty("The test id to match."),
    }),
  ]).describe("A semantic page target; selectors, regexes, coordinates, and indexes are not supported.");

  const url = z.string()
    .min(1)
    .max(2048)
    .refine((value: string) => {
      try {
        const parsed = new URL(value);
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
          && parsed.username === ""
          && parsed.password === "";
      } catch {
        return false;
      }
    }, "Use an absolute http(s) URL without credentials.");
  const key = z.enum([
    "Enter",
    "Tab",
    "Shift+Tab",
    "Escape",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Backspace",
    "Delete",
    "Space",
  ]);
  const action = z.union([
    strictObject({ kind: z.literal("navigate"), url }),
    strictObject({ kind: z.literal("click"), target: locator }),
    strictObject({ kind: z.literal("fill"), target: locator, value: z.string().max(32768) }),
    strictObject({ kind: z.literal("press"), target: locator, key }),
    strictObject({ kind: z.literal("close") }),
  ]).describe("One finite Chrome action; no raw JavaScript, CDP, selectors, or arbitrary keys.");

  return {
    chrome_open: strictObject({}),
    chrome_observe: strictObject({}),
    chrome_act: strictObject({ action }),
  };
}

function shapeResult(result: ChromeResult): { content: [{ type: "text"; text: string }]; details: ChromeToolDetails } {
  switch (result.kind) {
    case "snapshot":
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          kind: "snapshot",
          truncated: result.truncated,
          byteLength: result.byteLength,
        },
      };
    case "opened":
      return {
        content: [{ type: "text", text: "Chrome tab opened." }],
        details: { kind: "opened", truncated: false, byteLength: 0 },
      };
    case "closed":
      return {
        content: [{ type: "text", text: "Chrome tab closed." }],
        details: { kind: "closed", truncated: false, byteLength: 0 },
      };
  }
  throw new Error("Unknown Chrome result");
}

