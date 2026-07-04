# OMP Codex Computer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local OMP extension that exposes Codex Computer Use as OMP-native tools through Codex app-server, with Chrome support limited to read-only discovery/status groundwork.

**Architecture:** The extension lazy-starts `codex app-server --listen stdio://`, initializes the experimental app-server API, creates one ephemeral Codex thread, and calls the bundled `computer-use` MCP server through `mcpServer/tool/call`. OMP tools and commands sit on top of a small runtime layer that handles permission prompts, shutdown, redacted logging, status reporting, and serialized desktop actions.

**Tech Stack:** TypeScript ESM, Bun, Vitest, OMP ExtensionAPI from `@oh-my-pi/pi-coding-agent`, Codex CLI app-server JSONL protocol.

---

## File Structure

- Create `package.json`: package metadata, OMP manifest, scripts, peer/dev dependencies.
- Create `tsconfig.json`: strict TypeScript config for Bun/NodeNext-style ESM.
- Create `README.md`: local development, OMP linking, safety notes, commands.
- Create `skills/codex-computer/SKILL.md`: model-facing Computer Use loop instructions.
- Create `src/protocol.ts`: narrow app-server and MCP response types.
- Create `src/app-server-client.ts`: JSONL app-server process client and server-request bridge.
- Create `src/queue.ts`: serial promise queue for desktop actions.
- Create `src/content.ts`: Codex MCP content to OMP tool content conversion.
- Create `src/log.ts`: opt-in redacted debug logging.
- Create `src/thread-manager.ts`: ephemeral Codex thread cache/reset logic.
- Create `src/computer-use-backend.ts`: queued `mcpServer/tool/call` adapter and stale-thread retry.
- Create `src/status.ts`: Codex/Computer Use readiness evaluation and formatting.
- Create `src/runtime.ts`: lazy lifecycle, permission elicitation, idle shutdown.
- Create `src/computer-use-tools.ts`: OMP tool registration using `pi.zod`.
- Create `src/index.ts`: extension entry, commands, resource discovery, lifecycle hooks.
- Create `src/chrome-status.ts`: read-only Chrome/browser plugin file discovery.
- Create `tests/*.test.ts`: focused unit tests for each behavior before implementation.

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `README.md`
- Create: `skills/codex-computer/SKILL.md`
- Test: package scripts only

- [ ] **Step 1: Create package metadata**

Create `package.json` with:

```json
{
  "name": "omp-codex-computer",
  "version": "0.1.0",
  "description": "OMP extension for using OpenAI Codex Computer Use through Codex app-server",
  "type": "module",
  "main": "./src/index.ts",
  "files": [
    "src",
    "skills",
    "README.md"
  ],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "check": "bun run typecheck && bun run test"
  },
  "keywords": [
    "omp",
    "oh-my-pi",
    "codex",
    "computer-use"
  ],
  "license": "MIT",
  "peerDependencies": {
    "@oh-my-pi/pi-coding-agent": ">=16.3.6"
  },
  "devDependencies": {
    "@oh-my-pi/pi-coding-agent": "file:/Volumes/ExtraDisk/Dev/oh-my-pi/packages/coding-agent",
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^4.0.0"
  },
  "omp": {
    "extensions": [
      "./src/index.ts"
    ],
    "skills": [
      "./skills"
    ]
  },
  "engines": {
    "bun": ">=1.3.0",
    "node": ">=22.0.0"
  }
}
```

- [ ] **Step 2: Create TypeScript config**

Create `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": [
      "node",
      "vitest"
    ],
    "noEmit": true
  },
  "include": [
    "src/**/*.ts",
    "tests/**/*.ts"
  ]
}
```

- [ ] **Step 3: Create README**

Create `README.md` with:

````markdown
# omp-codex-computer

Local OMP extension that exposes OpenAI Codex Computer Use through `codex app-server`.

## Requirements

- macOS
- Codex CLI on `PATH` as `codex`
- Codex.app installed
- OMP installed
- Accessibility and Screen Recording permissions granted when Codex Computer Use asks

## Local Development

```bash
bun install
bun run check
omp-dev -e /Volumes/ExtraDisk/Dev/omp-codex-computer
```

Inside OMP:

```text
/codex-computer status
```

## Commands

- `/codex-computer status`
- `/codex-computer diagnose`
- `/codex-computer enable`
- `/codex-computer disable`
- `/codex-computer restart`

## Safety

The extension does not automate the desktop directly. It calls Codex app-server, which owns the bundled Computer Use plugin lifecycle and permission flow. Permission requests fail closed when OMP has no UI available.
````

- [ ] **Step 4: Create model skill**

Create `skills/codex-computer/SKILL.md` with:

```markdown
---
name: codex-computer
description: Use Codex Computer Use tools safely for local macOS app inspection and interaction.
---

# Codex Computer Use

Use these tools when the user asks you to inspect or operate a local macOS app:

1. Call `computer_use_get_app_state` before acting in an app.
2. Prefer element indexes over raw coordinates.
3. After every click, type, keypress, scroll, drag, or value change, call `computer_use_get_app_state` again to verify the result.
4. Ask the user before sending messages, submitting forms, deleting data, making purchases, changing account/security settings, or transmitting sensitive information.
5. If a permission prompt is declined, stop the desktop task and explain what is needed.
```

- [ ] **Step 5: Install dependencies**

Run:

```bash
bun install
```

Expected: dependencies install and `bun.lock` is created.

- [ ] **Step 6: Run empty project checks**

Run:

```bash
bun run typecheck
bun run test
```

Expected: `typecheck` may fail because no `src/index.ts` exists yet. `test` should report no test files or pass with zero tests, depending on Vitest version. Continue to Task 2.

- [ ] **Step 7: Commit scaffold**

Run:

```bash
git add package.json tsconfig.json README.md skills/codex-computer/SKILL.md bun.lock
git commit -m "chore: scaffold OMP Codex Computer extension"
```

Expected: commit succeeds.

---

### Task 2: Protocol Types and App-Server Client

**Files:**
- Create: `src/protocol.ts`
- Create: `src/app-server-client.ts`
- Test: `tests/app-server-client.test.ts`

- [ ] **Step 1: Write the failing app-server client tests**

Create `tests/app-server-client.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/app-server-client.ts";

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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun run test tests/app-server-client.test.ts
```

Expected: FAIL because `src/app-server-client.ts` does not exist.

- [ ] **Step 3: Create protocol types**

Create `src/protocol.ts` with:

```ts
export type JsonObject = Record<string, unknown>;
export type RequestId = number | string;

export interface AppServerRequest<TParams = unknown> {
  id: RequestId;
  method: string;
  params?: TParams;
}

export interface AppServerResponse<TResult = unknown> {
  id: RequestId;
  result?: TResult;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface AppServerNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface PluginListResponse {
  marketplaces: PluginMarketplaceEntry[];
  marketplaceLoadErrors?: Array<{ marketplacePath: string; message: string }>;
  featuredPluginIds?: string[];
}

export interface PluginMarketplaceEntry {
  name: string;
  path?: string | null;
  plugins: PluginSummary[];
}

export interface PluginSummary {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  installPolicy: string;
  authPolicy: string;
  availability?: string;
  localVersion?: string | null;
  source?: unknown;
  interface?: {
    displayName?: string | null;
    shortDescription?: string | null;
  } | null;
}

export interface McpServerStatusListResponse {
  data: McpServerStatus[];
  nextCursor?: string | null;
}

export interface McpServerStatus {
  name: string;
  authStatus: string;
  tools: Record<string, McpTool>;
  resources: unknown[];
  resourceTemplates: unknown[];
}

export interface McpTool {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface ThreadStartResponse {
  thread: {
    id: string;
    sessionId: string;
    status: unknown;
    cwd: string;
    ephemeral: boolean;
  };
  model: string;
  modelProvider: string;
}
```

- [ ] **Step 4: Create app-server client**

Create `src/app-server-client.ts` with:

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { logDebug } from "./log.ts";
import type { AppServerNotification, AppServerRequest, AppServerResponse, RequestId } from "./protocol.ts";

export interface AppServerClientOptions {
  codexCommand?: string;
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ServerRequestResponder {
  accept(result: unknown): void;
  reject(error: { code: number; message: string; data?: unknown }): void;
}

export type ServerRequestHandler = (
  request: AppServerRequest,
  responder: ServerRequestResponder,
) => void | Promise<void>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class AppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private stdout: ReadlineInterface | undefined;
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private serverRequestHandler: ServerRequestHandler | undefined;

  constructor(private readonly options: AppServerClientOptions = {}) {}

  start(): void {
    if (this.process) return;

    const codex = this.options.codexCommand ?? "codex";
    logDebug("app-server.spawn", { codex });
    const child = spawn(codex, ["app-server", "--listen", "stdio://"], {
      stdio: "pipe",
      env: { ...process.env, ...this.options.env },
    });

    this.process = child;
    this.stdout = createInterface({ input: child.stdout });
    this.stdout.on("line", (line) => this.handleLine(line));

    child.stderr.on("data", (chunk) => {
      if (process.env.OMP_CODEX_COMPUTER_DEBUG === "1") {
        process.stderr.write(`[codex-app-server] ${String(chunk)}`);
      }
    });

    child.on("error", (error) => {
      logDebug("app-server.error", { message: error.message });
      this.rejectAll(error);
    });
    child.on("exit", (code, signal) => {
      logDebug("app-server.exit", { code, signal });
      this.rejectAll(new Error(`Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
      this.process = undefined;
      this.stdout?.close();
      this.stdout = undefined;
    });
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    this.stdout?.close();
    this.stdout = undefined;

    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        done();
      });
      child.kill("SIGTERM");
    });
  }

  isRunning(): boolean {
    return !!this.process && this.process.exitCode === null;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<TResult> {
    this.start();

    const child = this.process;
    if (!child) throw new Error("Codex app-server process is not running");

    const id = this.nextId++;
    const message: AppServerRequest = params === undefined ? { id, method } : { id, method, params };

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server response to ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });

      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      if (process.env.OMP_CODEX_COMPUTER_DEBUG === "1") {
        process.stderr.write(`[codex-app-server:invalid-json] ${line}\n`);
      }
      return;
    }

    if (!message || typeof message !== "object") return;
    const object = message as Record<string, unknown>;

    if ("id" in object && typeof object.method === "string") {
      void this.handleServerRequest(object as unknown as AppServerRequest);
      return;
    }

    if ("id" in object) {
      this.handleResponse(object as unknown as AppServerResponse);
      return;
    }

    if (typeof object.method === "string") {
      const notification = object as unknown as AppServerNotification;
      logDebug("app-server.notification", { method: notification.method });
    }
  }

  private handleResponse(response: AppServerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }

  private async handleServerRequest(request: AppServerRequest): Promise<void> {
    const handler = this.serverRequestHandler;
    if (!handler) {
      this.sendServerRequestError(request.id, { code: -32601, message: `No handler for server request ${request.method}` });
      return;
    }

    try {
      await handler(request, {
        accept: (result) => this.sendServerRequestResult(request.id, result),
        reject: (error) => this.sendServerRequestError(request.id, error),
      });
    } catch (error) {
      this.sendServerRequestError(request.id, {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sendServerRequestResult(id: RequestId, result: unknown): void {
    this.process?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private sendServerRequestError(id: RequestId, error: { code: number; message: string; data?: unknown }): void {
    this.process?.stdin.write(`${JSON.stringify({ id, error })}\n`);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
```

- [ ] **Step 5: Add temporary log module for imports**

Create `src/log.ts` with:

```ts
export function logDebug(_event: string, _data: Record<string, unknown> = {}): void {}
```

- [ ] **Step 6: Run focused test and verify GREEN**

Run:

```bash
bun run test tests/app-server-client.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit app-server client**

Run:

```bash
git add src/protocol.ts src/app-server-client.ts src/log.ts tests/app-server-client.test.ts
git commit -m "feat: add Codex app-server client"
```

Expected: commit succeeds.

---

### Task 3: Content Conversion, Queue, and Redacted Logging

**Files:**
- Create or modify: `src/content.ts`
- Create: `src/queue.ts`
- Modify: `src/log.ts`
- Test: `tests/content.test.ts`
- Test: `tests/queue.test.ts`
- Test: `tests/log.test.ts`

- [ ] **Step 1: Write failing content tests**

Create `tests/content.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { convertCodexContentToOmpContent } from "../src/content.ts";

describe("convertCodexContentToOmpContent", () => {
  it("converts text and image blocks", () => {
    const result = convertCodexContentToOmpContent([
      { type: "text", text: "hello" },
      { type: "image", data: "abc123" },
    ]);

    expect(result).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "abc123", mimeType: "image/jpeg" },
    ]);
  });

  it("truncates long text with an explicit marker", () => {
    const result = convertCodexContentToOmpContent([{ type: "text", text: "a\nb\nc" }], { maxLines: 2, maxBytes: 1000 });
    expect(result[0]).toMatchObject({ type: "text" });
    if (result[0]?.type === "text") {
      expect(result[0].text).toContain("Output truncated");
      expect(result[0].text).not.toContain("\nc");
    }
  });

  it("stringifies unknown content", () => {
    const result = convertCodexContentToOmpContent({ ok: true });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("text");
  });
});
```

- [ ] **Step 2: Write failing queue tests**

Create `tests/queue.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/queue.ts";

describe("SerialQueue", () => {
  it("runs tasks sequentially", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];

    const first = queue.enqueue(async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("first:end");
      return 1;
    });

    const second = queue.enqueue(async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("continues after a failed task", async () => {
    const queue = new SerialQueue();

    await expect(queue.enqueue(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await expect(queue.enqueue(async () => "ok")).resolves.toBe("ok");
  });
});
```

- [ ] **Step 3: Write failing log tests**

Create `tests/log.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { redactForLog } from "../src/log.ts";

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
});
```

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```bash
bun run test tests/content.test.ts tests/queue.test.ts tests/log.test.ts
```

Expected: FAIL because `src/content.ts`, `src/queue.ts`, and `redactForLog` do not exist.

- [ ] **Step 5: Implement content conversion**

Create `src/content.ts` with:

```ts
export type OmpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface CodexContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  mime_type?: string;
  [key: string]: unknown;
}

export interface ContentConversionOptions {
  maxBytes?: number;
  maxLines?: number;
}

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 3000;

export function convertCodexContentToOmpContent(
  content: unknown,
  options: ContentConversionOptions = {},
): OmpContentBlock[] {
  if (!Array.isArray(content)) {
    return [{ type: "text", text: stringifyUnknownContent(content, options) }];
  }

  const blocks: OmpContentBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") {
      blocks.push({ type: "text", text: String(raw) });
      continue;
    }

    const block = raw as CodexContentBlock;
    if (block.type === "text") {
      blocks.push({ type: "text", text: truncateText(block.text ?? "", options) });
      continue;
    }

    if (block.type === "image" && typeof block.data === "string") {
      blocks.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType ?? block.mime_type ?? "image/jpeg",
      });
      continue;
    }

    blocks.push({ type: "text", text: truncateText(JSON.stringify(block, null, 2), options) });
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "(no content)" }];
}

function truncateText(text: string, options: ContentConversionOptions): string {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const lines = text.split("\n");
  let output = lines.slice(0, maxLines).join("\n");

  while (Buffer.byteLength(output, "utf8") > maxBytes && output.length > 0) {
    output = output.slice(0, Math.max(0, output.length - 256));
  }

  const truncated = lines.length > maxLines || Buffer.byteLength(text, "utf8") > maxBytes;
  if (!truncated) return text;

  return `${output}\n\n[Output truncated: showing ${Math.min(lines.length, maxLines)} of ${lines.length} lines.]`;
}

function stringifyUnknownContent(content: unknown, options: ContentConversionOptions): string {
  if (content === undefined) return "(no content)";
  if (typeof content === "string") return truncateText(content, options);
  return truncateText(JSON.stringify(content, null, 2), options);
}
```

- [ ] **Step 6: Implement serial queue**

Create `src/queue.ts` with:

```ts
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
```

- [ ] **Step 7: Implement redacted logging**

Replace `src/log.ts` with:

```ts
import { appendFile } from "node:fs/promises";

const SENSITIVE_KEY_PATTERN = /screenshot|image|base64|token|secret|password|authorization|content|text/i;

export function logDebug(event: string, data: Record<string, unknown> = {}): void {
  if (process.env.OMP_CODEX_COMPUTER_DEBUG !== "1" && !process.env.OMP_CODEX_COMPUTER_LOG) return;

  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...redactForLog(data),
  });

  if (process.env.OMP_CODEX_COMPUTER_DEBUG === "1") {
    process.stderr.write(`[omp-codex-computer] ${entry}\n`);
  }

  const logPath = process.env.OMP_CODEX_COMPUTER_LOG;
  if (logPath) void appendFile(logPath, `${entry}\n`, "utf8").catch(() => undefined);
}

export function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactForLog(entry));
  if (!value || typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redactForLog(nestedValue);
  }
  return redacted;
}
```

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
bun run test tests/content.test.ts tests/queue.test.ts tests/log.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit content, queue, and logging**

Run:

```bash
git add src/content.ts src/queue.ts src/log.ts tests/content.test.ts tests/queue.test.ts tests/log.test.ts
git commit -m "feat: add Computer Use content helpers"
```

Expected: commit succeeds.

---

### Task 4: Thread Manager and Computer Use Backend

**Files:**
- Create: `src/thread-manager.ts`
- Create: `src/computer-use-backend.ts`
- Test: `tests/thread-manager.test.ts`
- Test: `tests/computer-use-backend.test.ts`

- [ ] **Step 1: Write failing thread manager tests**

Create `tests/thread-manager.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { CodexThreadManager } from "../src/thread-manager.ts";

class FakeClient {
  calls: Array<{ method: string; params: unknown }> = [];
  nextId = 1;

  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params });
    return {
      thread: {
        id: `thread-${this.nextId++}`,
        sessionId: "session",
        status: {},
        cwd: (params as { cwd: string }).cwd,
        ephemeral: true,
      },
      model: "test",
      modelProvider: "test",
    } as T;
  }
}

describe("CodexThreadManager", () => {
  it("reuses a thread id until reset", async () => {
    const client = new FakeClient();
    const manager = new CodexThreadManager(client as never);

    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-1");
    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-1");
    manager.reset();
    await expect(manager.getThreadId("/tmp/project")).resolves.toBe("thread-2");

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]).toEqual({ method: "thread/start", params: { cwd: "/tmp/project", ephemeral: true } });
  });
});
```

- [ ] **Step 2: Write failing backend tests**

Create `tests/computer-use-backend.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { ComputerUseBackend } from "../src/computer-use-backend.ts";

class FakeClient {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  responses: Array<unknown | Error> = [];

  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params: params as Record<string, unknown> });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response as T;
  }
}

class FakeThreads {
  ids = ["thread-1"];
  resetCount = 0;

  async getThreadId(): Promise<string> {
    return this.ids[0] ?? "thread-fallback";
  }

  reset(): void {
    this.resetCount++;
    this.ids.shift();
  }
}

describe("ComputerUseBackend", () => {
  it("maps successful tool content", async () => {
    const client = new FakeClient();
    client.responses.push({ content: [{ type: "text", text: "apps" }] });
    const backend = new ComputerUseBackend(client as never, new FakeThreads() as never);

    const result = await backend.callTool("/tmp", "list_apps", {});

    expect(result.content).toEqual([{ type: "text", text: "apps" }]);
    expect(client.calls[0]?.params).toMatchObject({ server: "computer-use", threadId: "thread-1", tool: "list_apps" });
  });

  it("throws when MCP result has isError", async () => {
    const client = new FakeClient();
    client.responses.push({ isError: true, content: [{ type: "text", text: "Invalid app" }] });
    const backend = new ComputerUseBackend(client as never, new FakeThreads() as never);

    await expect(backend.callTool("/tmp", "get_app_state", { app: "Nope" })).rejects.toThrow("Invalid app");
  });

  it("retries once with a fresh thread when app-server forgot the thread", async () => {
    const client = new FakeClient();
    client.responses.push(new Error("thread not found: thread-1"));
    client.responses.push({ content: [{ type: "text", text: "ok" }] });
    const threads = new FakeThreads();
    threads.ids = ["thread-1", "thread-2"];
    const backend = new ComputerUseBackend(client as never, threads as never);

    const result = await backend.callTool("/tmp", "list_apps", {});

    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(threads.resetCount).toBe(1);
    expect(client.calls.map((call) => call.params.threadId)).toEqual(["thread-1", "thread-2"]);
  });

  it("bubbles retry failure", async () => {
    const client = new FakeClient();
    client.responses.push(new Error("thread not found: thread-1"));
    client.responses.push(new Error("still broken"));
    const threads = new FakeThreads();
    threads.ids = ["thread-1", "thread-2"];
    const backend = new ComputerUseBackend(client as never, threads as never);

    await expect(backend.callTool("/tmp", "list_apps", {})).rejects.toThrow("still broken");
    expect(threads.resetCount).toBe(1);
  });
});
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
bun run test tests/thread-manager.test.ts tests/computer-use-backend.test.ts
```

Expected: FAIL because the production modules do not exist.

- [ ] **Step 4: Implement thread manager**

Create `src/thread-manager.ts` with:

```ts
import type { AppServerClient } from "./app-server-client.ts";
import type { ThreadStartResponse } from "./protocol.ts";

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
```

- [ ] **Step 5: Implement backend**

Create `src/computer-use-backend.ts` with:

```ts
import { convertCodexContentToOmpContent, type OmpContentBlock } from "./content.ts";
import { logDebug } from "./log.ts";
import { SerialQueue } from "./queue.ts";
import type { AppServerClient } from "./app-server-client.ts";
import type { CodexThreadManager } from "./thread-manager.ts";

export interface ComputerUseBackendOptions {
  mcpServerName?: string;
}

export interface ComputerUseToolResult {
  content: OmpContentBlock[];
  structuredContent?: unknown;
  meta?: unknown;
}

interface RawMcpToolCallResponse {
  content: unknown;
  structuredContent?: unknown;
  _meta?: unknown;
  isError?: boolean | null;
}

export class ComputerUseBackend {
  private readonly queue = new SerialQueue();
  private readonly mcpServerName: string;

  constructor(
    private readonly client: Pick<AppServerClient, "request">,
    private readonly threads: Pick<CodexThreadManager, "getThreadId" | "reset">,
    options: ComputerUseBackendOptions = {},
  ) {
    this.mcpServerName = options.mcpServerName ?? "computer-use";
  }

  async callTool(cwd: string, tool: string, args: Record<string, unknown>): Promise<ComputerUseToolResult> {
    return this.queue.enqueue(async () => {
      logDebug("computer-use.tool.start", { tool, argKeys: Object.keys(args) });
      try {
        return await this.callToolOnce(cwd, tool, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/thread not found|invalid thread id/i.test(message)) throw error;

        logDebug("computer-use.tool.retry-thread", { tool });
        this.threads.reset();
        return this.callToolOnce(cwd, tool, args);
      }
    });
  }

  private async callToolOnce(cwd: string, tool: string, args: Record<string, unknown>): Promise<ComputerUseToolResult> {
    const threadId = await this.threads.getThreadId(cwd);
    const response = await this.client.request<RawMcpToolCallResponse>("mcpServer/tool/call", {
      server: this.mcpServerName,
      threadId,
      tool,
      arguments: args,
    });

    if (response.isError) {
      logDebug("computer-use.tool.error", { tool });
      const text = convertCodexContentToOmpContent(response.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      throw new Error(text || `${this.mcpServerName}.${tool} failed`);
    }

    const content = convertCodexContentToOmpContent(response.content);
    logDebug("computer-use.tool.end", { tool, contentTypes: content.map((block) => block.type).join(",") });

    return {
      content,
      structuredContent: response.structuredContent,
      meta: response._meta,
    };
  }
}
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
bun run test tests/thread-manager.test.ts tests/computer-use-backend.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit backend**

Run:

```bash
git add src/thread-manager.ts src/computer-use-backend.ts tests/thread-manager.test.ts tests/computer-use-backend.test.ts
git commit -m "feat: add Computer Use backend"
```

Expected: commit succeeds.

---

### Task 5: Status and Chrome Discovery

**Files:**
- Create: `src/status.ts`
- Create: `src/chrome-status.ts`
- Test: `tests/status.test.ts`
- Test: `tests/chrome-status.test.ts`

- [ ] **Step 1: Write failing status tests**

Create `tests/status.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { evaluateComputerUseStatus, findPlugin, formatComputerUseStatus } from "../src/status.ts";
import type { InitializeResponse, McpServerStatusListResponse, PluginListResponse, PluginSummary } from "../src/protocol.ts";

const appServer: InitializeResponse = {
  userAgent: "test/0",
  codexHome: "/tmp/codex",
  platformFamily: "unix",
  platformOs: "macos",
};

function plugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "computer-use@openai-bundled",
    name: "computer-use",
    installed: true,
    enabled: true,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_INSTALL",
    localVersion: "1.0.0",
    ...overrides,
  };
}

function plugins(entries: Array<{ name: string; path?: string | null; plugin?: PluginSummary }>): PluginListResponse {
  return {
    marketplaces: entries.map((entry) => ({
      name: entry.name,
      path: entry.path ?? null,
      plugins: entry.plugin ? [entry.plugin] : [],
    })),
  };
}

function mcp(toolNames: string[] = ["list_apps"]): McpServerStatusListResponse {
  return {
    data: [
      {
        name: "computer-use",
        authStatus: "unsupported",
        resources: [],
        resourceTemplates: [],
        tools: Object.fromEntries(toolNames.map((name) => [name, { name, inputSchema: {} }])),
      },
    ],
  };
}

describe("evaluateComputerUseStatus", () => {
  it("reports codex_app_missing when app bundle missing and no marketplace has plugin", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: false,
      appServer,
      plugins: plugins([{ name: "empty" }]),
      mcp: mcp(),
    });
    expect(status.reason).toBe("codex_app_missing");
  });

  it("reports marketplace_missing when Codex.app exists but plugin is absent", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "empty" }]),
      mcp: mcp(),
    });
    expect(status.reason).toBe("marketplace_missing");
  });

  it("reports plugin_not_installed", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin({ installed: false }) }]),
      mcp: mcp(),
    });
    expect(status.reason).toBe("plugin_not_installed");
  });

  it("reports plugin_disabled", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin({ enabled: false }) }]),
      mcp: mcp(),
    });
    expect(status.reason).toBe("plugin_disabled");
  });

  it("reports mcp_missing when server has no tools", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: { data: [] },
    });
    expect(status.reason).toBe("mcp_missing");
  });

  it("reports ready with sorted tool names", () => {
    const status = evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: mcp(["type_text", "list_apps"]),
    });
    expect(status.reason).toBe("ready");
    expect(status.mcpServer?.toolNames).toEqual(["list_apps", "type_text"]);
  });

  it("formats status without exposing payloads", () => {
    const text = formatComputerUseStatus(evaluateComputerUseStatus({
      codexAppExists: true,
      appServer,
      plugins: plugins([{ name: "openai-bundled", plugin: plugin() }]),
      mcp: mcp(["list_apps"]),
    }));
    expect(text).toContain("Computer Use status: ready");
    expect(text).toContain("MCP tools: list_apps");
  });
});

describe("findPlugin", () => {
  it("prefers openai-bundled over other marketplaces", () => {
    const bundled = plugin({ id: "bundled" });
    const curated = plugin({ id: "curated" });
    const match = findPlugin(plugins([
      { name: "openai-curated", plugin: curated },
      { name: "openai-bundled", plugin: bundled },
    ]), "computer-use");

    expect(match?.plugin.id).toBe("bundled");
  });
});
```

- [ ] **Step 2: Write failing Chrome discovery tests**

Create `tests/chrome-status.test.ts` with:

```ts
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { inspectChromeBridgeStatus } from "../src/chrome-status.ts";

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe("inspectChromeBridgeStatus", () => {
  it("reports available when chrome and browser client files exist", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "omp-codex-chrome-"));
    const plugins = join(tempRoot, "Contents/Resources/plugins/openai-bundled/plugins");
    await mkdir(join(plugins, "chrome/docs"), { recursive: true });
    await mkdir(join(plugins, "chrome/scripts"), { recursive: true });
    await mkdir(join(plugins, "browser/scripts"), { recursive: true });
    await writeFile(join(plugins, "chrome/docs/api.json"), "{}", "utf8");
    await writeFile(join(plugins, "chrome/scripts/browser-client.mjs"), "export {}", "utf8");
    await writeFile(join(plugins, "browser/scripts/browser-client.mjs"), "export {}", "utf8");

    const status = await inspectChromeBridgeStatus(tempRoot);

    expect(status.available).toBe(true);
    expect(status.reason).toBe("available");
  });

  it("reports missing files", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "omp-codex-chrome-"));

    const status = await inspectChromeBridgeStatus(tempRoot);

    expect(status.available).toBe(false);
    expect(status.reason).toBe("missing_files");
    expect(status.missing.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
bun run test tests/status.test.ts tests/chrome-status.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement status evaluation**

Create `src/status.ts` with the same exported types used in `tests/status.test.ts`. Include these functions:

```ts
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { AppServerClient } from "./app-server-client.ts";
import type { InitializeResponse, McpServerStatusListResponse, PluginListResponse, PluginMarketplaceEntry, PluginSummary } from "./protocol.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_CODEX_APP_PATH = "/Applications/Codex.app";
export const DEFAULT_PLUGIN_NAME = "computer-use";
export const DEFAULT_MCP_SERVER_NAME = "computer-use";

export type ComputerUseStatusReason =
  | "ready"
  | "codex_missing"
  | "codex_app_missing"
  | "marketplace_missing"
  | "plugin_not_installed"
  | "plugin_disabled"
  | "mcp_missing"
  | "check_failed";

export interface ComputerUseStatus {
  reason: ComputerUseStatusReason;
  message: string;
  codexVersion?: string;
  appServer?: InitializeResponse;
  codexAppPath?: string;
  marketplace?: { name: string; path?: string | null };
  plugin?: PluginSummary;
  mcpServer?: { name: string; toolNames: string[] };
  error?: string;
}

export interface StatusEvaluationInput {
  codexVersion?: string;
  codexAppExists: boolean;
  appServer: InitializeResponse;
  plugins: PluginListResponse;
  mcp: McpServerStatusListResponse;
}

export async function checkComputerUseStatus(_cwd: string): Promise<ComputerUseStatus> {
  let codexVersion: string | undefined;
  try {
    codexVersion = await getCodexVersion();
  } catch (error) {
    return {
      reason: "codex_missing",
      message: "Codex CLI was not found. Install Codex and ensure `codex` is on PATH.",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const codexAppExists = await pathExists(DEFAULT_CODEX_APP_PATH);
  const client = new AppServerClient({ requestTimeoutMs: 60_000 });

  try {
    const appServer = await client.request<InitializeResponse>("initialize", {
      clientInfo: { name: "omp-codex-computer", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    const plugins = await client.request<PluginListResponse>("plugin/list", {});
    const mcp = await client.request<McpServerStatusListResponse>("mcpServerStatus/list", {});
    return evaluateComputerUseStatus({ codexVersion, codexAppExists, appServer, plugins, mcp });
  } catch (error) {
    return {
      reason: "check_failed",
      message: "Computer Use status check failed while talking to Codex app-server.",
      codexVersion,
      codexAppPath: codexAppExists ? DEFAULT_CODEX_APP_PATH : undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.stop();
  }
}

export function evaluateComputerUseStatus(input: StatusEvaluationInput): ComputerUseStatus {
  const { codexVersion, codexAppExists, appServer, plugins, mcp } = input;
  const match = findPlugin(plugins, DEFAULT_PLUGIN_NAME);
  if (!match) {
    return {
      reason: codexAppExists ? "marketplace_missing" : "codex_app_missing",
      message: codexAppExists
        ? `No Codex marketplace currently lists ${DEFAULT_PLUGIN_NAME}.`
        : `Codex app bundle was not found at ${DEFAULT_CODEX_APP_PATH}.`,
      codexVersion,
      appServer,
      codexAppPath: codexAppExists ? DEFAULT_CODEX_APP_PATH : undefined,
    };
  }

  if (!match.plugin.installed) {
    return {
      reason: "plugin_not_installed",
      message: `${DEFAULT_PLUGIN_NAME} is available in marketplace ${match.marketplace.name}, but is not installed.`,
      codexVersion,
      appServer,
      codexAppPath: codexAppExists ? DEFAULT_CODEX_APP_PATH : undefined,
      marketplace: { name: match.marketplace.name, path: match.marketplace.path },
      plugin: match.plugin,
    };
  }

  if (!match.plugin.enabled) {
    return {
      reason: "plugin_disabled",
      message: `${DEFAULT_PLUGIN_NAME} is installed but disabled.`,
      codexVersion,
      appServer,
      codexAppPath: codexAppExists ? DEFAULT_CODEX_APP_PATH : undefined,
      marketplace: { name: match.marketplace.name, path: match.marketplace.path },
      plugin: match.plugin,
    };
  }

  const server = mcp.data.find((entry) => entry.name === DEFAULT_MCP_SERVER_NAME);
  if (!server || Object.keys(server.tools).length === 0) {
    return {
      reason: "mcp_missing",
      message: `${DEFAULT_MCP_SERVER_NAME} plugin is enabled, but its MCP server/tools are not available.`,
      codexVersion,
      appServer,
      codexAppPath: codexAppExists ? DEFAULT_CODEX_APP_PATH : undefined,
      marketplace: { name: match.marketplace.name, path: match.marketplace.path },
      plugin: match.plugin,
    };
  }

  return {
    reason: "ready",
    message: "Codex Computer Use is installed, enabled, and exposing MCP tools.",
    codexVersion,
    appServer,
    codexAppPath: codexAppExists ? DEFAULT_CODEX_APP_PATH : undefined,
    marketplace: { name: match.marketplace.name, path: match.marketplace.path },
    plugin: match.plugin,
    mcpServer: { name: server.name, toolNames: Object.keys(server.tools).sort() },
  };
}

export function formatComputerUseStatus(status: ComputerUseStatus): string {
  const lines = [
    `Computer Use status: ${status.reason}`,
    status.message,
    "",
    `Codex CLI: ${status.codexVersion ?? "unknown"}`,
    `Codex.app: ${status.codexAppPath ?? "not found at default path"}`,
  ];

  if (status.appServer) lines.push(`App-server: ${status.appServer.userAgent}`);
  if (status.marketplace) lines.push(`Marketplace: ${status.marketplace.name}${status.marketplace.path ? ` (${status.marketplace.path})` : ""}`);
  if (status.plugin) {
    lines.push(`Plugin: ${status.plugin.name} installed=${status.plugin.installed} enabled=${status.plugin.enabled} version=${status.plugin.localVersion ?? "unknown"}`);
  }
  if (status.mcpServer) {
    lines.push(`MCP server: ${status.mcpServer.name}`);
    lines.push(`MCP tools: ${status.mcpServer.toolNames.join(", ")}`);
  }
  if (status.error) lines.push(`Error: ${status.error}`);

  return lines.join("\n");
}

export function findPlugin(
  response: PluginListResponse,
  pluginName: string,
): { marketplace: PluginMarketplaceEntry; plugin: PluginSummary } | undefined {
  const matches: Array<{ marketplace: PluginMarketplaceEntry; plugin: PluginSummary }> = [];
  for (const marketplace of response.marketplaces) {
    const plugin = marketplace.plugins.find((entry) => entry.name === pluginName);
    if (plugin) matches.push({ marketplace, plugin });
  }

  return matches.find((match) => match.marketplace.name === "openai-bundled")
    ?? matches.find((match) => match.marketplace.name === "openai-curated")
    ?? matches[0];
}

async function getCodexVersion(): Promise<string> {
  const result = await execFileAsync("codex", ["--version"], { timeout: 10_000 });
  return result.stdout.trim() || result.stderr.trim() || "codex found";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Implement Chrome discovery**

Create `src/chrome-status.ts` with:

```ts
import { access } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CODEX_APP_PATH } from "./status.ts";

export interface ChromeBridgeStatus {
  available: boolean;
  reason: "available" | "missing_files";
  root: string;
  missing: string[];
  files: {
    chromeApiJson: string;
    chromeBrowserClient: string;
    browserClient: string;
  };
}

export async function inspectChromeBridgeStatus(codexAppPath = DEFAULT_CODEX_APP_PATH): Promise<ChromeBridgeStatus> {
  const pluginRoot = join(codexAppPath, "Contents/Resources/plugins/openai-bundled/plugins");
  const files = {
    chromeApiJson: join(pluginRoot, "chrome/docs/api.json"),
    chromeBrowserClient: join(pluginRoot, "chrome/scripts/browser-client.mjs"),
    browserClient: join(pluginRoot, "browser/scripts/browser-client.mjs"),
  };

  const missing: string[] = [];
  for (const path of Object.values(files)) {
    if (!(await pathExists(path))) missing.push(path);
  }

  return {
    available: missing.length === 0,
    reason: missing.length === 0 ? "available" : "missing_files",
    root: pluginRoot,
    missing,
    files,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
bun run test tests/status.test.ts tests/chrome-status.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit status modules**

Run:

```bash
git add src/status.ts src/chrome-status.ts tests/status.test.ts tests/chrome-status.test.ts
git commit -m "feat: add Codex Computer status checks"
```

Expected: commit succeeds.

---

### Task 6: Runtime Permission Handling

**Files:**
- Create: `src/runtime.ts`
- Test: `tests/runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Create `tests/runtime.test.ts` with:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { ComputerUseRuntime, shouldDevAutoAccept } from "../src/runtime.ts";

class FakeResponder {
  accepted: unknown[] = [];
  rejected: unknown[] = [];

  accept(value: unknown): void {
    this.accepted.push(value);
  }

  reject(value: unknown): void {
    this.rejected.push(value);
  }
}

afterEach(() => {
  delete process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS;
});

describe("shouldDevAutoAccept", () => {
  it("accepts only exact allowlisted app names from permission messages", () => {
    process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS = "Calculator, TextEdit";

    expect(shouldDevAutoAccept("Allow Codex to use Calculator?")).toBe(true);
    expect(shouldDevAutoAccept("Allow Codex to use Safari?")).toBe(false);
  });
});

describe("ComputerUseRuntime permission handling", () => {
  it("declines elicitation without UI", async () => {
    const runtime = new ComputerUseRuntime();
    const responder = new FakeResponder();

    await runtime.handleServerRequestForTest({
      id: "permission",
      method: "mcpServer/elicitation/request",
      params: { message: "Allow Codex to use Finder?", serverName: "computer-use" },
    }, responder);

    expect(responder.accepted).toEqual([{ action: "decline", content: null }]);
  });

  it("asks UI confirmation when UI is available", async () => {
    const runtime = new ComputerUseRuntime();
    runtime.setContext({
      cwd: "/tmp",
      hasUI: true,
      signal: undefined,
      ui: {
        confirm: async () => true,
        setStatus: () => undefined,
      },
    } as never);
    const responder = new FakeResponder();

    await runtime.handleServerRequestForTest({
      id: "permission",
      method: "mcpServer/elicitation/request",
      params: { message: "Allow Codex to use TextEdit?", serverName: "computer-use" },
    }, responder);

    expect(responder.accepted).toEqual([{ action: "accept", content: {} }]);
  });
});
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
bun run test tests/runtime.test.ts
```

Expected: FAIL because `src/runtime.ts` does not exist.

- [ ] **Step 3: Implement runtime**

Create `src/runtime.ts` with:

```ts
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AppServerClient, type ServerRequestResponder } from "./app-server-client.ts";
import { ComputerUseBackend, type ComputerUseToolResult } from "./computer-use-backend.ts";
import { logDebug } from "./log.ts";
import type { AppServerRequest, InitializeResponse } from "./protocol.ts";
import { CodexThreadManager } from "./thread-manager.ts";

export class ComputerUseRuntime {
  readonly client = new AppServerClient({ requestTimeoutMs: 120_000 });
  readonly threads = new CodexThreadManager(this.client);
  readonly backend = new ComputerUseBackend(this.client, this.threads);

  private latestContext: ExtensionContext | undefined;
  private initializePromise: Promise<InitializeResponse> | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.client.onServerRequest((request, responder) => this.handleServerRequest(request, responder));
  }

  setContext(ctx: ExtensionContext): void {
    this.latestContext = ctx;
  }

  resetSession(): void {
    this.threads.reset();
  }

  async shutdown(): Promise<void> {
    logDebug("runtime.shutdown");
    this.clearIdleTimer();
    this.initializePromise = undefined;
    this.threads.reset();
    await this.client.stop();
    this.setStatus("idle");
  }

  async initialize(): Promise<InitializeResponse> {
    if (!this.client.isRunning()) {
      this.initializePromise = undefined;
      this.threads.reset();
    }

    this.initializePromise ??= this.client.request<InitializeResponse>("initialize", {
      clientInfo: { name: "omp-codex-computer", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    return this.initializePromise;
  }

  async callTool(ctx: ExtensionContext, tool: string, args: Record<string, unknown>): Promise<ComputerUseToolResult> {
    this.setContext(ctx);
    this.clearIdleTimer();
    this.setStatus(typeof args.app === "string" ? `working: ${args.app}` : "working");

    try {
      await this.initialize();
      const result = await this.backend.callTool(ctx.cwd, tool, args);
      this.setStatus("ready");
      return result;
    } catch (error) {
      this.setStatus("error");
      throw error;
    } finally {
      this.scheduleIdleShutdown();
    }
  }

  async handleServerRequestForTest(request: AppServerRequest, responder: ServerRequestResponder): Promise<void> {
    await this.handleServerRequest(request, responder);
  }

  private async handleServerRequest(request: AppServerRequest, responder: ServerRequestResponder): Promise<void> {
    if (request.method !== "mcpServer/elicitation/request") {
      responder.reject({ code: -32601, message: `Unsupported Codex app-server request: ${request.method}` });
      return;
    }

    const params = request.params as { message?: string; serverName?: string } | undefined;
    const message = params?.message ?? "Codex Computer Use requests permission to continue.";
    this.setStatus("permission");
    logDebug("elicitation.request", { serverName: params?.serverName, message });

    if (shouldDevAutoAccept(message)) {
      logDebug("elicitation.accept.dev");
      responder.accept({ action: "accept", content: {} });
      return;
    }

    const ctx = this.latestContext;
    if (!ctx?.hasUI) {
      logDebug("elicitation.decline.no-ui");
      responder.accept({ action: "decline", content: null });
      return;
    }

    const approved = await ctx.ui.confirm(
      "Codex Computer Use permission",
      message,
      ctx.signal ? { signal: ctx.signal } : undefined,
    );
    logDebug(approved ? "elicitation.accept.user" : "elicitation.decline.user");
    responder.accept({ action: approved ? "accept" : "decline", content: approved ? {} : null });
  }

  private setStatus(value: string): void {
    const ctx = this.latestContext;
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus("codex-computer", `Codex Computer: ${value}`);
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    const timeoutMs = Number.parseInt(process.env.OMP_CODEX_COMPUTER_IDLE_TIMEOUT_MS ?? "600000", 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

    this.idleTimer = setTimeout(() => {
      void this.shutdown();
    }, timeoutMs);
  }
}

export function shouldDevAutoAccept(message: string): boolean {
  const allowlist = process.env.OMP_CODEX_COMPUTER_DEV_AUTO_ACCEPT_APPS;
  if (!allowlist) return false;

  const allowedApps = allowlist
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowedApps.length === 0) return false;

  const match = message.match(/Allow Codex to use (.+?)\?/i);
  const requestedApp = match?.[1]?.trim();
  if (!requestedApp) return false;

  return allowedApps.some((app) => app.toLocaleLowerCase() === requestedApp.toLocaleLowerCase());
}
```

- [ ] **Step 4: Run focused test and verify GREEN**

Run:

```bash
bun run test tests/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit runtime**

Run:

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat: add Computer Use runtime"
```

Expected: commit succeeds.

---

### Task 7: OMP Tools, Commands, and Extension Entry

**Files:**
- Create: `src/computer-use-tools.ts`
- Create: `src/index.ts`
- Test: `tests/computer-use-tools.test.ts`
- Test: `tests/index.test.ts`

- [ ] **Step 1: Write failing tool registration tests**

Create `tests/computer-use-tools.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { COMPUTER_USE_TOOL_NAMES, registerComputerUseTools } from "../src/computer-use-tools.ts";

function fakePi() {
  const tools: Array<{ name: string; execute: (...args: never[]) => Promise<unknown> }> = [];
  const schema = (type: string) => ({
    type,
    describe: () => schema(type),
    optional: () => ({ ...schema(type), optional: true }),
  });
  const z = {
    object: (shape: unknown) => ({ type: "object", shape }),
    string: () => schema("string"),
    number: () => schema("number"),
    enum: (values: string[]) => ({ values, optional: () => ({ values, optional: true }) }),
  };
  return {
    tools,
    pi: {
      zod: z,
      registerTool(tool: { name: string; execute: (...args: never[]) => Promise<unknown> }) {
        tools.push(tool);
      },
    },
  };
}

describe("registerComputerUseTools", () => {
  it("registers the expected tool names", () => {
    const { pi, tools } = fakePi();

    registerComputerUseTools(pi as never, { callTool: async () => ({ content: [{ type: "text", text: "ok" }] }) } as never);

    expect(tools.map((tool) => tool.name)).toEqual([...COMPUTER_USE_TOOL_NAMES]);
  });
});
```

- [ ] **Step 2: Write failing extension entry tests**

Create `tests/index.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import extension from "../src/index.ts";

describe("extension entry", () => {
  it("registers the codex-computer command", () => {
    const commands: string[] = [];
    const schema = () => ({
      describe: () => schema(),
      optional: () => schema(),
    });
    const pi = {
      zod: {
        object: () => ({}),
        string: schema,
        number: schema,
        enum: () => ({ optional: () => ({}) }),
      },
      registerTool: () => undefined,
      registerCommand(name: string) {
        commands.push(name);
      },
      on: () => undefined,
      getActiveTools: () => [],
      setActiveTools: () => undefined,
    };

    extension(pi as never);

    expect(commands).toContain("codex-computer");
  });
});
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
bun run test tests/computer-use-tools.test.ts tests/index.test.ts
```

Expected: FAIL because `src/computer-use-tools.ts` and `src/index.ts` do not exist.

- [ ] **Step 4: Implement tool registration**

Create `src/computer-use-tools.ts` with:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ComputerUseRuntime } from "./runtime.ts";
import type { ComputerUseToolResult } from "./computer-use-backend.ts";

export const COMPUTER_USE_TOOL_NAMES = [
  "computer_use_list_apps",
  "computer_use_get_app_state",
  "computer_use_click",
  "computer_use_type_text",
  "computer_use_press_key",
  "computer_use_scroll",
  "computer_use_drag",
  "computer_use_set_value",
  "computer_use_select_text",
  "computer_use_perform_secondary_action",
] as const;

export function registerComputerUseTools(pi: ExtensionAPI, runtime: ComputerUseRuntime): void {
  const z = pi.zod;
  const app = z.string().describe("App name, full app path, or unambiguous bundle identifier");
  const elementIndex = z.string().describe("Accessibility element index from computer_use_get_app_state");

  const register = (
    name: (typeof COMPUTER_USE_TOOL_NAMES)[number],
    label: string,
    description: string,
    tool: string,
    parameters: unknown,
  ) => {
    pi.registerTool({
      name,
      label,
      description,
      parameters: parameters as never,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const result = await runtime.callTool(ctx, tool, params as Record<string, unknown>);
        return { content: result.content, details: summarizeResult(result) };
      },
    });
  };

  register("computer_use_list_apps", "Computer Use: List Apps", "List local Mac apps available to Codex Computer Use.", "list_apps", z.object({}));
  register("computer_use_get_app_state", "Computer Use: Get App State", "Get an app accessibility tree and screenshot.", "get_app_state", z.object({ app }));
  register("computer_use_click", "Computer Use: Click", "Click an element index or screenshot coordinates.", "click", z.object({
    app,
    element_index: elementIndex.optional(),
    x: z.number().describe("X coordinate in screenshot pixels").optional(),
    y: z.number().describe("Y coordinate in screenshot pixels").optional(),
    click_count: z.number().describe("Number of clicks. Defaults to 1").optional(),
    mouse_button: z.enum(["left", "right", "middle"]).optional(),
  }));
  register("computer_use_type_text", "Computer Use: Type Text", "Type literal text into the focused app control.", "type_text", z.object({
    app,
    text: z.string().describe("Literal text to type"),
  }));
  register("computer_use_press_key", "Computer Use: Press Key", "Press a keyboard key or key combination in an app.", "press_key", z.object({
    app,
    key: z.string().describe("Key or key combination, such as Return, Tab, or super+c"),
  }));
  register("computer_use_scroll", "Computer Use: Scroll", "Scroll a scrollable app element.", "scroll", z.object({
    app,
    element_index: elementIndex,
    direction: z.enum(["up", "down", "left", "right"]),
    pages: z.number().describe("Number of pages to scroll. Defaults to 1").optional(),
  }));
  register("computer_use_drag", "Computer Use: Drag", "Drag between screenshot pixel coordinates in an app.", "drag", z.object({
    app,
    from_x: z.number().describe("Start X coordinate"),
    from_y: z.number().describe("Start Y coordinate"),
    to_x: z.number().describe("End X coordinate"),
    to_y: z.number().describe("End Y coordinate"),
  }));
  register("computer_use_set_value", "Computer Use: Set Value", "Set the value of a settable accessibility element.", "set_value", z.object({
    app,
    element_index: elementIndex,
    value: z.string().describe("Value to assign"),
  }));
  register("computer_use_select_text", "Computer Use: Select Text", "Select text or place a cursor inside a text element.", "select_text", z.object({
    app,
    element_index: elementIndex,
    text: z.string().describe("Target text as shown in the accessibility tree"),
    selection: z.enum(["text", "cursor_before", "cursor_after"]).optional(),
    prefix: z.string().describe("Optional text immediately before target").optional(),
    suffix: z.string().describe("Optional text immediately after target").optional(),
  }));
  register("computer_use_perform_secondary_action", "Computer Use: Secondary Action", "Invoke a secondary accessibility action exposed by an app element.", "perform_secondary_action", z.object({
    app,
    element_index: elementIndex,
    action: z.string().describe("Secondary accessibility action name"),
  }));
}

function summarizeResult(result: ComputerUseToolResult): Record<string, unknown> {
  return {
    contentTypes: result.content.map((block) => block.type),
    textBlockCount: result.content.filter((block) => block.type === "text").length,
    imageBlockCount: result.content.filter((block) => block.type === "image").length,
    hasStructuredContent: result.structuredContent !== undefined,
    hasMeta: result.meta !== undefined,
  };
}
```

- [ ] **Step 5: Implement extension entry**

Create `src/index.ts` with:

```ts
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { inspectChromeBridgeStatus } from "./chrome-status.ts";
import { COMPUTER_USE_TOOL_NAMES, registerComputerUseTools } from "./computer-use-tools.ts";
import { ComputerUseRuntime } from "./runtime.ts";
import { checkComputerUseStatus, formatComputerUseStatus } from "./status.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, "../skills");

export default function ompCodexComputer(pi: ExtensionAPI): void {
  const runtime = new ComputerUseRuntime();
  let toolsEnabled = true;

  registerComputerUseTools(pi, runtime);

  pi.on("resources_discover", () => ({
    skillPaths: [SKILLS_DIR],
  }));

  pi.on("session_start", (_event, ctx) => {
    runtime.setContext(ctx);
    runtime.resetSession();
    setComputerUseToolsEnabled(pi, toolsEnabled);
  });

  pi.on("agent_end", async () => {
    await runtime.shutdown();
  });

  pi.on("session_shutdown", async () => {
    await runtime.shutdown();
  });

  pi.registerCommand("codex-computer", {
    description: "Manage Codex Computer Use integration: status, diagnose, enable, disable, restart",
    getArgumentCompletions(prefix) {
      return ["status", "diagnose", "enable", "disable", "restart"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      runtime.setContext(ctx);
      const [subcommand = "status"] = args.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "status") {
        await sendStatus(pi, ctx, toolsEnabled, false);
        return;
      }

      if (subcommand === "diagnose") {
        await sendStatus(pi, ctx, toolsEnabled, true);
        return;
      }

      if (subcommand === "enable") {
        toolsEnabled = true;
        setComputerUseToolsEnabled(pi, true);
        sendCommandMessage(pi, ctx, "Computer Use tools enabled.");
        return;
      }

      if (subcommand === "disable") {
        toolsEnabled = false;
        setComputerUseToolsEnabled(pi, false);
        await runtime.shutdown();
        sendCommandMessage(pi, ctx, "Computer Use tools disabled and runtime shut down.");
        return;
      }

      if (subcommand === "restart") {
        await runtime.shutdown();
        sendCommandMessage(pi, ctx, "Computer Use runtime restarted; it will lazy-start on next use.");
        return;
      }

      sendCommandMessage(pi, ctx, `Unknown codex-computer command '${subcommand}'. Try status, diagnose, enable, disable, or restart.`);
    },
  });
}

async function sendStatus(pi: ExtensionAPI, ctx: ExtensionContext, toolsEnabled: boolean, diagnose: boolean): Promise<void> {
  const status = await checkComputerUseStatus(ctx.cwd);
  const chrome = diagnose ? await inspectChromeBridgeStatus() : undefined;
  const chromeText = chrome
    ? `\n\nChrome bridge: ${chrome.reason}\nMissing files: ${chrome.missing.length === 0 ? "none" : chrome.missing.join(", ")}`
    : "";
  const content = `${formatComputerUseStatus(status)}${toolsEnabled ? "" : "\n\nComputer Use OMP tools are currently disabled."}${chromeText}`;
  pi.sendMessage({ customType: "codex-computer", content, display: true });
}

function sendCommandMessage(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  content: string,
): void {
  if (ctx.hasUI) ctx.ui.notify(content, "info");
  pi.sendMessage({ customType: "codex-computer", content, display: true });
}

function setComputerUseToolsEnabled(pi: ExtensionAPI, enabled: boolean): void {
  const active = new Set(pi.getActiveTools());
  for (const name of COMPUTER_USE_TOOL_NAMES) {
    if (enabled) active.add(name);
    else active.delete(name);
  }
  pi.setActiveTools([...active]);
}
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
bun run test tests/computer-use-tools.test.ts tests/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run typecheck and adjust only compile errors**

Run:

```bash
bun run typecheck
```

Expected: PASS. If TypeScript reports OMP API type mismatches, adjust the exact local call signature while keeping the tests' behavior unchanged.

- [ ] **Step 8: Commit OMP entry**

Run:

```bash
git add src/computer-use-tools.ts src/index.ts tests/computer-use-tools.test.ts tests/index.test.ts
git commit -m "feat: register OMP Computer Use tools"
```

Expected: commit succeeds.

---

### Task 8: Full Verification and Local OMP Smoke

**Files:**
- Modify: `README.md`
- No new unit-test file

- [ ] **Step 1: Run full automated checks**

Run:

```bash
bun run check
```

Expected: TypeScript and all Vitest tests pass.

- [ ] **Step 2: Run read-only Codex app-server smoke**

Run:

```bash
codex app-server --help | sed -n '1,60p'
```

Expected: output includes `--listen <URL>` and `stdio://`.

- [ ] **Step 3: Run OMP extension status smoke in tmux**

Run:

```bash
tmux new-session -d -s omp-codex-computer-smoke 'cd /Volumes/ExtraDisk/Dev/omp-codex-computer && omp-dev -e /Volumes/ExtraDisk/Dev/omp-codex-computer'
tmux capture-pane -pt omp-codex-computer-smoke -S -120
```

Expected: OMP starts without extension-load errors. If OMP requires interactive input before accepting slash commands, attach manually with `tmux attach -t omp-codex-computer-smoke`.

- [ ] **Step 4: Exercise `/codex-computer status` in OMP**

In the tmux session, send:

```bash
tmux send-keys -t omp-codex-computer-smoke '/codex-computer status' Enter
sleep 5
tmux capture-pane -pt omp-codex-computer-smoke -S -200
```

Expected: captured output includes `Computer Use status:` and does not include screenshots, base64, access tokens, or accessibility tree dumps.

- [ ] **Step 5: Exercise a safe model-level tool path**

In the tmux session, ask:

```text
Use Codex Computer Use to list available apps, then stop.
```

Expected: OMP can call `computer_use_list_apps` or reports a clear status/permission error from Codex. Do not perform clicks, typing, form submits, destructive actions, or account actions during this smoke.

- [ ] **Step 6: Stop owned tmux session**

Run:

```bash
tmux kill-session -t omp-codex-computer-smoke
```

Expected: tmux session exits.

- [ ] **Step 7: Update README with verified status**

Append a short verification section to `README.md`:

````markdown
## Verification

Local automated checks:

```bash
bun run check
```

Local OMP smoke:

```bash
omp-dev -e /Volumes/ExtraDisk/Dev/omp-codex-computer
/codex-computer status
```
````

- [ ] **Step 8: Commit verification docs**

Run:

```bash
git add README.md
git commit -m "docs: add local verification notes"
```

Expected: commit succeeds.

- [ ] **Step 9: Final git status**

Run:

```bash
git status --short --branch
```

Expected: clean working tree on `main`.

---

## Acceptance Criteria

- `bun run check` passes.
- OMP can load the extension from `/Volumes/ExtraDisk/Dev/omp-codex-computer`.
- `/codex-computer status` returns a clear status message.
- The extension exposes all planned `computer_use_*` tools.
- Desktop tool calls are serialized.
- Permission prompts fail closed without UI.
- Debug logging redacts sensitive fields.
- Chrome support is limited to file discovery/status in this MVP.
