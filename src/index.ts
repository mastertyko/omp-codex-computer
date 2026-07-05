import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { inspectChromeBridgeStatus, type ChromeBridgeStatus } from "./chrome-status";
import { CHROME_TOOL_NAMES, registerChromeTools } from "./chrome-tools";
import { COMPUTER_USE_TOOL_NAMES, registerComputerUseTools } from "./computer-use-tools";
import { ComputerUseRuntime } from "./runtime";
import { checkComputerUseStatus, formatComputerUseStatus } from "./status";

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));
const COMMAND_NAME = "codex-computer";
const COMMANDS = ["status", "diagnose", "enable", "disable", "restart"] as const;

export default function ompCodexComputer(pi: ExtensionAPI): void {
  const runtime = new ComputerUseRuntime();
  let toolsEnabled = true;

  registerComputerUseTools(pi, runtime);
  registerChromeTools(pi, runtime);

  pi.on("resources_discover", () => ({ skillPaths: [SKILLS_DIR] }));

  pi.on("session_start", async (_event, ctx) => {
    runtime.setContext(ctx);
    runtime.resetSession();
    await setComputerUseToolsEnabled(pi, toolsEnabled);
  });

  pi.on("agent_end", async () => {
    await runtime.shutdown();
  });

  pi.on("session_shutdown", async () => {
    await runtime.shutdown();
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

      if (command === "status") {
        const status = await checkComputerUseStatus(ctx.cwd);
        sendCommandMessage(pi, ctx, formatComputerUseStatus(status));
        return;
      }

      if (command === "diagnose") {
        const status = await checkComputerUseStatus(ctx.cwd);
        const chromeStatus = await inspectChromeBridgeStatus();
        sendCommandMessage(pi, ctx, `${formatComputerUseStatus(status)}\n\n${formatChromeBridgeStatus(chromeStatus)}`);
        return;
      }

      if (command === "enable") {
        toolsEnabled = true;
        await setComputerUseToolsEnabled(pi, true);
        sendCommandMessage(pi, ctx, "Codex Computer Use and Chrome tools enabled.");
        return;
      }

      if (command === "disable") {
        toolsEnabled = false;
        await setComputerUseToolsEnabled(pi, false);
        await runtime.shutdown();
        sendCommandMessage(pi, ctx, "Codex Computer Use and Chrome tools disabled.");
        return;
      }

      if (command === "restart") {
        await runtime.shutdown();
        sendCommandMessage(pi, ctx, "Codex Computer Use and Chrome runtime restarted. It will reconnect on the next tool call.");
        return;
      }

      sendCommandMessage(pi, ctx, `Usage: /${COMMAND_NAME} ${COMMANDS.join("|")}`);
    },
  });
}

export async function setComputerUseToolsEnabled(pi: ExtensionAPI, enabled: boolean): Promise<void> {
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

function formatChromeBridgeStatus(status: ChromeBridgeStatus): string {
  const lines = [
    `Chrome bridge: ${status.reason}`,
    `Chrome bridge files: ${status.available ? "available" : "missing"}`,
    `Chrome bridge root: ${status.root}`,
  ];

  if (status.missing.length > 0) lines.push(`Missing files: ${status.missing.join(", ")}`);

  return lines.join("\n");
}

function sameToolNames(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((name, index) => right[index] === name);
}
