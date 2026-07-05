import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logDebug, redactForLog } from "../src/log";

const LOG_PREFIX = "[omp-codex-computer] ";

let originalDebug: string | undefined;
let originalLog: string | undefined;

beforeEach(() => {
  originalDebug = process.env.OMP_CODEX_COMPUTER_DEBUG;
  originalLog = process.env.OMP_CODEX_COMPUTER_LOG;
  delete process.env.OMP_CODEX_COMPUTER_DEBUG;
  delete process.env.OMP_CODEX_COMPUTER_LOG;
});

afterEach(() => {
  vi.restoreAllMocks();

  if (originalDebug === undefined) {
    delete process.env.OMP_CODEX_COMPUTER_DEBUG;
  } else {
    process.env.OMP_CODEX_COMPUTER_DEBUG = originalDebug;
  }

  if (originalLog === undefined) {
    delete process.env.OMP_CODEX_COMPUTER_LOG;
  } else {
    process.env.OMP_CODEX_COMPUTER_LOG = originalLog;
  }
});

function spyOnStderr(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return writes;
}

async function readLogLine(path: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const text = await readFile(path, "utf8");
      const line = text.trim();
      if (line) return line;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw lastError ?? new Error("Log file was not written");
}

function expectRedactedLogEntry(entry: Record<string, unknown>): void {
  expect(entry.event).toBe("debug-event");
  expect(entry.timestamp).toEqual(expect.any(String));
  expect(entry.data).toEqual({
    app: "TextEdit",
    token: "[redacted]",
    nested: {
      message: "visible",
      screenshot: "[redacted]",
    },
  });
}

function expectObject(value: unknown): Record<string, unknown> {
  expect(value).toEqual(expect.any(Object));
  return value as Record<string, unknown>;
}

function expectIsoTimestamp(value: unknown): void {
  expect(value).toEqual(expect.any(String));
  expect(Number.isNaN(Date.parse(value as string))).toBe(false);
}

describe("redactForLog", () => {
  it("redacts sensitive keys recursively", () => {
    const result = redactForLog({
      token: "abc",
      app: "TextEdit",
      nested: {
        screenshot: "base64",
        message: "visible",
      },
      content: [{ text: "accessibility tree" }],
    });

    expect(result).toEqual({
      token: "[redacted]",
      app: "TextEdit",
      nested: {
        screenshot: "[redacted]",
        message: "visible",
      },
      content: "[redacted]",
    });
  });

  it("redacts common credential and auth fields", () => {
    const result = redactForLog({
      apiKey: "sk-secret",
      sessionId: "session-secret",
      credential: "credential-secret",
      authHeader: "Bearer auth-secret",
      authorization: "Bearer authorization-secret",
      headers: {
        cookie: "sid=cookie-secret",
        accept: "application/json",
      },
    });

    expect(result).toEqual({
      apiKey: "[redacted]",
      sessionId: "[redacted]",
      credential: "[redacted]",
      authHeader: "[redacted]",
      authorization: "[redacted]",
      headers: "[redacted]",
    });
  });

  it("redacts broad user data container fields", () => {
    const result = redactForLog({
      payload: { userText: "private" },
      params: { query: "private" },
      arguments: { prompt: "private" },
      body: { message: "private" },
      metadata: "visible",
    });

    expect(result).toEqual({
      payload: "[redacted]",
      params: "[redacted]",
      arguments: "[redacted]",
      body: "[redacted]",
      metadata: "visible",
    });
  });
});

describe("logDebug", () => {
  it("does not write to stderr when debug and log env vars are unset", () => {
    const writes = spyOnStderr();

    logDebug("debug-event", { app: "TextEdit" });

    expect(writes).toEqual([]);
  });

  it("writes one prefixed JSON log line to stderr when debug is enabled", () => {
    process.env.OMP_CODEX_COMPUTER_DEBUG = "1";
    const writes = spyOnStderr();

    logDebug("debug-event", {
      app: "TextEdit",
      token: "secret",
      nested: {
        message: "visible",
        screenshot: "base64",
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.startsWith(LOG_PREFIX)).toBe(true);
    const entry = JSON.parse(writes[0]!.slice(LOG_PREFIX.length).trim()) as Record<string, unknown>;
    expectRedactedLogEntry(entry);
  });

  it("keeps log metadata separate from user data", () => {
    process.env.OMP_CODEX_COMPUTER_DEBUG = "1";
    const writes = spyOnStderr();

    logDebug("real-event", { event: "fake", timestamp: "fake" });

    expect(writes).toHaveLength(1);
    const entry = JSON.parse(writes[0]!.slice(LOG_PREFIX.length).trim()) as Record<string, unknown>;
    expect(entry.event).toBe("real-event");
    expectIsoTimestamp(entry.timestamp);
    expect(expectObject(entry.data).event).toBe("fake");
    expect(expectObject(entry.data).timestamp).toBe("fake");
  });

  it("appends one redacted JSON log line to the configured log file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "omp-codex-computer-log-"));
    const logPath = join(tempDir, "debug.log");
    process.env.OMP_CODEX_COMPUTER_LOG = logPath;

    try {
      logDebug("debug-event", {
        app: "TextEdit",
        token: "secret",
        nested: {
          message: "visible",
          screenshot: "base64",
        },
      });

      const line = await readLogLine(logPath);
      const entry = JSON.parse(line) as Record<string, unknown>;
      expectRedactedLogEntry(entry);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
