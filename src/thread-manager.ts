import type { AppServerClient } from "./app-server-client";
import type { ThreadStartResponse } from "./protocol";

export class CodexThreadManager {
  private threadId: string | undefined;
  private threadCwd: string | undefined;
  private startPromise: Promise<string> | undefined;
  private startCwd: string | undefined;
  private generation = 0;

  constructor(private readonly client: Pick<AppServerClient, "request">) {}

  reset(): void {
    this.threadId = undefined;
    this.threadCwd = undefined;
    this.startPromise = undefined;
    this.startCwd = undefined;
    this.generation++;
  }

  async getThreadId(cwd: string): Promise<string> {
    if (this.threadId && this.threadCwd === cwd) return this.threadId;
    if (this.startPromise && this.startCwd === cwd) return this.startPromise;

    const generation = this.generation;
    const startPromise = this.client
      .request<ThreadStartResponse>("thread/start", {
        cwd,
        ephemeral: true,
      })
      .then((response) => {
        if (this.generation === generation && this.startPromise === startPromise) {
          this.threadId = response.thread.id;
          this.threadCwd = cwd;
          this.startPromise = undefined;
          this.startCwd = undefined;
        }
        return response.thread.id;
      })
      .catch((error: unknown) => {
        if (this.generation === generation && this.startPromise === startPromise) {
          this.startPromise = undefined;
          this.startCwd = undefined;
        }
        throw error;
      });

    this.startPromise = startPromise;
    this.startCwd = cwd;
    return this.startPromise;
  }
}
