import type { AppServerClient } from "./app-server-client";
import type { ThreadStartResponse } from "./protocol";

export class CodexThreadManager {
  private readonly threadIds = new Map<string, string>();
  private readonly startPromises = new Map<string, Promise<string>>();
  private generation = 0;

  constructor(private readonly client: Pick<AppServerClient, "request">) {}

  reset(): void {
    this.threadIds.clear();
    this.startPromises.clear();
    this.generation++;
  }

  async getThreadId(cwd: string): Promise<string> {
    const threadId = this.threadIds.get(cwd);
    if (threadId) return threadId;

    const existingStartPromise = this.startPromises.get(cwd);
    if (existingStartPromise) return existingStartPromise;

    const generation = this.generation;
    const startPromise = this.client
      .request<ThreadStartResponse>("thread/start", {
        cwd,
        ephemeral: true,
      })
      .then((response) => {
        if (this.generation === generation && this.startPromises.get(cwd) === startPromise) {
          this.threadIds.set(cwd, response.thread.id);
          this.startPromises.delete(cwd);
        }
        return response.thread.id;
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
}
