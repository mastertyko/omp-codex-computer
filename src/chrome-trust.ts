import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const CHROME_TRUST_ENV_VAR = "OMP_CODEX_CHROME_TRUST";

// The built-in allowlist only grows through the CONTRIBUTING review process:
// app-server protocol review against the experimental API this extension uses,
// focused compatibility tests, and a live open/action/close smoke.
export const BUILT_IN_TRUSTED_APP_SERVER_VERSIONS: readonly string[] = Object.freeze(["0.149.0"]);

export const SAFE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

const TRUST_DIR_NAME = "omp-codex-computer";
const TRUST_FILE_NAME = "trusted-app-servers.json";
const MAX_TRUST_FILE_BYTES = 64 * 1024;

/**
 * Resolve the persisted trust file path from the given environment only, so
 * tests and callers that pass a bare env object never touch the real home
 * directory. No usable HOME/XDG_CONFIG_HOME means no persisted trust.
 */
export function getChromeTrustFilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, TRUST_DIR_NAME, TRUST_FILE_NAME);
  const home = env.HOME?.trim();
  if (home && isAbsolute(home)) return join(home, ".config", TRUST_DIR_NAME, TRUST_FILE_NAME);
  return undefined;
}

/** Load persisted app-server versions. Malformed content adds no trust. */
export async function loadPersistedAppServerVersions(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const path = getChromeTrustFilePath(env);
  if (!path) return [];
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TRUST_FILE_BYTES) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const versions: unknown = (parsed as Record<string, unknown>).appServerVersions;
  if (!Array.isArray(versions)) return [];
  return [...new Set(versions.filter(
    (version): version is string => typeof version === "string" && SAFE_VERSION_PATTERN.test(version),
  ))];
}

/** Persist one validated app-server version. Returns the trust file path. */
export async function persistTrustedAppServerVersion(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!SAFE_VERSION_PATTERN.test(version)) throw new Error("Refusing to persist an unsafe version string");
  const path = getChromeTrustFilePath(env);
  if (!path) throw new Error("No usable HOME or XDG_CONFIG_HOME to persist Chrome trust");

  const current = await loadPersistedAppServerVersions(env);
  const next = [...new Set([...current, version])];
  await writeTrustFileAtomically(path, next);
  return path;
}

/** Remove one version from the persisted store (rollback for a failed probe). */
export async function removePersistedAppServerVersion(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = getChromeTrustFilePath(env);
  if (!path) return;
  const current = await loadPersistedAppServerVersions(env);
  const next = current.filter((entry) => entry !== version);
  if (next.length === current.length) return;
  await writeTrustFileAtomically(path, next);
}

/**
 * Write via temp file + rename so concurrent OMP sessions never observe a
 * torn trust file. A concurrent lost update degrades to a re-probe, never to
 * malformed JSON granting or corrupting trust.
 */
async function writeTrustFileAtomically(path: string, versions: string[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ appServerVersions: versions }, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Delete the persisted trust store. Returns the removed path, if any. */
export async function clearPersistedAppServerVersions(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const path = getChromeTrustFilePath(env);
  if (!path) return undefined;
  await rm(path, { force: true });
  return path;
}

/**
 * Effective app-server trust: built-in allowlist, persisted store, then
 * OMP_CODEX_CHROME_TRUST as a comma-separated list of app-server versions.
 * Malformed entries are ignored and add no trust.
 */
export function getTrustedAppServerVersions(
  env: NodeJS.ProcessEnv = process.env,
  persisted: readonly string[] = [],
): string[] {
  const versions = [...BUILT_IN_TRUSTED_APP_SERVER_VERSIONS];
  for (const version of persisted) {
    if (SAFE_VERSION_PATTERN.test(version)) versions.push(version);
  }
  const raw = env[CHROME_TRUST_ENV_VAR];
  if (typeof raw === "string") {
    for (const entry of raw.split(",")) {
      const version = entry.trim();
      if (version.length > 0 && SAFE_VERSION_PATTERN.test(version)) versions.push(version);
    }
  }
  return [...new Set(versions)];
}

