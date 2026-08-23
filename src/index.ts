import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { CHROME_TOOL_NAMES, registerChromeTools } from "./chrome-tools";
import { ChromeRuntime } from "./chrome-runtime";
import { checkChromeStatus, formatChromeStatus } from "./chrome-status";
import { COMPUTER_USE_TOOL_NAMES, registerComputerUseTools } from "./computer-use-tools";
import { ComputerUseRuntime } from "./runtime";
import { checkComputerUseStatus, formatComputerUseStatus } from "./status";

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));
const COMMAND_NAME = "codex-computer";
const COMMANDS = ["status", "diagnose", "enable", "disable", "restart", "hide-status", "show-status"] as const;

export default function ompCodexComputer(pi: ExtensionAPI): void {
  const computerRuntime = new ComputerUseRuntime();
  const chromeRuntime = new ChromeRuntime();
  let toolsEnabled = true;

  registerComputerUseTools(pi, computerRuntime);
  registerChromeTools(pi, chromeRuntime);

  pi.on("resources_discover", () => ({ skillPaths: [SKILLS_DIR] }));

  pi.on("session_start", async (_event, ctx) => {
    await chromeRuntime.shutdown();
    computerRuntime.setContext(ctx);
    computerRuntime.resetSession();
    await setCodexAutomationToolsEnabled(pi, toolsEnabled);
  });

  pi.on("agent_start", async (_event, ctx) => {
    await chromeRuntime.beginAgent(ctx);
  });

  pi.on("agent_end", async (event) => {
    // A non-terminal settle: OMP has already scheduled an automatic
    // continuation (auto-retry, todo/plan continuation, ...) whose
    // agent_start races -- and can precede -- this event. The logical run
    // keeps going, so both runtimes stay alive until the terminal settle.
    // Read structurally: `willContinue` ships in newer OMP releases than
    // this package's minimum peer version.
    if ("willContinue" in event && event.willContinue === true) return;
    await Promise.all([computerRuntime.shutdown(), chromeRuntime.endAgent()]);
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([computerRuntime.shutdown(), chromeRuntime.shutdown()]);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Manage Codex Computer Use and Chrome tools.",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trimStart();
      return COMMANDS
        .filter((command) => command.startsWith(prefix))
        .map((command) => ({ value: `${command} `, label: command }));
    },
    async handler(args, ctx) {
      const command = args.trim().split(/\s+/, 1)[0] || "status";

      if (command === "status" || command === "diagnose") {
        const [computerStatus, chromeStatus] = await Promise.all([
          checkComputerUseStatus(ctx.cwd),
          checkChromeStatus(ctx.cwd),
        ]);
        sendCommandMessage(
          pi,
          ctx,
          `${formatComputerUseStatus(computerStatus)}\n\n${formatChromeStatus(chromeStatus)}`,
        );
        return;
      }

      if (command === "enable") {
        toolsEnabled = true;
        await setCodexAutomationToolsEnabled(pi, true);
        sendCommandMessage(pi, ctx, "Codex Computer Use and Chrome tools enabled.");
        return;
      }

      if (command === "disable") {
        toolsEnabled = false;
        await setCodexAutomationToolsEnabled(pi, false);
        await Promise.all([computerRuntime.shutdown(), chromeRuntime.shutdown()]);
        sendCommandMessage(pi, ctx, "Codex Computer Use and Chrome tools disabled.");
        return;
      }

      if (command === "restart") {
        await Promise.all([computerRuntime.shutdown(), chromeRuntime.shutdown()]);
        sendCommandMessage(pi, ctx, "Codex automation runtimes restarted. They will reconnect on the next tool call.");
        return;
      }

      if (command === "hide-status") {
        computerRuntime.setStatusVisible(false);
        sendCommandMessage(pi, ctx, "Codex Computer Use footer status hidden. Run /codex-computer show-status to show it again.");
        return;
      }

      if (command === "show-status") {
        computerRuntime.setStatusVisible(true);
        sendCommandMessage(pi, ctx, "Codex Computer Use footer status shown.");
        return;
      }

      sendCommandMessage(pi, ctx, `Usage: /${COMMAND_NAME} ${COMMANDS.join("|")}`);
    },
  });
}

export async function setCodexAutomationToolsEnabled(pi: ExtensionAPI, enabled: boolean): Promise<void> {
  const active = new Set(pi.getActiveTools());
  const before = [...active];
  const managedToolNames = [...COMPUTER_USE_TOOL_NAMES, ...CHROME_TOOL_NAMES];

  if (enabled) {
    for (const toolName of managedToolNames) active.add(toolName);
  } else {
    for (const toolName of managedToolNames) active.delete(toolName);
  }

  const after = [...active];
  if (sameToolNames(before, after)) return;

  await pi.setActiveTools(after);
}

function sendCommandMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext, content: string): void {
  if (ctx.hasUI) ctx.ui.notify(content, "info");
  pi.sendMessage({
    customType: "codex-computer",
    content,
    display: true,
  });
}


function sameToolNames(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((name, index) => right[index] === name);
}
