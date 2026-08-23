import type { AppServerClient } from "./app-server-client";
import {
  DEFAULT_DIRECT_MCP_SERVER_NAME,
  evaluateComputerUseCapabilities,
  type ComputerUseCapabilities,
} from "./computer-use-capabilities";
import { COMPUTER_USE_MCP_TOOL_NAMES } from "./computer-use-tools";
import { logDebug } from "./log";
import type { McpServerStatusListResponse, PluginListResponse } from "./protocol";
import type { CodexThreadManager } from "./thread-manager";

export type ComputerUseRoute = "sky" | "direct";
export type SkyComputerUsePhase = "bootstrap" | "dispatch";

type ComputerUseMcpToolName = (typeof COMPUTER_USE_MCP_TOOL_NAMES)[number];

export interface ComputerUseTransportOptions {
  directMcpServerName?: string;
}

export interface ComputerUseDiscovery {
  plugins: PluginListResponse;
  mcp: McpServerStatusListResponse;
}

export interface RawComputerUseToolCallResponse {
  route: ComputerUseRoute;
  content: unknown;
  structuredContent?: unknown;
  _meta?: unknown;
  isError?: boolean | null;
}

interface RawMcpToolCallResponse {
  content: unknown;
  structuredContent?: unknown;
  _meta?: unknown;
  isError?: boolean | null;
}

interface SelectedSkyRoute {
  kind: "sky";
  nodeReplServerName: string;
}

interface SelectedDirectRoute {
  kind: "direct";
  serverName: string;
}

type SelectedRoute = SelectedSkyRoute | SelectedDirectRoute;

interface SkySuccessEnvelope {
  protocol: typeof SKY_ENVELOPE_PROTOCOL;
  ok: true;
  phase: SkyComputerUsePhase;
  result?: unknown;
  warning?: string;
}

interface SkyErrorDetails {
  name: string;
  message: string;
  code?: number;
  errorName?: string;
  requestType?: string;
}

const SKY_ENVELOPE_PROTOCOL = "omp-codex-computer/sky-v1" as const;
const SCREENSHOT_WARNING = "Warning: Computer Use returned a screenshot that could not be read.";
const NODE_REPL_EXECUTION_TIMEOUT_MS = 120_000;
const TOOL_NAME_LOOKUP = Object.fromEntries(
  COMPUTER_USE_MCP_TOOL_NAMES.map((toolName) => [toolName, true] as const),
) as Record<string, true>;

export class SkyComputerUseError extends Error {
  readonly route = "sky" as const;
  readonly phase: SkyComputerUsePhase;
  readonly code?: number;
  readonly errorName?: string;
  readonly requestType?: string;

  constructor(phase: SkyComputerUsePhase, details: SkyErrorDetails) {
    super(details.message);
    this.name = details.name;
    this.phase = phase;
    if (details.code !== undefined) this.code = details.code;
    if (details.errorName !== undefined) this.errorName = details.errorName;
    if (details.requestType !== undefined) this.requestType = details.requestType;
  }

  withMessage(message: string): SkyComputerUseError {
    return new SkyComputerUseError(this.phase, {
      name: this.name,
      message,
      code: this.code,
      errorName: this.errorName,
      requestType: this.requestType,
    });
  }
}

export class SkyComputerUseProtocolError extends Error {
  readonly route = "sky" as const;

  constructor(message: string) {
    super(message);
    this.name = "SkyComputerUseProtocolError";
  }
}


export class ComputerUseTransport {
  private readonly directMcpServerName: string;
  private selectionPromise: Promise<SelectedRoute> | undefined;
  private generation = 0;

  constructor(
    private readonly client: Pick<AppServerClient, "request">,
    private readonly threads: Pick<CodexThreadManager, "getThreadId">,
    options: ComputerUseTransportOptions = {},
  ) {
    this.directMcpServerName = options.directMcpServerName ?? DEFAULT_DIRECT_MCP_SERVER_NAME;
  }

  reset(): void {
    this.selectionPromise = undefined;
    this.generation++;
  }

  async prepare(
    cwd: string,
    discovery?: ComputerUseDiscovery,
    signal?: AbortSignal,
  ): Promise<ComputerUseRoute> {
    return (await this.getSelectedRoute(cwd, discovery, signal)).kind;
  }

  async callTool(
    cwd: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RawComputerUseToolCallResponse> {
    assertAllowedTool(tool);
    return this.callToolWithSelection(cwd, tool, args, signal, true);
  }

  private async callToolWithSelection(
    cwd: string,
    tool: ComputerUseMcpToolName,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    mayReselect: boolean,
  ): Promise<RawComputerUseToolCallResponse> {
    const route = await this.getSelectedRoute(cwd, undefined, signal);
    if (route.kind === "direct") return this.callDirect(route, cwd, tool, args, signal);

    try {
      return await this.callSky(route, cwd, tool, args, signal);
    } catch (error) {
      if (!mayReselect
        || !(error instanceof SkyComputerUseError)
        || error.phase !== "bootstrap"
        || error.code === -10012) throw error;

      logDebug("computer-use.transport.reselect", {
        route: route.kind,
        tool,
        errorCode: error.code,
      });
      this.reset();
      return this.callToolWithSelection(cwd, tool, args, signal, false);
    }
  }

  private getSelectedRoute(
    cwd: string,
    discovery?: ComputerUseDiscovery,
    signal?: AbortSignal,
  ): Promise<SelectedRoute> {
    if (this.selectionPromise) return this.selectionPromise;

    const generation = this.generation;
    const selectionPromise = this.selectRoute(cwd, discovery, signal).catch((error: unknown) => {
      if (this.generation === generation && this.selectionPromise === selectionPromise) {
        this.selectionPromise = undefined;
      }
      throw error;
    });
    this.selectionPromise = selectionPromise;
    return selectionPromise;
  }

  private async selectRoute(
    cwd: string,
    discovery?: ComputerUseDiscovery,
    signal?: AbortSignal,
  ): Promise<SelectedRoute> {
    let plugins: PluginListResponse;
    let mcp: McpServerStatusListResponse;
    if (discovery) {
      ({ plugins, mcp } = discovery);
    } else {
      [plugins, mcp] = await Promise.all([
        this.client.request<PluginListResponse>("plugin/list", {}, undefined, signal),
        this.client.request<McpServerStatusListResponse>("mcpServerStatus/list", {}, undefined, signal),
      ]);
    }
    const capabilities = evaluateCapabilitiesForDirectServer(plugins, mcp, this.directMcpServerName);

    if (capabilities.preferredRoute === "sky") {
      try {
        const skyRoute: SelectedSkyRoute = {
          kind: "sky",
          nodeReplServerName: capabilities.nodeRepl.name,
        };
        await this.bootstrapSky(skyRoute, cwd, signal);
        logDebug("computer-use.transport.selected", { route: skyRoute.kind });
        return skyRoute;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (getNumericErrorCode(error) === -10012 || !capabilities.direct.complete) throw error;

        logDebug("computer-use.transport.bootstrap-fallback", {
          route: "direct",
          errorCode: getNumericErrorCode(error),
        });
        return { kind: "direct", serverName: capabilities.direct.name };
      }
    }

    if (capabilities.preferredRoute === "direct") {
      logDebug("computer-use.transport.selected", { route: "direct" });
      return { kind: "direct", serverName: capabilities.direct.name };
    }

    throw unavailableTransportError(capabilities);
  }

  private async bootstrapSky(route: SelectedSkyRoute, cwd: string, signal?: AbortSignal): Promise<void> {
    const threadId = await this.threads.getThreadId(cwd);
    const response = await this.client.request<RawMcpToolCallResponse>("mcpServer/tool/call", {
      server: route.nodeReplServerName,
      threadId,
      tool: "js",
      arguments: {
        code: buildSkyProgram(),
        title: "Computer Use bootstrap",
        timeout_ms: NODE_REPL_EXECUTION_TIMEOUT_MS,
      },
    }, 0, signal);
    readSkyEnvelope(response, "bootstrap");
  }

  private async callDirect(
    route: SelectedDirectRoute,
    cwd: string,
    tool: ComputerUseMcpToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RawComputerUseToolCallResponse> {
    const threadId = await this.threads.getThreadId(cwd);
    const response = await this.client.request<RawMcpToolCallResponse>("mcpServer/tool/call", {
      server: route.serverName,
      threadId,
      tool,
      arguments: args,
    }, undefined, signal);

    return { ...response, route: "direct" };
  }

  private async callSky(
    route: SelectedSkyRoute,
    cwd: string,
    tool: ComputerUseMcpToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RawComputerUseToolCallResponse> {
    const adaptedArgs = adaptSkyArguments(tool, args);
    const payload = Buffer.from(JSON.stringify({ tool, args: adaptedArgs }), "utf8").toString("base64");
    const threadId = await this.threads.getThreadId(cwd);
    const response = await this.client.request<RawMcpToolCallResponse>("mcpServer/tool/call", {
      server: route.nodeReplServerName,
      threadId,
      tool: "js",
      arguments: {
        code: buildSkyProgram(payload),
        title: `Computer Use: ${tool}`,
        timeout_ms: NODE_REPL_EXECUTION_TIMEOUT_MS,
      },
    }, 0, signal);
    const envelope = readSkyEnvelope(response, "dispatch");

    return normalizeSkyResponse(tool, envelope, response);
  }
}


function evaluateCapabilitiesForDirectServer(
  plugins: PluginListResponse,
  mcp: McpServerStatusListResponse,
  directMcpServerName: string,
): ComputerUseCapabilities {
  if (directMcpServerName === DEFAULT_DIRECT_MCP_SERVER_NAME) {
    return evaluateComputerUseCapabilities(plugins, mcp);
  }

  const directServer = mcp.data.find((entry) => entry.name === directMcpServerName);
  const normalizedData = mcp.data.filter((entry) => entry.name !== DEFAULT_DIRECT_MCP_SERVER_NAME);
  if (directServer) normalizedData.push({ ...directServer, name: DEFAULT_DIRECT_MCP_SERVER_NAME });

  const capabilities = evaluateComputerUseCapabilities(plugins, { ...mcp, data: normalizedData });
  capabilities.direct.name = directMcpServerName;
  return capabilities;
}

function unavailableTransportError(capabilities: ComputerUseCapabilities): Error {
  const skyMissing: string[] = [];
  if (!capabilities.pluginMatch) skyMissing.push("installed official computer-use plugin");
  else {
    if (!capabilities.pluginMatch.plugin.installed) skyMissing.push("installed plugin");
    if (!capabilities.pluginMatch.plugin.enabled) skyMissing.push("enabled plugin");
  }
  if (!capabilities.nodeRepl.complete) {
    skyMissing.push(`${capabilities.nodeRepl.name}/${capabilities.nodeRepl.missingToolNames.join(",")}`);
  }

  const pluginReady = !!capabilities.pluginMatch?.plugin.installed && !!capabilities.pluginMatch.plugin.enabled;
  const directMissing = !pluginReady
    ? "installed and enabled official computer-use plugin"
    : capabilities.direct.missingToolNames.length > 0
      ? capabilities.direct.missingToolNames.join(", ")
      : "server unavailable";
  return new Error(
    `Computer Use transport is unavailable: Sky is missing ${skyMissing.join(", ") || "required capabilities"}; `
      + `direct MCP server ${capabilities.direct.name} is missing ${directMissing}.`,
  );
}

function assertAllowedTool(tool: string): asserts tool is ComputerUseMcpToolName {
  if (Object.hasOwn(TOOL_NAME_LOOKUP, tool)) return;
  throw new Error(`Unsupported Computer Use tool: ${tool}`);
}


function adaptSkyArguments(
  tool: ComputerUseMcpToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (tool) {
    case "list_apps":
      return {};
    case "get_app_state":
      return copyDefinedArguments(args, ["app", "disableDiff"]);
    case "click": {
      const adapted = copyDefinedArguments(args, ["app", "x", "y", "click_count", "mouse_button"]);
      copySkyElementIndex(args, adapted, false);
      return adapted;
    }
    case "type_text":
      return copyDefinedArguments(args, ["app", "text"]);
    case "press_key":
      return copyDefinedArguments(args, ["app", "key"]);
    case "scroll": {
      const adapted = copyDefinedArguments(args, ["app", "direction", "pages"]);
      copySkyElementIndex(args, adapted, true);
      return adapted;
    }
    case "drag":
      return copyDefinedArguments(args, ["app", "from_x", "from_y", "to_x", "to_y"]);
    case "set_value": {
      const adapted = copyDefinedArguments(args, ["app", "value"]);
      copySkyElementIndex(args, adapted, true);
      return adapted;
    }
    case "select_text": {
      const adapted = copyDefinedArguments(args, ["app", "text", "prefix", "suffix"]);
      copySkyElementIndex(args, adapted, true);
      if (Object.hasOwn(args, "selection") && args.selection !== undefined) {
        adapted.selection_type = args.selection;
      }
      return adapted;
    }
    case "perform_secondary_action": {
      const adapted = copyDefinedArguments(args, ["app", "action"]);
      copySkyElementIndex(args, adapted, true);
      return adapted;
    }
    case "paste":
      return copyDefinedArguments(args, ["app", "format", "text"]);
  }
}

function copyDefinedArguments(
  args: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const adapted: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(args, key) && args[key] !== undefined) adapted[key] = args[key];
  }
  return adapted;
}

function copySkyElementIndex(
  args: Record<string, unknown>,
  adapted: Record<string, unknown>,
  required: boolean,
): void {
  const rawElementIndex = Object.hasOwn(args, "element_index") ? args.element_index : undefined;
  if (rawElementIndex === undefined) {
    if (required) throw new Error("Computer Use element_index is required for this Sky action");
    return;
  }
  if (typeof rawElementIndex !== "string" || !/^[0-9]+$/.test(rawElementIndex)) {
    throw new Error("Computer Use element_index must be a base-10 integer string for Sky");
  }

  const elementIndex = Number(rawElementIndex);
  if (!Number.isSafeInteger(elementIndex)) {
    throw new Error("Computer Use element_index is outside the safe integer range for Sky");
  }
  adapted.element_index = elementIndex;
}

function buildSkyProgram(payloadBase64?: string): string {
  const protocolLiteral = JSON.stringify(SKY_ENVELOPE_PROTOCOL);
  const methodNamesLiteral = JSON.stringify(COMPUTER_USE_MCP_TOOL_NAMES);
  const payloadLiteral = payloadBase64 === undefined ? undefined : JSON.stringify(payloadBase64);
  const dispatch = payloadLiteral === undefined
    ? `writeEnvelope({ ok: true, phase });`
    : buildSkyDispatchSource(payloadLiteral);

  return `await (async () => {
  const protocol = ${protocolLiteral};
  const requiredMethods = ${methodNamesLiteral};
  let phase = "bootstrap";
  const writeEnvelope = (value) => nodeRepl.write(JSON.stringify({ protocol, ...value }));
  const serializeError = (error) => {
    const object = error !== null && typeof error === "object" ? error : undefined;
    const serialized = {
      name: object && typeof Reflect.get(object, "name") === "string" ? Reflect.get(object, "name") : "Error",
      message: object && typeof Reflect.get(object, "message") === "string" ? Reflect.get(object, "message") : String(error),
    };
    const code = object ? Reflect.get(object, "code") : undefined;
    const errorName = object ? Reflect.get(object, "errorName") : undefined;
    const requestType = object ? Reflect.get(object, "requestType") : undefined;
    if (typeof code === "number" && Number.isFinite(code)) serialized.code = code;
    if (typeof errorName === "string") serialized.errorName = errorName;
    if (typeof requestType === "string") serialized.requestType = requestType;
    return serialized;
  };

  try {
    const skyModule = await import("@oai/sky");
    const sky = skyModule && typeof skyModule === "object" ? skyModule.sky : undefined;
    if (!sky || typeof sky !== "object" || sky.target !== "mac") {
      throw new Error("Bundled @oai/sky did not provide the mac target");
    }
    for (const method of requiredMethods) {
      if (typeof sky[method] !== "function") throw new Error("Computer Use Sky runtime is missing " + method);
    }
    ${dispatch}
  } catch (error) {
    writeEnvelope({ ok: false, phase, error: serializeError(error) });
  }
})();`;
}

function buildSkyDispatchSource(payloadLiteral: string): string {
  return `phase = "dispatch";
    const payload = JSON.parse(Buffer.from(${payloadLiteral}, "base64").toString("utf8"));
    if (!payload || typeof payload !== "object" || !requiredMethods.includes(payload.tool)) {
      throw new Error("Computer Use Sky payload named an unsupported tool");
    }
    const args = payload.args && typeof payload.args === "object" && !Array.isArray(payload.args) ? payload.args : {};
    let result;
    switch (payload.tool) {
      case "list_apps": result = await sky.list_apps(); break;
      case "get_app_state": result = await sky.get_app_state(args); break;
      case "click": result = await sky.click(args); break;
      case "type_text": result = await sky.type_text(args); break;
      case "press_key": result = await sky.press_key(args); break;
      case "scroll": result = await sky.scroll(args); break;
      case "drag": result = await sky.drag(args); break;
      case "set_value": result = await sky.set_value(args); break;
      case "select_text": result = await sky.select_text(args); break;
      case "perform_secondary_action": result = await sky.perform_secondary_action(args); break;
      case "paste": result = await sky.paste(args); break;
      default: throw new Error("Computer Use Sky payload named an unsupported tool");
    }

    if (payload.tool === "get_app_state") {
      if (!result || typeof result !== "object" || typeof result.text !== "string") {
        throw new Error("Computer Use Sky returned an invalid app state");
      }
      let warning;
      if (result.screenshot !== null && result.screenshot !== undefined) {
        try {
          if (typeof result.screenshot !== "object" || typeof result.screenshot.url !== "string") {
            throw new Error("invalid screenshot descriptor");
          }
          const screenshotUrl = result.screenshot.url;
          if (screenshotUrl.startsWith("data:image/")) {
            await nodeRepl.emitImage(screenshotUrl);
          } else {
            const parsedScreenshotUrl = new URL(screenshotUrl);
            if (parsedScreenshotUrl.protocol !== "file:") throw new Error("screenshot URL is not local");
            // This generated program runs in node_repl, where static imports are unavailable.
            const fs = await import("node:fs/promises");
            const url = await import("node:url");
            const bytes = await fs.readFile(url.fileURLToPath(parsedScreenshotUrl));
            let mimeType;
            if (bytes.length >= 8
              && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
              && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
              mimeType = "image/png";
            } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
              mimeType = "image/jpeg";
            } else {
              throw new Error("unsupported screenshot image format");
            }
            await nodeRepl.emitImage({ bytes, mimeType });
          }
        } catch {
          warning = ${JSON.stringify(SCREENSHOT_WARNING)};
        }
      }
      writeEnvelope({
        ok: true,
        phase,
        result: {
          app: typeof result.app === "string" ? result.app : args.app,
          text: result.text,
        },
        ...(warning ? { warning } : {}),
      });
      return;
    }

    writeEnvelope({ ok: true, phase, result: payload.tool === "list_apps" ? result : null });`;
}

function readSkyEnvelope(
  response: RawMcpToolCallResponse,
  expectedSuccessPhase: SkyComputerUsePhase,
): SkySuccessEnvelope {
  if (!Array.isArray(response.content)) {
    throw new SkyComputerUseProtocolError("Sky transport returned content without a protocol envelope");
  }

  const envelopes: Record<string, unknown>[] = [];
  for (const block of response.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;

    try {
      const parsed: unknown = JSON.parse(block.text);
      if (isRecord(parsed) && parsed.protocol === SKY_ENVELOPE_PROTOCOL) envelopes.push(parsed);
    } catch {
      continue;
    }
  }

  if (envelopes.length !== 1) {
    throw new SkyComputerUseProtocolError(
      envelopes.length === 0
        ? "Sky transport response is missing its protocol envelope"
        : "Sky transport response contains multiple protocol envelopes",
    );
  }

  const envelope = envelopes[0];
  const phase = envelope.phase;
  if (phase !== "bootstrap" && phase !== "dispatch") {
    throw new SkyComputerUseProtocolError("Sky transport envelope has an invalid phase");
  }

  if (envelope.ok === false) {
    throw new SkyComputerUseError(phase, readSkyErrorDetails(envelope.error));
  }
  if (envelope.ok !== true || phase !== expectedSuccessPhase || response.isError) {
    throw new SkyComputerUseProtocolError("Sky transport returned an invalid success envelope");
  }
  if (envelope.warning !== undefined && typeof envelope.warning !== "string") {
    throw new SkyComputerUseProtocolError("Sky transport envelope has an invalid warning");
  }

  return {
    protocol: SKY_ENVELOPE_PROTOCOL,
    ok: true,
    phase,
    result: envelope.result,
    ...(typeof envelope.warning === "string" ? { warning: envelope.warning } : {}),
  };
}

function readSkyErrorDetails(value: unknown): SkyErrorDetails {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.message !== "string") {
    throw new SkyComputerUseProtocolError("Sky transport returned an invalid error envelope");
  }

  const details: SkyErrorDetails = { name: value.name, message: value.message };
  if (typeof value.code === "number" && Number.isFinite(value.code)) details.code = value.code;
  if (typeof value.errorName === "string") details.errorName = value.errorName;
  if (typeof value.requestType === "string") details.requestType = value.requestType;
  return details;
}

function summarizeSkyAppList(value: unknown[]): Record<string, unknown>[] {
  const apps: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) continue;

    const app: Record<string, unknown> = { id: entry.id.trim() };
    if (typeof entry.displayName === "string") app.displayName = entry.displayName;
    if (typeof entry.isRunning === "boolean") app.isRunning = entry.isRunning;
    apps.push(app);
  }
  return apps;
}


function normalizeSkyResponse(
  tool: ComputerUseMcpToolName,
  envelope: SkySuccessEnvelope,
  response: RawMcpToolCallResponse,
): RawComputerUseToolCallResponse {
  if (tool === "list_apps") {
    if (!Array.isArray(envelope.result)) {
      throw new SkyComputerUseProtocolError("Sky list_apps returned a non-array result");
    }
    const modelVisibleApps = summarizeSkyAppList(envelope.result);
    return withMeta({
      route: "sky",
      content: [{ type: "text", text: JSON.stringify(modelVisibleApps, null, 2) }],
      structuredContent: envelope.result,
    }, response._meta);
  }

  if (tool === "get_app_state") {
    if (!isRecord(envelope.result) || typeof envelope.result.text !== "string") {
      throw new SkyComputerUseProtocolError("Sky get_app_state returned an invalid result");
    }

    const content: unknown[] = [{ type: "text", text: envelope.result.text }];
    if (envelope.warning) content.push({ type: "text", text: envelope.warning });
    content.push(...readImageBlocks(response.content));
    return withMeta({ route: "sky", content }, response._meta);
  }

  return withMeta({
    route: "sky",
    content: [{ type: "text", text: "(no content)" }],
  }, response._meta);
}

function withMeta(
  response: RawComputerUseToolCallResponse,
  meta: unknown,
): RawComputerUseToolCallResponse {
  if (meta !== undefined) response._meta = meta;
  return response;
}

function readImageBlocks(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => isRecord(block) && block.type === "image" && typeof block.data === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getNumericErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}
