import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/app-server-client";

function attachFakeProcess(client: AppServerClient) {
  const writes: string[] = [];
  (client as unknown as { process: unknown }).process = {
    exitCode: null,
    stdin: {
      write(chunk: string, cb?: (error?: Error | null) => void) {
        writes.push(chunk);
        cb?.(null);
        return true;
      },
    },
  };
  return writes;
}

function deliver(client: AppServerClient, message: unknown) {
  (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify(message));
}

describe("AppServerClient", () => {
  it("routes concurrent responses by id", async () => {
    const client = new AppServerClient();
    attachFakeProcess(client);

    const first = client.request("first", {}, 1000);
    const second = client.request("second", {}, 1000);

    deliver(client, { id: 2, result: "two" });
    deliver(client, { id: 1, result: "one" });

    await expect(first).resolves.toBe("one");
    await expect(second).resolves.toBe("two");
  });

  it("rejects JSON-RPC errors", async () => {
    const client = new AppServerClient();
    attachFakeProcess(client);

    const request = client.request("boom", {}, 1000);
    deliver(client, { id: 1, error: { code: -1, message: "failed" } });

    await expect(request).rejects.toThrow("failed");
  });

  it("times out unanswered requests", async () => {
    const client = new AppServerClient();
    attachFakeProcess(client);

    await expect(client.request("slow", {}, 5)).rejects.toThrow("Timed out");
  });

  it("ignores malformed JSON", () => {
    const client = new AppServerClient();
    attachFakeProcess(client);

    expect(() => (client as unknown as { handleLine(line: string): void }).handleLine("not json")).not.toThrow();
  });

  it("handles app-server requests through registered handler", async () => {
    const client = new AppServerClient();
    const writes = attachFakeProcess(client);
    client.onServerRequest((request, responder) => {
      expect(request.method).toBe("mcpServer/elicitation/request");
      responder.accept({ action: "accept", content: {} });
    });

    deliver(client, { id: "abc", method: "mcpServer/elicitation/request", params: { message: "Allow?" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writes.at(-1)).toBe(`${JSON.stringify({ id: "abc", result: { action: "accept", content: {} } })}\n`);
  });

  it("rejects app-server requests when no handler is registered", async () => {
    const client = new AppServerClient();
    const writes = attachFakeProcess(client);

    deliver(client, { id: "abc", method: "unknown/request", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = JSON.parse(writes.at(-1) ?? "{}");
    expect(response.id).toBe("abc");
    expect(response.error.message).toContain("No handler");
  });
});
