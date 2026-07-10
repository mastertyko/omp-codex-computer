import { isAbsolute } from "node:path";
import type { AppServerClient } from "./app-server-client";
import type { ThreadStartResponse } from "./protocol";

export interface CodexThreadInfo {
  id: string;
  sessionId: string;
}

const COMPUTER_USE_PLUGIN_ID = "computer-use@openai-bundled";

function findComputerUsePluginRoot(response: unknown): string {
  if (!response || typeof response !== "object" || !("marketplaces" in response) || !Array.isArray(response.marketplaces)) {
    throw new Error("Codex returned an invalid plugin list");
  }

  for (const marketplace of response.marketplaces) {
    if (!marketplace || typeof marketplace !== "object" || !("plugins" in marketplace) || !Array.isArray(marketplace.plugins)) continue;

    for (const plugin of marketplace.plugins) {
      if (!plugin || typeof plugin !== "object" || !("id" in plugin) || plugin.id !== COMPUTER_USE_PLUGIN_ID) continue;
      if (!("installed" in plugin) || plugin.installed !== true || !("enabled" in plugin) || plugin.enabled !== true) continue;
      if (!("source" in plugin) || !plugin.source || typeof plugin.source !== "object") continue;
      if (!("type" in plugin.source) || plugin.source.type !== "local" || !("path" in plugin.source)) continue;
      if (typeof plugin.source.path === "string" && isAbsolute(plugin.source.path)) return plugin.source.path;
    }
  }

  throw new Error("Codex Computer Use plugin is not installed and enabled");
}

export class CodexThreadManager {
  private readonly threads = new Map<string, CodexThreadInfo>();
  private readonly startPromises = new Map<string, Promise<CodexThreadInfo>>();
  private generation = 0;
  private pluginRootPromise: Promise<string> | undefined;

  constructor(private readonly client: Pick<AppServerClient, "request">) {}

  reset(): void {
    this.threads.clear();
    this.startPromises.clear();
    this.generation++;
    this.pluginRootPromise = undefined;
  }

  async getThreadId(cwd: string): Promise<string> {
    return (await this.getThread(cwd)).id;
  }

  async getThread(cwd: string): Promise<CodexThreadInfo> {
    const thread = this.threads.get(cwd);
    if (thread) return thread;

    const existingStartPromise = this.startPromises.get(cwd);
    if (existingStartPromise) return existingStartPromise;

    // Codex keeps bundled plugin MCPs disabled globally; enable this one only for the adapter thread.
    const generation = this.generation;
    const startPromise = this.getComputerUsePluginRoot()
      .then((pluginRoot) => this.client.request<ThreadStartResponse>("thread/start", {
        cwd,
        ephemeral: true,
        config: {
          "mcp_servers.computer-use.enabled": true,
          "mcp_servers.computer-use.cwd": pluginRoot,
        },
      }))
      .then((response) => {
        const threadInfo = {
          id: response.thread.id,
          sessionId: response.thread.sessionId,
        };
        if (this.generation === generation && this.startPromises.get(cwd) === startPromise) {
          this.threads.set(cwd, threadInfo);
          this.startPromises.delete(cwd);
        }
        return threadInfo;
      })
      .catch((error: unknown) => {
        if (this.generation === generation && this.startPromises.get(cwd) === startPromise) {
          this.startPromises.delete(cwd);
        }
        throw error;
      });

    this.startPromises.set(cwd, startPromise);
    return startPromise;
  }

  private getComputerUsePluginRoot(): Promise<string> {
    if (this.pluginRootPromise) return this.pluginRootPromise;

    const pluginRootPromise = this.client
      .request<unknown>("plugin/list", {})
      .then(findComputerUsePluginRoot)
      .catch((error: unknown) => {
        if (this.pluginRootPromise === pluginRootPromise) this.pluginRootPromise = undefined;
        throw error;
      });
    this.pluginRootPromise = pluginRootPromise;
    return pluginRootPromise;
  }
}
