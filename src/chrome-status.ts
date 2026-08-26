import { AppServerClient } from "./app-server-client";
import {
  evaluateChromeCapabilities,
  getChromeObservedVersions,
  type ChromeUnavailableReason,
} from "./chrome-capabilities";
import { getTrustedAppServerVersions, loadPersistedAppServerVersions } from "./chrome-trust";
import { CLIENT_INFO } from "./client-info";
import type { InitializeResponse, McpServerStatusListResponse, PluginListResponse } from "./protocol";

export type ChromeStatusReason = "ready" | "check_failed" | ChromeUnavailableReason;

export interface ChromeStatus {
  status: "ready" | "unavailable";
  reason: ChromeStatusReason;
  message: string;
  trustedAppServerVersions: readonly string[];
  observedPluginVersions: string[];
  observedAppServerVersion?: string;
}

export async function checkChromeStatus(cwd: string): Promise<ChromeStatus> {
  void cwd;
  const trustedAppServerVersions = getTrustedAppServerVersions(
    process.env,
    await loadPersistedAppServerVersions(process.env),
  );
  const client = new AppServerClient({ requestTimeoutMs: 60_000 });
  let initialize: InitializeResponse | undefined;
  let plugins: PluginListResponse | undefined;

  try {
    initialize = await client.requestWithNotification<InitializeResponse>(
      "initialize",
      {
        clientInfo: CLIENT_INFO,
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
        trustedAppServerVersions,
        observedAppServerVersion: versions.appServerVersion,
        observedPluginVersions: versions.pluginVersions,
      });
    }

    return createStatus({
      status: "unavailable",
      reason: capabilities.reason,
      message: capabilities.message,
      trustedAppServerVersions,
      observedAppServerVersion: versions.appServerVersion,
      observedPluginVersions: versions.pluginVersions,
    });
  } catch {
    const versions = getChromeObservedVersions(initialize, plugins);
    return createStatus({
      status: "unavailable",
      reason: "check_failed",
      message: "Chrome status check failed while talking to Codex app-server.",
      trustedAppServerVersions,
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
    `Trusted Codex app-server versions: ${formatVersions(status.trustedAppServerVersions)}`,
    `Observed Codex app-server version: ${status.observedAppServerVersion ?? "unknown"}`,
    `Observed Chrome plugin versions: ${formatVersions(status.observedPluginVersions)}`,
  ].join("\n");
}

function createStatus(input: {
  status: "ready" | "unavailable";
  reason: ChromeStatusReason;
  message: string;
  trustedAppServerVersions: readonly string[];
  observedPluginVersions: string[];
  observedAppServerVersion?: string;
}): ChromeStatus {
  return {
    status: input.status,
    reason: input.reason,
    message: input.message,
    trustedAppServerVersions: input.trustedAppServerVersions,
    observedPluginVersions: input.observedPluginVersions,
    ...(input.observedAppServerVersion
      ? { observedAppServerVersion: input.observedAppServerVersion }
      : {}),
  };
}

function formatVersions(versions: readonly string[]): string {
  return versions.length > 0 ? versions.join(", ") : "unknown";
}
