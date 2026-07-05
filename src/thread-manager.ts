import type { AppServerClient } from "./app-server-client";
import type { ThreadStartResponse } from "./protocol";

export class CodexThreadManager {
  private threadId: string | undefined;

  constructor(private readonly client: Pick<AppServerClient, "request">) {}

  reset(): void {
    this.threadId = undefined;
  }

  async getThreadId(cwd: string): Promise<string> {
    if (this.threadId) return this.threadId;

    const response = await this.client.request<ThreadStartResponse>("thread/start", {
      cwd,
      ephemeral: true,
    });
    this.threadId = response.thread.id;
    return this.threadId;
  }
}
