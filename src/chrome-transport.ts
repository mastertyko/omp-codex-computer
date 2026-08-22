import { pathToFileURL } from "node:url";
import type { AppServerClient } from "./app-server-client";
import {
  evaluateChromeCapabilities,
  type ChromeCapabilities,
} from "./chrome-capabilities";
import type {
  InitializeResponse,
  McpServerStatusListResponse,
  PluginListResponse,
} from "./protocol";
import type { CodexThreadInfo, CodexThreadManager } from "./thread-manager";

export type ChromeLocator =
  | { kind: "role"; role: string; name?: string }
  | { kind: "text"; text: string }
  | { kind: "label"; label: string }
  | { kind: "placeholder"; placeholder: string }
  | { kind: "test_id"; testId: string };

export const CHROME_PRESS_KEYS = Object.freeze([
  "Enter",
  "Tab",
  "Shift+Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  "Space",
] as const);

export type ChromePressKey = (typeof CHROME_PRESS_KEYS)[number];

export type ChromeAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target: ChromeLocator }
  | { kind: "fill"; target: ChromeLocator; value: string }
  | { kind: "press"; target: ChromeLocator; key: ChromePressKey }
  | { kind: "close" };

export interface ChromeTurnIdentity {
  sessionId: string;
  turnId: string;
}

export type ChromeOperation =
  | { kind: "open" }
  | { kind: "observe" }
  | { kind: "act"; action: ChromeAction }
  | { kind: "cleanup" };

export type ChromeResult =
  | { kind: "opened" }
  | { kind: "snapshot"; text: string; truncated: boolean; byteLength: number }
  | { kind: "closed" };

export type ChromeTransportErrorCode =
  | "not_prepared"
  | "unavailable"
  | "invalid_request"
  | "protocol_failed"
  | "tab_already_open"
  | "tab_not_open"
  | "operation_failed"
  | "snapshot_failed_after_action"
  | "interrupted"
  | "request_failed";

const CHROME_PROTOCOL = "omp-codex-computer/chrome-v1" as const;
const NODE_REPL_EXECUTION_TIMEOUT_MS = 120_000;
const MAX_URL_LENGTH = 2048;
const MAX_IDENTITY_BYTES = 128;
const MAX_LOCATOR_BYTES = 1024;
const MAX_FILL_BYTES = 32 * 1024;
const MAX_SNAPSHOT_BYTES = 50 * 1024;
const MAX_SNAPSHOT_LINES = 3000;
const SNAPSHOT_TRUNCATION_MARKER = "[Output truncated]";
const PRESS_KEY_LOOKUP = new Set<string>(CHROME_PRESS_KEYS);

const ERROR_MESSAGES: Readonly<Record<ChromeTransportErrorCode, string>> = Object.freeze({
  not_prepared: "Chrome transport is not prepared",
  unavailable: "Chrome is unavailable",
  invalid_request: "Chrome request is invalid",
  protocol_failed: "Chrome transport returned an invalid response",
  tab_already_open: "Chrome already has an open agent tab",
  tab_not_open: "Chrome has no open agent tab",
  operation_failed: "Chrome operation failed",
  snapshot_failed_after_action: "Chrome action completed but its snapshot is unavailable",
  interrupted: "Chrome operation was interrupted",
  request_failed: "Chrome transport request failed",
});

interface ReadyChromeCapabilities {
  pluginVersion: string;
  appServerVersion: string;
  clientPath: string;
  nodeReplServerName: string;
}

interface PreparedChrome {
  capabilities: ReadyChromeCapabilities;
  thread: CodexThreadInfo;
}

interface RawMcpToolCallResponse {
  content?: unknown;
  isError?: unknown;
}

interface SnapshotResult {
  kind: "snapshot";
  text: string;
  truncated: boolean;
  byteLength: number;
}

type ProgramErrorCode =
  | "unavailable"
  | "protocol_failed"
  | "tab_already_open"
  | "tab_not_open"
  | "operation_failed"
  | "snapshot_failed_after_action";

export class ChromeTransportError extends Error {
  constructor(
    readonly code: ChromeTransportErrorCode,
    message = ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = code === "interrupted" ? "AbortError" : "ChromeTransportError";
  }
}

export class ChromeTransport {
  private preparedCwd: string | undefined;
  private preparation: Promise<PreparedChrome> | undefined;

  constructor(
    private readonly client: Pick<AppServerClient, "request">,
    private readonly threads: Pick<CodexThreadManager, "getThread">,
  ) {}

  reset(): void {
    this.preparedCwd = undefined;
    this.preparation = undefined;
  }

  async prepare(
    cwd: string,
    initialize: InitializeResponse,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.preparation) {
      if (this.preparedCwd !== cwd) throw new ChromeTransportError("not_prepared");
      await this.preparation;
      return;
    }

    assertNonEmptyString(cwd, "cwd", MAX_IDENTITY_BYTES * 8);
    throwIfAborted(signal);
    this.preparedCwd = cwd;
    this.preparation = this.discover(cwd, initialize, signal);
    await this.preparation;
  }

  async execute(
    cwd: string,
    identity: ChromeTurnIdentity,
    operation: ChromeOperation,
    signal?: AbortSignal,
  ): Promise<ChromeResult> {
    validateIdentity(identity);
    validateOperation(operation);
    throwIfAborted(signal);

    const preparation = this.preparation;
    if (!preparation || this.preparedCwd !== cwd) {
      throw new ChromeTransportError("not_prepared");
    }
    const prepared = await preparation;
    throwIfAborted(signal);

    const payload = Buffer.from(JSON.stringify({ identity, operation }), "utf8").toString("base64");
    const program = buildChromeProgram(prepared.capabilities.clientPath, payload);
    let response: RawMcpToolCallResponse;
    try {
      response = await this.client.request<RawMcpToolCallResponse>("mcpServer/tool/call", {
        server: prepared.capabilities.nodeReplServerName,
        threadId: prepared.thread.id,
        tool: "js",
        arguments: {
          code: program,
          title: "Chrome operation",
          timeout_ms: NODE_REPL_EXECUTION_TIMEOUT_MS,
        },
        _meta: {
          "x-codex-turn-metadata": {
            session_id: identity.sessionId,
            thread_id: prepared.thread.id,
            turn_id: identity.turnId,
            request_kind: "turn",
          },
        },
      }, 0, signal);
    } catch (error) {
      throw sanitizeRequestError(error);
    }

    return readChromeEnvelope(response, operation);
  }

  private async discover(
    cwd: string,
    initialize: InitializeResponse,
    signal?: AbortSignal,
  ): Promise<PreparedChrome> {
    let capabilities: ChromeCapabilities;
    try {
      const [plugins, mcp] = await Promise.all([
        this.client.request<PluginListResponse>("plugin/list", {}, undefined, signal),
        this.client.request<McpServerStatusListResponse>("mcpServerStatus/list", {}, undefined, signal),
      ]);
      throwIfAborted(signal);
      capabilities = await evaluateChromeCapabilities(initialize, plugins, mcp);
    } catch (error) {
      throw sanitizeRequestError(error);
    }

    if (!isReadyChromeCapabilities(capabilities)) {
      const message = readSafeUnavailableMessage(capabilities);
      throw new ChromeTransportError("unavailable", message);
    }

    throwIfAborted(signal);
    let thread: CodexThreadInfo;
    try {
      thread = await this.threads.getThread(cwd);
    } catch (error) {
      throw sanitizeRequestError(error);
    }
    throwIfAborted(signal);
    if (!isValidThread(thread)) throw new ChromeTransportError("protocol_failed");

    return { capabilities, thread };
  }
}

function buildChromeProgram(clientPath: string, payloadBase64: string): string {
  const clientUrlLiteral = JSON.stringify(pathToFileURL(clientPath).href);
  const payloadLiteral = JSON.stringify(payloadBase64);
  const protocolLiteral = JSON.stringify(CHROME_PROTOCOL);
  const pressKeysLiteral = JSON.stringify(CHROME_PRESS_KEYS);
  const maxUrlLengthLiteral = JSON.stringify(MAX_URL_LENGTH);
  const maxIdentityBytesLiteral = JSON.stringify(MAX_IDENTITY_BYTES);
  const maxLocatorBytesLiteral = JSON.stringify(MAX_LOCATOR_BYTES);
  const maxFillBytesLiteral = JSON.stringify(MAX_FILL_BYTES);
  const maxSnapshotBytesLiteral = JSON.stringify(MAX_SNAPSHOT_BYTES);
  const maxSnapshotLinesLiteral = JSON.stringify(MAX_SNAPSHOT_LINES);
  const truncationMarkerLiteral = JSON.stringify(SNAPSHOT_TRUNCATION_MARKER);

  return `await (async () => {
  const protocol = ${protocolLiteral};
  const expectedFailure = Symbol("chromeExpectedFailure");
  const pressKeys = new Set(${pressKeysLiteral});
  const maxUrlLength = ${maxUrlLengthLiteral};
  const maxIdentityBytes = ${maxIdentityBytesLiteral};
  const maxLocatorBytes = ${maxLocatorBytesLiteral};
  const maxFillBytes = ${maxFillBytesLiteral};
  const maxSnapshotBytes = ${maxSnapshotBytesLiteral};
  const maxSnapshotLines = ${maxSnapshotLinesLiteral};
  const truncationMarker = ${truncationMarkerLiteral};
  let phase = "validate";

  const writeEnvelope = (value) => nodeRepl.write(JSON.stringify({ protocol, ...value }));
  const fail = (code) => {
    const failure = Object.create(null);
    failure[expectedFailure] = code;
    throw failure;
  };
  const isRecord = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };
  const hasExactKeys = (value, required, optional = []) => {
    if (!isRecord(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return false;
    const allowed = new Set([...required, ...optional]);
    if (keys.some((key) => !allowed.has(key))) return false;
    if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value");
    });
  };
  const validText = (value, maxBytes, allowEmpty = false) =>
    typeof value === "string"
    && (allowEmpty || value.length > 0)
    && Buffer.byteLength(value, "utf8") <= maxBytes;
  const validUrl = (value) => {
    if (typeof value !== "string"
      || value.length === 0
      || Buffer.byteLength(value, "utf8") > maxUrlLength) return false;
    if (/[\\u0000-\\u0020\\u007f]/u.test(value)) return false;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === "http:" || parsed.protocol === "https:")
        && parsed.username === ""
        && parsed.password === "";
    } catch {
      return false;
    }
  };
  const validTarget = (target) => {
    if (!isRecord(target) || typeof target.kind !== "string") return false;
    switch (target.kind) {
      case "role":
        return hasExactKeys(target, ["kind", "role"], ["name"])
          && validText(target.role, maxLocatorBytes)
          && (target.name === undefined || validText(target.name, maxLocatorBytes));
      case "text":
        return hasExactKeys(target, ["kind", "text"])
          && validText(target.text, maxLocatorBytes);
      case "label":
        return hasExactKeys(target, ["kind", "label"])
          && validText(target.label, maxLocatorBytes);
      case "placeholder":
        return hasExactKeys(target, ["kind", "placeholder"])
          && validText(target.placeholder, maxLocatorBytes);
      case "test_id":
        return hasExactKeys(target, ["kind", "testId"])
          && validText(target.testId, maxLocatorBytes);
      default:
        return false;
    }
  };
  const validAction = (action) => {
    if (!isRecord(action) || typeof action.kind !== "string") return false;
    switch (action.kind) {
      case "navigate":
        return hasExactKeys(action, ["kind", "url"]) && validUrl(action.url);
      case "click":
        return hasExactKeys(action, ["kind", "target"]) && validTarget(action.target);
      case "fill":
        return hasExactKeys(action, ["kind", "target", "value"])
          && validTarget(action.target)
          && validText(action.value, maxFillBytes, true);
      case "press":
        return hasExactKeys(action, ["kind", "target", "key"])
          && validTarget(action.target)
          && typeof action.key === "string"
          && pressKeys.has(action.key);
      case "close":
        return hasExactKeys(action, ["kind"]);
      default:
        return false;
    }
  };
  const validOperation = (operation) => {
    if (!isRecord(operation) || typeof operation.kind !== "string") return false;
    switch (operation.kind) {
      case "open":
      case "observe":
      case "cleanup":
        return hasExactKeys(operation, ["kind"]);
      case "act":
        return hasExactKeys(operation, ["kind", "action"]) && validAction(operation.action);
      default:
        return false;
    }
  };
  const trimUtf8 = (text, maxBytes) => {
    const output = [];
    let bytes = 0;
    for (const character of text) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (bytes + characterBytes > maxBytes) break;
      output.push(character);
      bytes += characterBytes;
    }
    return output.join("");
  };
  const capSnapshot = (text) => {
    const originalBytes = Buffer.byteLength(text, "utf8");
    const lines = text.split("\\n");
    const truncated = originalBytes > maxSnapshotBytes || lines.length > maxSnapshotLines;
    if (!truncated) return { kind: "snapshot", text, truncated: false, byteLength: originalBytes };

    const contentLineLimit = Math.max(0, maxSnapshotLines - 1);
    let content = lines.slice(0, contentLineLimit).join("\\n");
    const separator = content.length > 0 ? "\\n" : "";
    const contentBudget = Math.max(
      0,
      maxSnapshotBytes - Buffer.byteLength(separator + truncationMarker, "utf8"),
    );
    content = trimUtf8(content, contentBudget);
    const capped = content.length > 0 ? content + "\\n" + truncationMarker : truncationMarker;
    return {
      kind: "snapshot",
      text: capped,
      truncated: true,
      byteLength: Buffer.byteLength(capped, "utf8"),
    };
  };
  const createLocator = (playwright, target) => {
    switch (target.kind) {
      case "role":
        return playwright.getByRole(target.role, target.name === undefined ? {} : { name: target.name });
      case "text":
        return playwright.getByText(target.text, {});
      case "label":
        return playwright.getByLabel(target.label, {});
      case "placeholder":
        return playwright.getByPlaceholder(target.placeholder, {});
      case "test_id":
        return playwright.getByTestId(target.testId);
      default:
        fail("protocol_failed");
    }
  };

  try {
    const payload = JSON.parse(Buffer.from(${payloadLiteral}, "base64").toString("utf8"));
    if (!hasExactKeys(payload, ["identity", "operation"])) fail("protocol_failed");
    if (!hasExactKeys(payload.identity, ["sessionId", "turnId"])
      || !validText(payload.identity.sessionId, maxIdentityBytes)
      || !validText(payload.identity.turnId, maxIdentityBytes)
      || !validOperation(payload.operation)) {
      fail("protocol_failed");
    }

    const registryKey = Symbol.for("omp-codex-computer.chrome-v1.registry");
    let registry = globalThis[registryKey];
    if (registry === undefined) {
      registry = { protocol, sessions: new Map() };
      Object.defineProperty(globalThis, registryKey, {
        value: registry,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }
    if (!isRecord(registry)
      || registry.protocol !== protocol
      || !(registry.sessions instanceof Map)) {
      fail("protocol_failed");
    }

    const sessionKey = JSON.stringify([payload.identity.sessionId, payload.identity.turnId]);
    const operation = payload.operation;

    if (operation.kind === "cleanup") {
      const session = registry.sessions.get(sessionKey);
      registry.sessions.delete(sessionKey);
      if (session && session.tab !== null) {
        const tab = session.tab;
        session.tab = null;
        phase = "close";
        await tab.close();
      }
      writeEnvelope({ ok: true, result: { kind: "closed" } });
      return;
    }

    let session = registry.sessions.get(sessionKey);
    if (session === undefined) {
      if (operation.kind !== "open") fail("tab_not_open");
      phase = "setup";
      let browser;
      try {
        const { setupBrowserRuntime } = await import(${clientUrlLiteral});
        const agentRuntime = await setupBrowserRuntime();
        browser = await agentRuntime.browsers.get("chrome");
        await browser.nameSession("OMP Chrome");
      } catch {
        fail("unavailable");
      }
      session = { browser, tab: null };
      registry.sessions.set(sessionKey, session);
    }

    if (operation.kind === "open") {
      if (session.tab !== null) fail("tab_already_open");
      phase = "open";
      session.tab = await session.browser.tabs.new();
      writeEnvelope({ ok: true, result: { kind: "opened" } });
      return;
    }

    if (session.tab === null) fail("tab_not_open");
    const tab = session.tab;

    if (operation.kind === "observe") {
      phase = "snapshot";
      const text = await tab.playwright.domSnapshot();
      if (typeof text !== "string") fail("protocol_failed");
      writeEnvelope({ ok: true, result: capSnapshot(text) });
      return;
    }

    const action = operation.action;
    if (action.kind === "close") {
      session.tab = null;
      phase = "close";
      await tab.close();
      writeEnvelope({ ok: true, result: { kind: "closed" } });
      return;
    }

    phase = "action";
    switch (action.kind) {
      case "navigate":
        await tab.goto(action.url);
        break;
      case "click":
        await createLocator(tab.playwright, action.target).click({});
        break;
      case "fill":
        await createLocator(tab.playwright, action.target).fill(action.value, {});
        break;
      case "press":
        await createLocator(tab.playwright, action.target).press(action.key, {});
        break;
      default:
        fail("protocol_failed");
    }

    phase = "post_action_snapshot";
    const text = await tab.playwright.domSnapshot();
    if (typeof text !== "string") fail("protocol_failed");
    writeEnvelope({ ok: true, result: capSnapshot(text) });
  } catch (error) {
    const expectedCode = error !== null && typeof error === "object"
      ? error[expectedFailure]
      : undefined;
    const code = typeof expectedCode === "string"
      ? expectedCode
      : phase === "setup"
        ? "unavailable"
        : phase === "post_action_snapshot"
          ? "snapshot_failed_after_action"
          : "operation_failed";
    writeEnvelope({ ok: false, error: code });
  }
})();`;
}

function readChromeEnvelope(
  response: RawMcpToolCallResponse,
  operation: ChromeOperation,
): ChromeResult {
  if (!isRecord(response) || !Array.isArray(response.content) || response.content.length !== 1) {
    throw new ChromeTransportError("protocol_failed");
  }

  const block = response.content[0];
  assertExactObject(block, ["type", "text"], "response block", "protocol_failed");
  if (block.type !== "text" || typeof block.text !== "string") {
    throw new ChromeTransportError("protocol_failed");
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(block.text);
  } catch {
    throw new ChromeTransportError("protocol_failed");
  }
  if (!isRecord(envelope) || envelope.protocol !== CHROME_PROTOCOL) {
    throw new ChromeTransportError("protocol_failed");
  }

  if (envelope.ok === false) {
    assertExactObject(envelope, ["protocol", "ok", "error"], "error envelope", "protocol_failed");
    if (typeof envelope.error !== "string" || !isProgramErrorCode(envelope.error)) {
      throw new ChromeTransportError("protocol_failed");
    }
    throw new ChromeTransportError(envelope.error);
  }

  assertExactObject(envelope, ["protocol", "ok", "result"], "success envelope", "protocol_failed");
  if (envelope.ok !== true || response.isError === true) {
    throw new ChromeTransportError("protocol_failed");
  }

  const expectedKind = expectedResultKind(operation);
  const result = envelope.result;
  if (expectedKind === "opened") {
    assertExactObject(result, ["kind"], "opened result", "protocol_failed");
    if (result.kind !== "opened") throw new ChromeTransportError("protocol_failed");
    return { kind: "opened" };
  }
  if (expectedKind === "closed") {
    assertExactObject(result, ["kind"], "closed result", "protocol_failed");
    if (result.kind !== "closed") throw new ChromeTransportError("protocol_failed");
    return { kind: "closed" };
  }

  assertExactObject(
    result,
    ["kind", "text", "truncated", "byteLength"],
    "snapshot result",
    "protocol_failed",
  );
  const snapshotKind = result.kind;
  const snapshotText = result.text;
  const snapshotTruncated = result.truncated;
  const snapshotByteLength = result.byteLength;
  if (snapshotKind !== "snapshot"
    || typeof snapshotText !== "string"
    || typeof snapshotTruncated !== "boolean"
    || typeof snapshotByteLength !== "number"
    || !Number.isSafeInteger(snapshotByteLength)
    || snapshotByteLength < 0
    || snapshotByteLength !== Buffer.byteLength(snapshotText, "utf8")) {
    throw new ChromeTransportError("protocol_failed");
  }

  return capSnapshot(snapshotText, snapshotTruncated);
}

function expectedResultKind(operation: ChromeOperation): ChromeResult["kind"] {
  if (operation.kind === "open") return "opened";
  if (operation.kind === "cleanup") return "closed";
  if (operation.kind === "act" && operation.action.kind === "close") return "closed";
  return "snapshot";
}

function capSnapshot(text: string, alreadyTruncated = false): SnapshotResult {
  const originalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  const requiresCap = originalBytes > MAX_SNAPSHOT_BYTES || lines.length > MAX_SNAPSHOT_LINES;
  if (!requiresCap) {
    return {
      kind: "snapshot",
      text,
      truncated: alreadyTruncated,
      byteLength: originalBytes,
    };
  }

  const contentLineLimit = Math.max(0, MAX_SNAPSHOT_LINES - 1);
  let content = lines.slice(0, contentLineLimit).join("\n");
  const separator = content.length > 0 ? "\n" : "";
  const contentBudget = Math.max(
    0,
    MAX_SNAPSHOT_BYTES - Buffer.byteLength(separator + SNAPSHOT_TRUNCATION_MARKER, "utf8"),
  );
  content = trimUtf8(content, contentBudget);
  const capped = content.length > 0
    ? `${content}\n${SNAPSHOT_TRUNCATION_MARKER}`
    : SNAPSHOT_TRUNCATION_MARKER;

  return {
    kind: "snapshot",
    text: capped,
    truncated: true,
    byteLength: Buffer.byteLength(capped, "utf8"),
  };
}

function trimUtf8(text: string, maxBytes: number): string {
  const output: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output.push(character);
    bytes += characterBytes;
  }
  return output.join("");
}

function validateIdentity(identity: unknown): asserts identity is ChromeTurnIdentity {
  assertExactObject(identity, ["sessionId", "turnId"], "identity");
  assertNonEmptyString(identity.sessionId, "sessionId", MAX_IDENTITY_BYTES);
  assertNonEmptyString(identity.turnId, "turnId", MAX_IDENTITY_BYTES);
}

function validateOperation(operation: unknown): asserts operation is ChromeOperation {
  if (!isRecord(operation) || typeof operation.kind !== "string") {
    throw new ChromeTransportError("invalid_request");
  }

  switch (operation.kind) {
    case "open":
    case "observe":
    case "cleanup":
      assertExactObject(operation, ["kind"], "operation");
      return;
    case "act":
      assertExactObject(operation, ["kind", "action"], "operation");
      validateAction(operation.action);
      return;
    default:
      throw new ChromeTransportError("invalid_request");
  }
}

function validateAction(action: unknown): asserts action is ChromeAction {
  if (!isRecord(action) || typeof action.kind !== "string") {
    throw new ChromeTransportError("invalid_request");
  }

  switch (action.kind) {
    case "navigate":
      assertExactObject(action, ["kind", "url"], "action");
      assertSafeUrl(action.url);
      return;
    case "click":
      assertExactObject(action, ["kind", "target"], "action");
      validateLocator(action.target);
      return;
    case "fill":
      assertExactObject(action, ["kind", "target", "value"], "action");
      validateLocator(action.target);
      assertBoundedString(action.value, "fill value", MAX_FILL_BYTES, true);
      return;
    case "press":
      assertExactObject(action, ["kind", "target", "key"], "action");
      validateLocator(action.target);
      if (typeof action.key !== "string" || !PRESS_KEY_LOOKUP.has(action.key)) {
        throw new ChromeTransportError("invalid_request");
      }
      return;
    case "close":
      assertExactObject(action, ["kind"], "action");
      return;
    default:
      throw new ChromeTransportError("invalid_request");
  }
}

function validateLocator(locator: unknown): asserts locator is ChromeLocator {
  if (!isRecord(locator) || typeof locator.kind !== "string") {
    throw new ChromeTransportError("invalid_request");
  }

  switch (locator.kind) {
    case "role":
      assertExactObject(locator, ["kind", "role"], "locator", "invalid_request", ["name"]);
      assertNonEmptyString(locator.role, "role", MAX_LOCATOR_BYTES);
      if (locator.name !== undefined) {
        assertNonEmptyString(locator.name, "role name", MAX_LOCATOR_BYTES);
      }
      return;
    case "text":
      assertExactObject(locator, ["kind", "text"], "locator");
      assertNonEmptyString(locator.text, "text", MAX_LOCATOR_BYTES);
      return;
    case "label":
      assertExactObject(locator, ["kind", "label"], "locator");
      assertNonEmptyString(locator.label, "label", MAX_LOCATOR_BYTES);
      return;
    case "placeholder":
      assertExactObject(locator, ["kind", "placeholder"], "locator");
      assertNonEmptyString(locator.placeholder, "placeholder", MAX_LOCATOR_BYTES);
      return;
    case "test_id":
      assertExactObject(locator, ["kind", "testId"], "locator");
      assertNonEmptyString(locator.testId, "test id", MAX_LOCATOR_BYTES);
      return;
    default:
      throw new ChromeTransportError("invalid_request");
  }
}
function assertSafeUrl(value: unknown): asserts value is string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_URL_LENGTH
    || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new ChromeTransportError("invalid_request");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ChromeTransportError("invalid_request");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== "") {
    throw new ChromeTransportError("invalid_request");
  }
}

function assertExactObject(
  value: unknown,
  requiredKeys: readonly string[],
  _label: string,
  code: ChromeTransportErrorCode = "invalid_request",
  optionalKeys: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new ChromeTransportError(code);

  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || requiredKeys.some((key) => !Object.hasOwn(value, key))) {
    throw new ChromeTransportError(code);
  }
  for (const key of keys) {
    if (typeof key !== "string") throw new ChromeTransportError(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new ChromeTransportError(code);
  }
}

function assertNonEmptyString(value: unknown, label: string, maxBytes: number): asserts value is string {
  assertBoundedString(value, label, maxBytes, false);
}

function assertBoundedString(
  value: unknown,
  _label: string,
  maxBytes: number,
  allowEmpty: boolean,
): asserts value is string {
  if (typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new ChromeTransportError("invalid_request");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isReadyChromeCapabilities(
  capabilities: ChromeCapabilities,
): capabilities is ChromeCapabilities & ReadyChromeCapabilities {
  if (!isRecord(capabilities) || capabilities.status !== "ready") return false;
  return typeof capabilities.pluginVersion === "string"
    && typeof capabilities.appServerVersion === "string"
    && typeof capabilities.clientPath === "string"
    && typeof capabilities.nodeReplServerName === "string";
}

function readSafeUnavailableMessage(capabilities: ChromeCapabilities): string {
  if (isRecord(capabilities)
    && typeof capabilities.message === "string"
    && capabilities.message.length > 0
    && Buffer.byteLength(capabilities.message, "utf8") <= 512) {
    return capabilities.message;
  }
  return ERROR_MESSAGES.unavailable;
}

function isValidThread(thread: unknown): thread is CodexThreadInfo {
  return isRecord(thread)
    && typeof thread.id === "string"
    && thread.id.length > 0
    && typeof thread.sessionId === "string"
    && thread.sessionId.length > 0;
}

function isProgramErrorCode(value: string): value is ProgramErrorCode {
  return value === "unavailable"
    || value === "protocol_failed"
    || value === "tab_already_open"
    || value === "tab_not_open"
    || value === "operation_failed"
    || value === "snapshot_failed_after_action";
}

function sanitizeRequestError(error: unknown): ChromeTransportError {
  if (error instanceof ChromeTransportError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new ChromeTransportError("interrupted");
  }
  return new ChromeTransportError("request_failed");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ChromeTransportError("interrupted");
}
