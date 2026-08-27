import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { CHROME_TOOL_NAMES } from "../src/chrome-tools";
import { COMPUTER_USE_TOOL_NAMES } from "../src/computer-use-tools";
import ompCodexComputer from "../src/index";

const runtimeMock = vi.hoisted(() => {
  class FakeRuntime {
    setContext = vi.fn();
    resetSession = vi.fn();
    shutdown = vi.fn(async () => {});
    callTool = vi.fn();
    setStatusVisible = vi.fn();
    constructor() {
      runtimeInstances.push(this);
    }
  }

  class FakeChromeRuntime {
    beginAgent = vi.fn(async () => {});
    endAgent = vi.fn(async () => {});
    shutdown = vi.fn(async () => {});
    restart = vi.fn(async () => {});
    open = vi.fn();
    observe = vi.fn();
    act = vi.fn();
    constructor() {
      chromeRuntimeInstances.push(this);
    }
  }

  const runtimeInstances: FakeRuntime[] = [];
  const chromeRuntimeInstances: FakeChromeRuntime[] = [];
  return { FakeRuntime, FakeChromeRuntime, runtimeInstances, chromeRuntimeInstances };
});
const statusMock = vi.hoisted(() => ({
  checkComputerUseStatus: vi.fn(async () => ({ reason: "ready", message: "ok" })),
  formatComputerUseStatus: vi.fn(() => "Computer Use status: ready"),
}));
const chromeStatusMock = vi.hoisted(() => ({
  checkChromeStatus: vi.fn(async () => ({ status: "ready", reason: "ready", message: "ok" })),
  formatChromeStatus: vi.fn(() => "Chrome status: ready"),
}));
const trustProbeMock = vi.hoisted(() => ({
  runChromeTrustProbe: vi.fn(async () => "Chrome trust probe passed."),
}));
const trustStoreMock = vi.hoisted(() => ({
  clearPersistedAppServerVersions: vi.fn(async (): Promise<string | undefined> => "/tmp/trusted-app-servers.json"),
}));

const { runtimeInstances, chromeRuntimeInstances } = runtimeMock;

vi.mock("../src/runtime", () => ({
  ComputerUseRuntime: runtimeMock.FakeRuntime,
}));
vi.mock("../src/chrome-runtime", () => ({
  ChromeRuntime: runtimeMock.FakeChromeRuntime,
}));

vi.mock("../src/chrome-status", () => chromeStatusMock);

vi.mock("../src/chrome-trust-probe", () => trustProbeMock);
vi.mock("../src/chrome-trust", () => trustStoreMock);

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
    sessionManager: {
      getSessionId: () => "omp-session-1",
    },
  };
}

beforeEach(() => {
  runtimeInstances.length = 0;
  chromeRuntimeInstances.length = 0;
  statusMock.checkComputerUseStatus.mockClear();
  statusMock.formatComputerUseStatus.mockClear();
  chromeStatusMock.checkChromeStatus.mockClear();
  chromeStatusMock.formatChromeStatus.mockClear();
});

describe("ompCodexComputer", () => {
  it("registers distinct Computer Use and Chrome tools, resources, lifecycle hooks, and the codex-computer command", async () => {
    const pi = createFakePi();

    ompCodexComputer(pi as never);

    const registeredToolNames = pi.tools.map((tool) => (tool as { name: string }).name);
    expect(registeredToolNames).toEqual([...COMPUTER_USE_TOOL_NAMES, ...CHROME_TOOL_NAMES]);
    expect(pi.commands.has("codex-computer")).toBe(true);
    expect(pi.commands.get("codex-computer")?.description).toBe("Manage Codex Computer Use and Chrome tools.");
    expect([...pi.handlers.keys()].sort()).toEqual([
      "agent_end",
      "agent_start",
      "resources_discover",
      "session_shutdown",
      "session_start",
    ]);

    const resources = await pi.handlers.get("resources_discover")?.[0]({ type: "resources_discover" }, createCommandContext());
    expect(resources).toEqual({ skillPaths: [expect.stringContaining("/skills")] });

    const completions = await pi.commands.get("codex-computer")?.getArgumentCompletions?.("");
    expect(completions).toEqual([
      { value: "status ", label: "status" },
      { value: "diagnose ", label: "diagnose" },
      { value: "trust ", label: "trust" },
      { value: "enable ", label: "enable" },
      { value: "disable ", label: "disable" },
      { value: "restart ", label: "restart" },
      { value: "hide-status ", label: "hide-status" },
      { value: "show-status ", label: "show-status" },
    ]);
  });

  it("runs the trust probe and clears persisted trust through the trust command", async () => {
    const pi = createFakePi();
    const ctx = createCommandContext();
    ompCodexComputer(pi as never);
    const command = pi.commands.get("codex-computer");

    await command?.handler("trust", ctx);
    expect(trustProbeMock.runChromeTrustProbe).toHaveBeenCalledWith("/tmp/project");
    expect(pi.messages.at(-1)).toEqual({
      customType: "codex-computer",
      content: "Chrome trust probe passed.",
      display: true,
    });

    await command?.handler("trust clear", ctx);
    expect(trustStoreMock.clearPersistedAppServerVersions).toHaveBeenCalledTimes(1);
    expect(pi.messages.at(-1)).toEqual({
      customType: "codex-computer",
      content: "Cleared persisted Chrome app-server trust at /tmp/trusted-app-servers.json.",
      display: true,
    });

    trustStoreMock.clearPersistedAppServerVersions.mockResolvedValueOnce(undefined);
    await command?.handler("trust clear", ctx);
    expect(pi.messages.at(-1)).toEqual({
      customType: "codex-computer",
      content: "No usable HOME or XDG_CONFIG_HOME; no persisted Chrome trust to clear.",
      display: true,
    });
  });

  it("binds Chrome to the agent lifecycle and keeps session cleanup isolated", async () => {
    const pi = createFakePi();
    const ctx = createCommandContext();
    ompCodexComputer(pi as never);
    const computerRuntime = runtimeInstances.at(-1);
    const chromeRuntime = chromeRuntimeInstances.at(-1);

    await pi.handlers.get("session_start")?.[0]({ type: "session_start" }, ctx);
    expect(chromeRuntime?.shutdown).toHaveBeenCalledTimes(1);
    expect(computerRuntime?.setContext).toHaveBeenCalledWith(ctx);
    expect(computerRuntime?.resetSession).toHaveBeenCalledTimes(1);

    await pi.handlers.get("agent_start")?.[0]({ type: "agent_start" }, ctx);
    expect(chromeRuntime?.beginAgent).toHaveBeenCalledWith(ctx);

    // Non-terminal settle: an automatic continuation is already scheduled,
    // so neither runtime is torn down mid-logical-run.
    await pi.handlers.get("agent_end")?.[0]({ type: "agent_end", willContinue: true }, ctx);
    expect(computerRuntime?.shutdown).not.toHaveBeenCalled();
    expect(chromeRuntime?.endAgent).not.toHaveBeenCalled();

    await pi.handlers.get("agent_end")?.[0]({ type: "agent_end" }, ctx);
    expect(computerRuntime?.shutdown).toHaveBeenCalledTimes(1);
    expect(chromeRuntime?.endAgent).toHaveBeenCalledTimes(1);

    await pi.handlers.get("agent_end")?.[0]({ type: "agent_end", willContinue: false }, ctx);
    expect(computerRuntime?.shutdown).toHaveBeenCalledTimes(2);
    expect(chromeRuntime?.endAgent).toHaveBeenCalledTimes(2);

    await pi.handlers.get("session_shutdown")?.[0]({ type: "session_shutdown" }, ctx);
    expect(computerRuntime?.shutdown).toHaveBeenCalledTimes(3);
    expect(chromeRuntime?.shutdown).toHaveBeenCalledTimes(2);
  });

  it("enables and disables only managed Codex automation tools while leaving other tools alone", async () => {
    const pi = createFakePi(["read", "computer_use_click"]);
    const ctx = createCommandContext();
    ompCodexComputer(pi as never);
    const command = pi.commands.get("codex-computer");

    await command?.handler("enable", ctx);
    expect(pi.setActiveToolsCalls[0]).toEqual([
      "read",
      "computer_use_click",
      ...COMPUTER_USE_TOOL_NAMES.filter((name) => name !== "computer_use_click"),
      ...CHROME_TOOL_NAMES,
    ]);

    await command?.handler("disable", ctx);
    expect(pi.setActiveToolsCalls[1]).toEqual(["read"]);
    expect(runtimeInstances.at(-1)?.shutdown).toHaveBeenCalledTimes(1);
    expect(chromeRuntimeInstances.at(-1)?.shutdown).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Codex Computer Use and Chrome tools disabled.", "info");
    expect(pi.messages.at(-1)).toEqual({
      customType: "codex-computer",
      content: "Codex Computer Use and Chrome tools disabled.",
      display: true,
    });
  });

  it("restarts both Codex automation runtimes", async () => {
    const pi = createFakePi();
    const ctx = createCommandContext();
    ompCodexComputer(pi as never);
    const command = pi.commands.get("codex-computer");

    await command?.handler("restart", ctx);

    expect(runtimeInstances.at(-1)?.shutdown).toHaveBeenCalledTimes(1);
    expect(chromeRuntimeInstances.at(-1)?.restart).toHaveBeenCalledTimes(1);
    expect(chromeRuntimeInstances.at(-1)?.shutdown).not.toHaveBeenCalled();
    expect(pi.messages.at(-1)).toEqual({
      customType: "codex-computer",
      content: "Codex automation runtimes restarted. They will reconnect on the next tool call.",
      display: true,
    });
  });

  it("continues session setup when stale Chrome shutdown fails", async () => {
    const pi = createFakePi();
    ompCodexComputer(pi as never);
    const chrome = chromeRuntimeInstances.at(-1);
    const runtime = runtimeInstances.at(-1);
    chrome?.shutdown.mockRejectedValueOnce(new Error("stale cleanup failure"));

    const handler = pi.handlers.get("session_start")?.[0];
    await handler?.({}, createCommandContext());

    expect(runtime?.setContext).toHaveBeenCalledTimes(1);
    expect(runtime?.resetSession).toHaveBeenCalledTimes(1);
  });

  it("hides and shows the footer status through the runtime command handlers", async () => {
    const pi = createFakePi();
    const ctx = createCommandContext();
    ompCodexComputer(pi as never);
    const command = pi.commands.get("codex-computer");
    const runtime = runtimeInstances.at(-1);

    await command?.handler("hide-status", ctx);

    expect(runtime?.setStatusVisible).toHaveBeenNthCalledWith(1, false);
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(
      1,
      "Codex Computer Use footer status hidden. Run /codex-computer show-status to show it again.",
      "info",
    );
    expect(pi.messages.at(-1)).toEqual({
      customType: "codex-computer",
      content: "Codex Computer Use footer status hidden. Run /codex-computer show-status to show it again.",
      display: true,
    });

    await command?.handler("show-status", ctx);

    expect(runtime?.setStatusVisible).toHaveBeenNthCalledWith(2, true);
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(2, "Codex Computer Use footer status shown.", "info");
    expect(pi.messages.at(-1)).toEqual({
      customType: "codex-computer",
      content: "Codex Computer Use footer status shown.",
      display: true,
    });
  });

  it("handles status and diagnose commands with distinct Computer Use and Chrome output", async () => {
    const pi = createFakePi();
    const ctx = createCommandContext();
    ompCodexComputer(pi as never);
    const command = pi.commands.get("codex-computer");

    await command?.handler("status", ctx);
    await command?.handler("diagnose", ctx);

    expect(statusMock.checkComputerUseStatus).toHaveBeenNthCalledWith(1, "/tmp/project");
    expect(statusMock.checkComputerUseStatus).toHaveBeenNthCalledWith(2, "/tmp/project");
    expect(chromeStatusMock.checkChromeStatus).toHaveBeenNthCalledWith(1, "/tmp/project");
    expect(chromeStatusMock.checkChromeStatus).toHaveBeenNthCalledWith(2, "/tmp/project");
    expect(statusMock.formatComputerUseStatus).toHaveBeenCalledTimes(2);
    expect(chromeStatusMock.formatChromeStatus).toHaveBeenCalledTimes(2);
    expect(pi.messages).toEqual([
      {
        customType: "codex-computer",
        content: "Computer Use status: ready\n\nChrome status: ready",
        display: true,
      },
      {
        customType: "codex-computer",
        content: "Computer Use status: ready\n\nChrome status: ready",
        display: true,
      },
    ]);
  });

  it("defaults an empty command to status", async () => {
    const pi = createFakePi();
    const ctx = createCommandContext();
    ompCodexComputer(pi as never);
    const command = pi.commands.get("codex-computer");

    await command?.handler("   ", ctx);

    expect(statusMock.checkComputerUseStatus).toHaveBeenCalledWith("/tmp/project");
    expect(chromeStatusMock.checkChromeStatus).toHaveBeenCalledWith("/tmp/project");
    expect(pi.messages.at(-1)).toEqual({
      customType: "codex-computer",
      content: "Computer Use status: ready\n\nChrome status: ready",
      display: true,
    });
    expect(JSON.stringify(pi.messages.at(-1))).not.toContain("Usage:");
  });
});
