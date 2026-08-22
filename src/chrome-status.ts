import { AppServerClient } from "./app-server-client";
import {
  evaluateChromeCapabilities,
  getChromeObservedVersions,
  getTrustedChromeVersions,
  type ChromeUnavailableReason,
} from "./chrome-capabilities";
import type { InitializeResponse, McpServerStatusListResponse, PluginListResponse } from "./protocol";

export type ChromeStatusReason = "ready" | "check_failed" | ChromeUnavailableReason;

export interface ChromeStatus {
  status: "ready" | "unavailable";
  reason: ChromeStatusReason;
  message: string;
  supportedPluginVersions: readonly string[];
  supportedAppServerVersions: readonly string[];
  observedPluginVersions: string[];
  observedAppServerVersion?: string;
}

export async function checkChromeStatus(cwd: string): Promise<ChromeStatus> {
  void cwd;
  const client = new AppServerClient({ requestTimeoutMs: 60_000 });
  let initialize: InitializeResponse | undefined;
  let plugins: PluginListResponse | undefined;

  try {
    initialize = await client.requestWithNotification<InitializeResponse>(
      "initialize",
      {
        clientInfo: { name: "omp-codex-computer", version: "0.1.1" },
        capabilities: { experimentalApi: true },
      },
      "initialized",
    );
    const discovery = await Promise.all([
      client.request<PluginListResponse>("plugin/list", {}),
      client.request<McpServerStatusListResponse>("mcpServerStatus/list", {}),
    ]);
    plugins = discovery[0];
    const capabilities = await evaluateChromeCapabilities(initialize, plugins, discovery[1]);
    const versions = getChromeObservedVersions(initialize, plugins);

    if (capabilities.status === "ready") {
      return createStatus({
        status: "ready",
        reason: "ready",
        message: "Chrome transport compatibility is verified; connection is checked when chrome_open runs.",
        observedAppServerVersion: versions.appServerVersion,
        observedPluginVersions: versions.pluginVersions,
      });
    }

    return createStatus({
      status: "unavailable",
      reason: capabilities.reason,
      message: capabilities.message,
      observedAppServerVersion: versions.appServerVersion,
      observedPluginVersions: versions.pluginVersions,
    });
  } catch {
    const versions = getChromeObservedVersions(initialize, plugins);
    return createStatus({
      status: "unavailable",
      reason: "check_failed",
      message: "Chrome status check failed while talking to Codex app-server.",
      observedAppServerVersion: versions.appServerVersion,
      observedPluginVersions: versions.pluginVersions,
    });
  } finally {
    await client.stop();
  }
}

export function formatChromeStatus(status: ChromeStatus): string {
  return [
    `Chrome status: ${status.status}`,
    `Reason: ${status.reason}`,
    status.message,
    "",
    `Supported Chrome plugin versions: ${formatVersions(status.supportedPluginVersions)}`,
    `Observed Chrome plugin versions: ${formatVersions(status.observedPluginVersions)}`,
    `Supported Codex app-server versions: ${formatVersions(status.supportedAppServerVersions)}`,
    `Observed Codex app-server version: ${status.observedAppServerVersion ?? "unknown"}`,
  ].join("\n");
}

function createStatus(input: {
  status: "ready" | "unavailable";
  reason: ChromeStatusReason;
  message: string;
  observedPluginVersions: string[];
  observedAppServerVersion?: string;
}): ChromeStatus {
  const trusted = getTrustedChromeVersions();
  return {
    status: input.status,
    reason: input.reason,
    message: input.message,
    supportedPluginVersions: trusted.pluginVersions,
    supportedAppServerVersions: trusted.appServerVersions,
    observedPluginVersions: input.observedPluginVersions,
    ...(input.observedAppServerVersion
      ? { observedAppServerVersion: input.observedAppServerVersion }
      : {}),
  };
}

function formatVersions(versions: readonly string[]): string {
  return versions.length > 0 ? versions.join(", ") : "unknown";
}
