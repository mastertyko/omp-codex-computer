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
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "click"; target: ChromeLocator }
  | { kind: "fill"; target: ChromeLocator; value: string }
  | { kind: "press"; target: ChromeLocator; key: ChromePressKey }
  | { kind: "select"; target: ChromeLocator; option: string }
  | { kind: "check"; target: ChromeLocator; checked: boolean }
  | { kind: "close" };

export interface ChromeTurnIdentity {
  sessionId: string;
  turnId: string;
}

export type ChromeOperation =
  | { kind: "open"; url?: string }
  | { kind: "observe"; offset?: number }
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
  | "element_not_found"
  | "ambiguous_locator"
  | "locate_failed"
  | "navigation_failed"
  | "operation_failed"
  | "snapshot_failed"
  | "snapshot_failed_after_action"
  | "close_failed"
  | "interrupted"
  | "request_failed";

export type ChromeProgramPhase =
  | "validate"
  | "setup"
  | "open"
  | "navigate"
  | "locate"
  | "action"
  | "snapshot"
  | "post_action_snapshot"
  | "close";

const CHROME_PROTOCOL = "omp-codex-computer/chrome-v1" as const;
const NODE_REPL_EXECUTION_TIMEOUT_MS = 120_000;
// Host-side response ceiling for program executions: the in-repl execution
// timeout plus scheduling margin. Bounds cleanup (which has no AbortSignal)
// and every dispatch against a wedged app-server child.
const EXECUTE_REQUEST_TIMEOUT_MS = NODE_REPL_EXECUTION_TIMEOUT_MS + 30_000;
const MAX_URL_LENGTH = 2048;
const MAX_IDENTITY_BYTES = 128;
const MAX_LOCATOR_BYTES = 1024;
const MAX_FILL_BYTES = 32 * 1024;
const MAX_SNAPSHOT_BYTES = 50 * 1024;
const MAX_SNAPSHOT_LINES = 3000;
const MAX_OBSERVE_OFFSET_LINES = 1_000_000;
const LOCATOR_WAIT_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 30_000;
const MAX_VISIBILITY_PROBES = 8;
const SNAPSHOT_SECOND_ATTEMPT_DELAY_MS = 500;
const SNAPSHOT_TRUNCATION_MARKER = "[Output truncated]";
const PRESS_KEY_LOOKUP = new Set<string>(CHROME_PRESS_KEYS);

const ERROR_MESSAGES: Readonly<Record<ChromeTransportErrorCode, string>> = Object.freeze({
  not_prepared: "Chrome transport is not prepared",
  unavailable: "Chrome is unavailable",
  invalid_request: "Chrome request is invalid",
  protocol_failed: "Chrome transport returned an invalid response",
  tab_already_open: "Chrome already has an open agent tab",
  tab_not_open: "Chrome has no open agent tab",
  element_not_found: "Chrome found no element matching the locator; observe the page and refine the target",
  ambiguous_locator: "Chrome locator matched multiple elements; use a more specific target",
  locate_failed: "Chrome could not resolve the locator; observe the page and try again",
  navigation_failed: "Chrome could not complete the navigation",
  operation_failed: "Chrome operation failed",
  snapshot_failed: "Chrome could not capture the page snapshot; observe again",
  snapshot_failed_after_action: "Chrome action completed but its snapshot is unavailable",
  close_failed: "Chrome could not close the agent tab; the close action may be retried",
  interrupted: "Chrome operation was interrupted",
  request_failed: "Chrome transport request failed",
});

// Codes proven side-effect free: the program either never dispatched an action
// or completed it deterministically. Everything else invalidates the Chrome run.
const ERROR_POISONS: Readonly<Record<ChromeTransportErrorCode, boolean>> = Object.freeze({
  not_prepared: true,
  unavailable: false,
  invalid_request: false,
  protocol_failed: true,
  tab_already_open: false,
  tab_not_open: false,
  element_not_found: false,
  ambiguous_locator: false,
  locate_failed: false,
  navigation_failed: false,
  operation_failed: true,
  snapshot_failed: false,
  snapshot_failed_after_action: false,
  close_failed: false,
  interrupted: true,
  request_failed: true,
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
  | "element_not_found"
  | "ambiguous_locator"
  | "locate_failed"
  | "navigation_failed"
  | "operation_failed"
  | "snapshot_failed"
  | "snapshot_failed_after_action"
  | "close_failed";

export class ChromeTransportError extends Error {
  readonly poisons: boolean;

  constructor(
    readonly code: ChromeTransportErrorCode,
    message = ERROR_MESSAGES[code],
    readonly phase?: ChromeProgramPhase,
  ) {
    super(phase === undefined ? message : `${message} (${phase} phase)`);
    this.name = code === "interrupted" ? "AbortError" : "ChromeTransportError";
    this.poisons = ERROR_POISONS[code];
  }
}

export class ChromeTransport {
  private preparedCwd: string | undefined;
  private preparation: Promise<PreparedChrome> | undefined;

  constructor(
    private readonly client: Pick<AppServerClient, "request">,
    private readonly threads: Pick<CodexThreadManager, "getThread">,
    /** Probe-only trust for /codex-computer trust; production wiring omits it. */
    private readonly options: { extraTrustedAppServerVersions?: readonly string[] } = {},
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
    const preparation = this.discover(cwd, initialize, signal);
    this.preparation = preparation;
    try {
      await preparation;
    } catch (error) {
      // A failed discovery must not pin the transport to a rejected promise;
      // benign unavailability may resolve later in the same agent run.
      if (this.preparation === preparation) {
        this.preparation = undefined;
        this.preparedCwd = undefined;
      }
      throw error;
    }
  }

  async execute(
    cwd: string,
    identity: ChromeTurnIdentity,
    operation: ChromeOperation,
    signal?: AbortSignal,
    onDispatch?: () => void,
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
    // From here the request may reach the child: the caller must treat the
    // outcome as potentially dispatched.
    onDispatch?.();
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
      }, EXECUTE_REQUEST_TIMEOUT_MS, signal);
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
      capabilities = await evaluateChromeCapabilities(
        initialize,
        plugins,
        mcp,
        process.env,
        this.options.extraTrustedAppServerVersions ?? [],
      );
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
  const maxObserveOffsetLiteral = JSON.stringify(MAX_OBSERVE_OFFSET_LINES);
  const locatorWaitTimeoutLiteral = JSON.stringify(LOCATOR_WAIT_TIMEOUT_MS);
  const actionTimeoutLiteral = JSON.stringify(ACTION_TIMEOUT_MS);
  const visibilityProbesLiteral = JSON.stringify(MAX_VISIBILITY_PROBES);
  const snapshotSecondAttemptDelayLiteral = JSON.stringify(SNAPSHOT_SECOND_ATTEMPT_DELAY_MS);
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
  const maxObserveOffset = ${maxObserveOffsetLiteral};
  const locatorWaitTimeoutMs = ${locatorWaitTimeoutLiteral};
  const actionTimeoutMs = ${actionTimeoutLiteral};
  const maxVisibilityProbes = ${visibilityProbesLiteral};
  const snapshotSecondAttemptDelayMs = ${snapshotSecondAttemptDelayLiteral};
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
  const hasFns = (target, names) => (typeof target === "object" || typeof target === "function")
    && target !== null
    && names.every((name) => typeof target[name] === "function");
  const tabContract = ["goto", "back", "forward", "reload", "close"];
  const playwrightContract = ["getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId", "domSnapshot"];
  const locatorContract = ["first", "waitFor", "count", "nth", "isVisible"];
  const actionContract = { click: "click", fill: "fill", press: "press", select: "selectOption", check: "setChecked" };
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
      case "back":
      case "forward":
      case "reload":
        return hasExactKeys(action, ["kind"]);
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
      case "select":
        return hasExactKeys(action, ["kind", "target", "option"])
          && validTarget(action.target)
          && validText(action.option, maxLocatorBytes);
      case "check":
        return hasExactKeys(action, ["kind", "target", "checked"])
          && validTarget(action.target)
          && typeof action.checked === "boolean";
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
        return hasExactKeys(operation, ["kind"], ["url"])
          && (operation.url === undefined || validUrl(operation.url));
      case "observe":
        return hasExactKeys(operation, ["kind"], ["offset"])
          && (operation.offset === undefined
            || (Number.isSafeInteger(operation.offset)
              && operation.offset >= 1
              && operation.offset <= maxObserveOffset));
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
  const resolveSingleMatch = async (locator) => {
    if (!hasFns(locator, locatorContract)) fail("unavailable");
    let attached = true;
    try {
      await locator.first().waitFor({ state: "attached", timeoutMs: locatorWaitTimeoutMs });
    } catch {
      attached = false;
    }
    if (!attached) fail("element_not_found");
    const matches = await locator.count();
    if (matches === 0) fail("element_not_found");
    if (matches === 1) return locator;
    if (matches > maxVisibilityProbes) fail("ambiguous_locator");
    let visibleIndex = -1;
    let visibleCount = 0;
    for (let index = 0; index < matches; index += 1) {
      if (await locator.nth(index).isVisible()) {
        visibleCount += 1;
        visibleIndex = index;
        if (visibleCount > 1) fail("ambiguous_locator");
      }
    }
    if (visibleCount !== 1) fail("ambiguous_locator");
    return locator.nth(visibleIndex);
  };
  const takeSnapshot = async (playwright) => {
    let text;
    try {
      text = await playwright.domSnapshot();
    } catch {
      // domSnapshot is a pure read; one bounded second attempt never repeats an action.
      await new Promise((resolve) => setTimeout(resolve, snapshotSecondAttemptDelayMs));
      text = await playwright.domSnapshot();
    }
    if (typeof text !== "string") fail("protocol_failed");
    return text;
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
      if (session && session.tab !== null) {
        phase = "close";
        await session.tab.close();
        session.tab = null;
      }
      registry.sessions.delete(sessionKey);
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
        if (typeof setupBrowserRuntime !== "function") throw new Error("client contract");
        const agentRuntime = await setupBrowserRuntime();
        if (typeof agentRuntime?.browsers?.get !== "function") throw new Error("client contract");
        browser = await agentRuntime.browsers.get("chrome");
        if (!hasFns(browser, ["nameSession"]) || !hasFns(browser?.tabs, ["new"])) throw new Error("client contract");
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
      const tab = await session.browser.tabs.new();
      if (!hasFns(tab, tabContract) || !hasFns(tab.playwright, playwrightContract)) {
        // Deterministic post-open contract failure: release the fresh tab
        // best-effort, then fail benign before any action can dispatch.
        try { if (hasFns(tab, ["close"])) await tab.close(); } catch { /* best-effort close */ }
        fail("unavailable");
      }
      session.tab = tab;
      if (operation.url === undefined) {
        writeEnvelope({ ok: true, result: { kind: "opened" } });
        return;
      }
      phase = "navigate";
      await tab.goto(operation.url);
      phase = "post_action_snapshot";
      const opened = await takeSnapshot(tab.playwright);
      writeEnvelope({ ok: true, result: capSnapshot(opened) });
      return;
    }

    if (session.tab === null) fail("tab_not_open");
    const tab = session.tab;

    if (operation.kind === "observe") {
      phase = "snapshot";
      let text = await takeSnapshot(tab.playwright);
      if (operation.offset !== undefined && operation.offset > 1) {
        text = text.split("\\n").slice(operation.offset - 1).join("\\n");
      }
      writeEnvelope({ ok: true, result: capSnapshot(text) });
      return;
    }

    const action = operation.action;
    if (action.kind === "close") {
      phase = "close";
      await tab.close();
      session.tab = null;
      writeEnvelope({ ok: true, result: { kind: "closed" } });
      return;
    }

    if (action.kind === "navigate" || action.kind === "back" || action.kind === "forward" || action.kind === "reload") {
      phase = "navigate";
      if (action.kind === "navigate") await tab.goto(action.url);
      else if (action.kind === "back") await tab.back();
      else if (action.kind === "forward") await tab.forward();
      else await tab.reload();
    } else {
      phase = "locate";
      const resolved = await resolveSingleMatch(createLocator(tab.playwright, action.target));
      const actionFn = actionContract[action.kind];
      if (actionFn === undefined || !hasFns(resolved, [actionFn])) fail("unavailable");
      phase = "action";
      switch (action.kind) {
        case "click":
          await resolved.click({ timeoutMs: actionTimeoutMs });
          break;
        case "fill":
          await resolved.fill(action.value, { timeoutMs: actionTimeoutMs });
          break;
        case "press":
          await resolved.press(action.key, { timeoutMs: actionTimeoutMs });
          break;
        case "select":
          await resolved.selectOption({ label: action.option }, { timeoutMs: actionTimeoutMs });
          break;
        case "check":
          await resolved.setChecked(action.checked, { timeoutMs: actionTimeoutMs });
          break;
        default:
          fail("protocol_failed");
      }
    }

    phase = "post_action_snapshot";
    const text = await takeSnapshot(tab.playwright);
    writeEnvelope({ ok: true, result: capSnapshot(text) });
  } catch (error) {
    const expectedCode = error !== null && typeof error === "object"
      ? error[expectedFailure]
      : undefined;
    const code = typeof expectedCode === "string"
      ? expectedCode
      : phase === "setup"
        ? "unavailable"
        : phase === "navigate"
          ? "navigation_failed"
          : phase === "snapshot"
            ? "snapshot_failed"
            : phase === "close"
              ? "close_failed"
              : phase === "post_action_snapshot"
                ? "snapshot_failed_after_action"
                : phase === "locate"
                  ? "locate_failed"
                  : "operation_failed";
    writeEnvelope({ ok: false, error: code, phase });
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
    assertExactObject(envelope, ["protocol", "ok", "error", "phase"], "error envelope", "protocol_failed");
    if (typeof envelope.error !== "string" || !isProgramErrorCode(envelope.error)
      || typeof envelope.phase !== "string" || !isProgramPhase(envelope.phase)) {
      throw new ChromeTransportError("protocol_failed");
    }
    throw new ChromeTransportError(envelope.error, undefined, envelope.phase);
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
  if (operation.kind === "open") return operation.url === undefined ? "opened" : "snapshot";
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
      assertExactObject(operation, ["kind"], "operation", "invalid_request", ["url"]);
      if (operation.url !== undefined) assertSafeUrl(operation.url);
      return;
    case "observe":
      assertExactObject(operation, ["kind"], "operation", "invalid_request", ["offset"]);
      if (operation.offset !== undefined) assertObserveOffset(operation.offset);
      return;
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
    case "back":
    case "forward":
    case "reload":
      assertExactObject(action, ["kind"], "action");
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
    case "select":
      assertExactObject(action, ["kind", "target", "option"], "action");
      validateLocator(action.target);
      assertNonEmptyString(action.option, "select option", MAX_LOCATOR_BYTES);
      return;
    case "check":
      assertExactObject(action, ["kind", "target", "checked"], "action");
      validateLocator(action.target);
      if (typeof action.checked !== "boolean") {
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

function assertObserveOffset(value: unknown): asserts value is number {
  if (typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_OBSERVE_OFFSET_LINES) {
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
    || value === "element_not_found"
    || value === "ambiguous_locator"
    || value === "locate_failed"
    || value === "navigation_failed"
    || value === "operation_failed"
    || value === "snapshot_failed"
    || value === "snapshot_failed_after_action"
    || value === "close_failed";
}

function isProgramPhase(value: string): value is ChromeProgramPhase {
  return value === "validate"
    || value === "setup"
    || value === "open"
    || value === "navigate"
    || value === "locate"
    || value === "action"
    || value === "snapshot"
    || value === "post_action_snapshot"
    || value === "close";
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
