import type { AppServerClient } from "./app-server-client";
import type { ThreadStartResponse } from "./protocol";

export interface CodexThreadInfo {
  id: string;
  sessionId: string;
}

export class CodexThreadManager {
  private readonly threads = new Map<string, CodexThreadInfo>();
  private readonly startPromises = new Map<string, Promise<CodexThreadInfo>>();
  private generation = 0;

  constructor(private readonly client: Pick<AppServerClient, "request">) {}

  reset(): void {
    this.threads.clear();
    this.startPromises.clear();
    this.generation++;
  }

  async getThreadId(cwd: string): Promise<string> {
    return (await this.getThread(cwd)).id;
  }

  async getThread(cwd: string): Promise<CodexThreadInfo> {
    const thread = this.threads.get(cwd);
    if (thread) return thread;

    const existingStartPromise = this.startPromises.get(cwd);
    if (existingStartPromise) return existingStartPromise;

    const generation = this.generation;
    const startPromise = this.client
      .request<ThreadStartResponse>("thread/start", {
        cwd,
        ephemeral: true,
      })
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
}
