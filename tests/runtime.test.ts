import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerRequestResponder } from "../src/app-server-client";
import type { AppServerRequest } from "../src/protocol";
import { ComputerUseRuntime, shouldDevAutoAccept } from "../src/runtime";

const originalDevAutoAcceptApps = process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS;

class FakeResponder implements ServerRequestResponder {
  accepted: unknown[] = [];
  rejected: Array<{ code: number; message: string; data?: unknown }> = [];

  accept(result: unknown): void {
    this.accepted.push(result);
  }

  reject(error: { code: number; message: string; data?: unknown }): void {
    this.rejected.push(error);
  }
}

function permissionRequest(message: string): AppServerRequest {
  return {
    id: "permission",
    method: "mcpServer/elicitation/request",
    params: { message, serverName: "computer-use" },
  };
}

describe("shouldDevAutoAccept", () => {
  afterEach(() => {
    if (originalDevAutoAcceptApps === undefined) {
      delete process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS;
    } else {
      process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS = originalDevAutoAcceptApps;
    }
  });

  it("accepts only exact allowlisted app names from permission messages", () => {
    process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS = "Calculator, TextEdit";

    expect(shouldDevAutoAccept("Allow Codex to use Calculator?")).toBe(true);
    expect(shouldDevAutoAccept("Allow Codex to use Safari?")).toBe(false);
    expect(shouldDevAutoAccept("Allow Codex to use Calculator Pro?")).toBe(false);
    expect(shouldDevAutoAccept("Codex requests access to Calculator")).toBe(false);
  });
});

describe("ComputerUseRuntime server requests", () => {
  afterEach(() => {
    if (originalDevAutoAcceptApps === undefined) {
      delete process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS;
    } else {
      process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS = originalDevAutoAcceptApps;
    }
  });

  it("declines elicitation requests when no UI is available", async () => {
    const runtime = new ComputerUseRuntime();
    const responder = new FakeResponder();

    await runtime.handleServerRequestForTest(permissionRequest("Allow Codex to use Finder?"), responder);

    expect(responder.accepted).toEqual([{ action: "decline", content: null }]);
    expect(responder.rejected).toEqual([]);
  });

  it("accepts elicitation requests when UI confirmation approves", async () => {
    const confirm = vi.fn(async () => true);
    const runtime = new ComputerUseRuntime();
    runtime.setContext({
      cwd: "/tmp/project",
      hasUI: true,
      ui: {
        confirm,
        setStatus: () => undefined,
      },
    } as never as ExtensionContext);
    const responder = new FakeResponder();

    await runtime.handleServerRequestForTest(permissionRequest("Allow Codex to use TextEdit?"), responder);

    expect(confirm).toHaveBeenCalledWith(
      "Codex Computer Use permission",
      "Allow Codex to use TextEdit?",
      undefined,
    );
    expect(responder.accepted).toEqual([{ action: "accept", content: {} }]);
    expect(responder.rejected).toEqual([]);
  });
});
