import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { COMPUTER_USE_TOOL_NAMES } from "../src/computer-use-tools";

const runtimeInstances: FakeRuntime[] = [];
const statusMock = vi.hoisted(() => ({
  checkComputerUseStatus: vi.fn(async () => ({ reason: "ready", message: "ok" })),
  formatComputerUseStatus: vi.fn(() => "Computer Use status: ready"),
}));

class FakeRuntime {
  setContext = vi.fn();
  resetSession = vi.fn();
  shutdown = vi.fn(async () => {});
  callTool = vi.fn();

  constructor() {
    runtimeInstances.push(this);
  }
}

vi.mock("../src/runtime", () => ({
  ComputerUseRuntime: FakeRuntime,
}));

vi.mock("../src/status", () => statusMock);

function createFakePi(activeTools = ["read", "computer_use_click"]) {
  const tools: unknown[] = [];
  const commands = new Map<string, { description?: string; getArgumentCompletions?: (args: string) => unknown[] | Promise<unknown[]>; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  let active = [...activeTools];
  const setActiveToolsCalls: string[][] = [];
  const messages: unknown[] = [];

  return {
    zod: z,
    tools,
    commands,
    handlers,
    setActiveToolsCalls,
    messages,
    registerTool(tool: unknown): void {
      tools.push(tool);
    },
    registerCommand(name: string, options: { description?: string; getArgumentCompletions?: (args: string) => unknown[] | Promise<unknown[]>; handler: (args: string, ctx: unknown) => Promise<void> }): void {
      commands.set(name, options);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools(): string[] {
      return [...active];
    },
    async setActiveTools(toolNames: string[]): Promise<void> {
      active = [...toolNames];
      setActiveToolsCalls.push(toolNames);
    },
    sendMessage(message: unknown): void {
      messages.push(message);
    },
  };
}

function createCommandContext() {
  return {
    cwd: "/tmp/project",
    hasUI: true,
    ui: {
      notify: vi.fn(),
    },
  };
}

beforeEach(() => {
  runtimeInstances.length = 0;
  statusMock.checkComputerUseStatus.mockClear();
  statusMock.formatComputerUseStatus.mockClear();
});

describe("ompCodexComputer", () => {
  it("registers only Computer Use tools, resources, lifecycle hooks, and the codex-computer command", async () => {
    const pi = createFakePi();
    const { default: ompCodexComputer } = await import("../src/index");

    ompCodexComputer(pi as never);

    const registeredToolNames = pi.tools.map((tool) => (tool as { name: string }).name);
    expect(registeredToolNames).toEqual(COMPUTER_USE_TOOL_NAMES);
    expect(pi.commands.has("codex-computer")).toBe(true);
    expect(pi.commands.get("codex-computer")?.description).toBe("Manage Codex Computer Use tools.");
    expect([...pi.handlers.keys()].sort()).toEqual(["agent_end", "resources_discover", "session_shutdown", "session_start"]);

    const resources = await pi.handlers.get("resources_discover")?.[0]({ type: "resources_discover" }, createCommandContext());
    expect(resources).toEqual({ skillPaths: [expect.stringContaining("/skills")] });

    const completions = await pi.commands.get("codex-computer")?.getArgumentCompletions?.("");
    expect(completions).toEqual([
      { value: "status ", label: "status" },
      { value: "diagnose ", label: "diagnose" },
      { value: "enable ", label: "enable" },
      { value: "disable ", label: "disable" },
      { value: "restart ", label: "restart" },
    ]);
  });

  it("enables and disables only Computer Use tools while leaving non-managed tools alone", async () => {
    const pi = createFakePi(["read", "computer_use_click"]);
    const ctx = createCommandContext();
    const { default: ompCodexComputer } = await import("../src/index");
    ompCodexComputer(pi as never);
    const command = pi.commands.get("codex-computer");

    await command?.handler("enable", ctx);
    expect(pi.setActiveToolsCalls[0]).toEqual([
      "read",
      "computer_use_click",
      ...COMPUTER_USE_TOOL_NAMES.filter((name) => name !== "computer_use_click"),
    ]);

    await command?.handler("disable", ctx);
    expect(pi.setActiveToolsCalls[1]).toEqual(["read"]);
    expect(runtimeInstances.at(-1)?.shutdown).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Codex Computer Use tools disabled.", "info");
    expect(pi.messages.at(-1)).toEqual({
      customType: "codex-computer",
      content: "Codex Computer Use tools disabled.",
      display: true,
    });
  });

  it("restarts only the Computer Use runtime", async () => {
    const pi = createFakePi();
    const ctx = createCommandContext();
    const { default: ompCodexComputer } = await import("../src/index");
    ompCodexComputer(pi as never);
    const command = pi.commands.get("codex-computer");

    await command?.handler("restart", ctx);

    expect(runtimeInstances.at(-1)?.shutdown).toHaveBeenCalledTimes(1);
    expect(pi.messages.at(-1)).toEqual({
      customType: "codex-computer",
      content: "Codex Computer Use runtime restarted. It will reconnect on the next tool call.",
      display: true,
    });
  });

  it("handles status and diagnose commands with only Computer Use status output", async () => {
    const pi = createFakePi();
    const ctx = createCommandContext();
    const { default: ompCodexComputer } = await import("../src/index");
    ompCodexComputer(pi as never);
    const command = pi.commands.get("codex-computer");

    await command?.handler("status", ctx);
    await command?.handler("diagnose", ctx);

    expect(statusMock.checkComputerUseStatus).toHaveBeenNthCalledWith(1, "/tmp/project");
    expect(statusMock.checkComputerUseStatus).toHaveBeenNthCalledWith(2, "/tmp/project");
    expect(statusMock.formatComputerUseStatus).toHaveBeenCalledTimes(2);
    expect(pi.messages).toEqual([
      {
        customType: "codex-computer",
        content: "Computer Use status: ready",
        display: true,
      },
      {
        customType: "codex-computer",
        content: "Computer Use status: ready",
        display: true,
      },
    ]);
  });

  it("defaults an empty command to status", async () => {
    const pi = createFakePi();
    const ctx = createCommandContext();
    const { default: ompCodexComputer } = await import("../src/index");
    ompCodexComputer(pi as never);
    const command = pi.commands.get("codex-computer");

    await command?.handler("   ", ctx);

    expect(statusMock.checkComputerUseStatus).toHaveBeenCalledWith("/tmp/project");
    expect(pi.messages.at(-1)).toEqual({
      customType: "codex-computer",
      content: "Computer Use status: ready",
      display: true,
    });
    expect(JSON.stringify(pi.messages.at(-1))).not.toContain("Usage:");
  });
});
