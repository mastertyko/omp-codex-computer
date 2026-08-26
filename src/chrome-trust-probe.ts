import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AppServerClient } from "./app-server-client";
import { ChromeRuntime } from "./chrome-runtime";
import { checkChromeStatus, formatChromeStatus } from "./chrome-status";
import { ChromeTransport, ChromeTransportError } from "./chrome-transport";
import { persistTrustedAppServerVersion } from "./chrome-trust";
import { CodexThreadManager } from "./thread-manager";

const PROBE_URL = "https://example.com/";
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Validate the installed stack for /codex-computer trust: static gate check,
 * then a live open/observe/action/close/cleanup smoke with a probe-only trust
 * override. The observed app-server version is persisted only after every
 * probe step succeeds, so a crash or failure never widens trust.
 */
export async function runChromeTrustProbe(cwd: string): Promise<string> {
  const status = await checkChromeStatus(cwd);
  const candidate = status.observedAppServerVersion;
  if (!candidate) {
    return `Chrome trust probe aborted: the Codex app-server version could not be observed.\n\n${formatChromeStatus(status)}`;
  }
  if (status.status === "unavailable" && status.reason !== "unsupported_app_server_version") {
    return `Chrome trust probe aborted: the installed stack fails a non-version check that trusting a version cannot fix.\n\n${formatChromeStatus(status)}`;
  }

  const steps = await runLiveProbe(cwd, candidate);
  if (steps.failure !== undefined) {
    return [
      `Chrome trust probe failed for Codex app-server ${candidate}; nothing was trusted.`,
      `Completed steps: ${steps.completed.length > 0 ? steps.completed.join(", ") : "none"}.`,
      steps.failure,
    ].join("\n");
  }

  const alreadyTrusted = status.trustedAppServerVersions.includes(candidate);
  if (alreadyTrusted) {
    return [
      `Chrome trust probe passed for Codex app-server ${candidate} (${steps.completed.join(", ")}).`,
      "The version was already trusted; nothing was persisted.",
    ].join("\n");
  }

  const path = await persistTrustedAppServerVersion(candidate);
  return [
    `Chrome trust probe passed for Codex app-server ${candidate} (${steps.completed.join(", ")}).`,
    `Persisted the version to ${path}; remove it with /codex-computer trust clear.`,
  ].join("\n");
}

async function runLiveProbe(
  cwd: string,
  candidate: string,
): Promise<{ completed: string[]; failure?: string }> {
  const client = new AppServerClient({ requestTimeoutMs: PROBE_TIMEOUT_MS });
  const threads = new CodexThreadManager(client);
  const transport = new ChromeTransport(client, threads, {
    extraTrustedAppServerVersions: [candidate],
  });
  const runtime = new ChromeRuntime({ client, threads, transport });
  const probeSessionId = `chrome-trust-probe-${randomUUID()}`;
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => probeSessionId },
  } as unknown as ExtensionContext;

  const completed: string[] = [];
  let failure: string | undefined;
  try {
    await runtime.beginAgent(ctx);
    await runtime.open(ctx, PROBE_URL);
    completed.push("open");
    await runtime.observe(ctx);
    completed.push("observe");
    await runtime.act(ctx, { kind: "reload" });
    completed.push("reload");
    await runtime.act(ctx, { kind: "close" });
    completed.push("close");
  } catch (error) {
    failure = describeProbeError(error);
  } finally {
    try {
      await runtime.endAgent();
      if (failure === undefined) completed.push("cleanup");
    } catch (error) {
      failure ??= describeProbeError(error);
    }
  }
  return failure === undefined ? { completed } : { completed, failure };
}

/** Only transport errors carry vetted static messages; everything else is generic. */
function describeProbeError(error: unknown): string {
  if (error instanceof ChromeTransportError) return `Failure: ${error.message}`;
  return "Failure: the probe could not complete against Codex app-server.";
}
