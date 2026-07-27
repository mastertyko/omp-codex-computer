export interface RegisteredAppTarget {
  displayName: string;
  appPath?: string;
  bundleId?: string;
  upstreamAddress: string;
}

export type AppTargetResolution =
  | {
      status: "resolved";
      requested: string;
      target: ResolvedAppTarget;
      registeredAppCount: number;
    }
  | {
      status: "ambiguous";
      requested: string;
      candidates: ResolvedAppTarget[];
      registeredAppCount: number;
    }
  | {
      status: "unsupported";
      requested: string;
      unsupportedKind: "pid" | "raw_executable";
      registeredAppCount: number;
    }
  | {
      status: "unresolved";
      requested: string;
      candidates: ResolvedAppTarget[];
      registeredAppCount: number;
    };

export interface ResolvedAppTarget {
  kind: "registered_app" | "app_id" | "app_path" | "bundle_id" | "display_name";
  requested: string;
  displayName: string;
  appPath?: string;
  bundleId?: string;
  upstreamAddress: string;
  confidence: "exact" | "candidate";
}

const APP_FIELD_SEPARATOR = " — ";
const STATUS_SUFFIX_PATTERN = /\s+\[[^\]]*\]\s*$/;
const APP_BUNDLE_PATTERN = /\.app(?:\/)?$/i;
const PID_PATTERN = /^(?:pid:)?\d+$/i;

export function parseComputerUseAppList(text: string): RegisteredAppTarget[] {
  const jsonApps = parseComputerUseAppJsonList(text);
  if (jsonApps !== undefined) return jsonApps;

  const apps: RegisteredAppTarget[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const parsed = parseComputerUseAppLine(line);
    if (!parsed) continue;

    const key = `${normalize(parsed.displayName)}\0${normalizePath(parsed.appPath ?? "")}\0${normalize(parsed.bundleId ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push(parsed);
  }

  return apps;
}

function parseComputerUseAppJsonList(text: string): RegisteredAppTarget[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  return parseComputerUseAppJsonValue(parsed);
}

function parseComputerUseAppJsonValue(value: unknown): RegisteredAppTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const apps: RegisteredAppTarget[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const app = parseComputerUseAppJsonEntry(entry);
    if (!app || seen.has(app.upstreamAddress)) continue;

    seen.add(app.upstreamAddress);
    apps.push(app);
  }

  return apps;
}

function parseComputerUseAppJsonEntry(value: unknown): RegisteredAppTarget | undefined {
  if (!isPlainObject(value)) return undefined;

  const { id, displayName } = value;
  if (typeof id !== "string" || !id.trim()) return undefined;
  if (displayName !== undefined && typeof displayName !== "string") return undefined;

  const upstreamAddress = id.trim();
  return {
    displayName: displayName?.trim() || upstreamAddress,
    upstreamAddress,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveAppTargetFromList(requested: string, appListText: string): AppTargetResolution {
  return resolveAppTarget(requested, parseComputerUseAppList(appListText));
}

export function resolveAppTargetFromStructuredList(requested: string, value: unknown): AppTargetResolution | undefined {
  const registeredApps = parseComputerUseAppJsonValue(value);
  return registeredApps === undefined ? undefined : resolveAppTarget(requested, registeredApps);
}

function resolveAppTarget(requested: string, registeredApps: RegisteredAppTarget[]): AppTargetResolution {
  const trimmed = requested.trim();

  if (isPidTarget(trimmed)) {
    return {
      status: "unsupported",
      requested: trimmed,
      unsupportedKind: "pid",
      registeredAppCount: registeredApps.length,
    };
  }

  if (isRawExecutablePath(trimmed)) {
    return {
      status: "unsupported",
      requested: trimmed,
      unsupportedKind: "raw_executable",
      registeredAppCount: registeredApps.length,
    };
  }

  const exactMatches = registeredApps
    .map((app) => toResolvedTarget(trimmed, app, matchKind(trimmed, app), "exact"))
    .filter((target): target is ResolvedAppTarget => target !== undefined);

  if (exactMatches.length === 1) {
    return {
      status: "resolved",
      requested: trimmed,
      target: exactMatches[0],
      registeredAppCount: registeredApps.length,
    };
  }

  if (exactMatches.length > 1) {
    return {
      status: "ambiguous",
      requested: trimmed,
      candidates: exactMatches,
      registeredAppCount: registeredApps.length,
    };
  }

  const candidates = registeredApps
    .filter((app) => isCandidate(trimmed, app))
    .slice(0, 8)
    .map((app) => ({
      kind: "registered_app" as const,
      requested: trimmed,
      displayName: app.displayName,
      appPath: app.appPath,
      bundleId: app.bundleId,
      upstreamAddress: app.upstreamAddress,
      confidence: "candidate" as const,
    }));

  return {
    status: "unresolved",
    requested: trimmed,
    candidates,
    registeredAppCount: registeredApps.length,
  };
}

export function formatAppTargetResolution(resolution: AppTargetResolution): string {
  if (resolution.status === "resolved") {
    const { target } = resolution;
    return [
      "Resolved app target.",
      "",
      `requested: ${quote(resolution.requested)}`,
      `match: ${target.kind}`,
      `displayName: ${target.displayName}`,
      `bundleId: ${target.bundleId ?? "(none)"}`,
      `appPath: ${target.appPath ?? "(not provided)"}`,
      `recommendedAddress: ${target.upstreamAddress}`,
      "canUseComputerUseState: true",
    ].join("\n");
  }

  if (resolution.status === "ambiguous") {
    return [
      `Ambiguous app target ${quote(resolution.requested)}.`,
      "",
      "Candidates:",
      ...formatCandidates(resolution.candidates),
      "",
      "Use a canonical app id, bundle id, or .app path to disambiguate before using mutating Computer Use tools.",
    ].join("\n");
  }

  if (resolution.status === "unsupported") {
    return [
      `Requested target ${quote(resolution.requested)} is not directly addressable by current upstream Computer Use.`,
      "",
      resolution.unsupportedKind === "pid"
        ? "Reason: PID targets are not supported by the current Computer Use tool schema."
        : "Reason: raw executable paths are not registered macOS .app bundle targets.",
      "",
      "This can happen for local development GUI apps launched as raw executables, for example:",
      "- target/debug/myapp",
      "- .build/debug/myapp",
      "- dist/mac-unpacked/...",
      "- Electron development processes",
      "",
      "Recommended:",
      "- launch the app through a temporary .app bundle when possible",
      "- then use the bundle id or .app bundle path as the Computer Use app target",
      "",
      "Avoid using osascript/System Events as an automatic fallback unless the user explicitly asks.",
    ].join("\n");
  }

  const lines = [
    `Could not resolve app target ${quote(resolution.requested)} in the Computer Use registered app index.`,
    "",
  ];

  if (resolution.candidates.length > 0) {
    lines.push("Nearby registered candidates:", ...formatCandidates(resolution.candidates), "");
  }

  lines.push(
    "This does not prove the app is not running.",
    "It may be an unbundled macOS GUI process with visible windows but no registered .app identity.",
    "",
    "Next checks:",
    "- call computer_use_list_apps to inspect registered Computer Use apps",
    "- if this is a local development GUI app, launch it through a temporary .app bundle",
    "- prefer bundle id or .app bundle path over display name",
    "",
    "Avoid using osascript/System Events as an automatic fallback unless the user explicitly asks.",
  );

  return lines.join("\n");
}

export function formatInvalidAppDiagnostic(
  originalMessage: string,
  requested: string,
  appListText: string,
  listAppsError?: string,
  structuredContent?: unknown,
): string {
  const resolution =
    resolveAppTargetFromStructuredList(requested, structuredContent) ?? resolveAppTargetFromList(requested, appListText);
  const lines = [
    originalMessage.trim() || `Invalid app: ${requested}`,
    "",
    "Plugin diagnosis:",
  ];

  if (listAppsError) {
    lines.push(`Could not inspect the Computer Use app index: ${listAppsError}`, "");
  }

  lines.push(formatAppTargetResolution(resolution));
  return lines.join("\n");
}

function parseComputerUseAppLine(line: string): RegisteredAppTarget | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const fields = trimmed.split(APP_FIELD_SEPARATOR);
  if (fields.length < 3) return undefined;

  const displayName = fields[0]?.trim();
  const appPath = fields[1]?.trim();
  const bundleId = fields.slice(2).join(APP_FIELD_SEPARATOR).replace(STATUS_SUFFIX_PATTERN, "").trim();

  if (!displayName || !appPath) return undefined;

  return {
    displayName,
    appPath,
    bundleId: bundleId || undefined,
    upstreamAddress: bundleId || appPath || displayName,
  };
}

function matchKind(requested: string, app: RegisteredAppTarget): ResolvedAppTarget["kind"] | undefined {
  const normalizedRequest = normalize(requested);
  if (normalizedRequest && normalize(app.bundleId ?? "") === normalizedRequest) return "bundle_id";
  if (app.appPath && normalizePath(app.appPath) === normalizePath(requested)) return "app_path";
  if (normalize(app.upstreamAddress) === normalizedRequest) return "app_id";
  if (normalize(app.displayName) === normalizedRequest) return "display_name";
  if (app.appPath && normalize(appBundleBasename(app.appPath)) === normalizedRequest) return "display_name";
  return undefined;
}

function toResolvedTarget(
  requested: string,
  app: RegisteredAppTarget,
  kind: ResolvedAppTarget["kind"] | undefined,
  confidence: ResolvedAppTarget["confidence"],
): ResolvedAppTarget | undefined {
  if (!kind) return undefined;
  return {
    kind,
    requested,
    displayName: app.displayName,
    appPath: app.appPath,
    bundleId: app.bundleId,
    upstreamAddress: app.upstreamAddress,
    confidence,
  };
}

function isCandidate(requested: string, app: RegisteredAppTarget): boolean {
  const normalizedRequest = normalize(requested);
  if (!normalizedRequest) return false;

  const values = [app.displayName, app.bundleId, app.appPath, app.upstreamAddress];
  if (app.appPath) values.push(appBundleBasename(app.appPath));
  return values.some((value) => value !== undefined && normalize(value).includes(normalizedRequest));
}

function isPidTarget(value: string): boolean {
  return PID_PATTERN.test(value.trim());
}

function isRawExecutablePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.includes("/") || APP_BUNDLE_PATTERN.test(trimmed)) return false;
  return trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.includes("/target/") || trimmed.includes("/.build/");
}


function appBundleBasename(appPath: string): string {
  const cleanPath = appPath.replace(/\/+$/, "");
  const lastSegment = cleanPath.split("/").pop() ?? cleanPath;
  return lastSegment.replace(/\.app$/i, "");
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizePath(value: string): string {
  return value.trim().replace(/\/+$/, "").toLocaleLowerCase();
}

function formatCandidates(candidates: ResolvedAppTarget[]): string[] {
  return candidates.map((candidate, index) => {
    const bundle = candidate.bundleId ? ` — ${candidate.bundleId}` : "";
    return `${index + 1}. ${candidate.displayName}${bundle} — ${candidate.appPath ?? "(not provided)"} — recommended: ${candidate.upstreamAddress}`;
  });
}

function quote(value: string): string {
  return `"${value}"`;
}
