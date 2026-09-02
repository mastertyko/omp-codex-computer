import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_TRUSTED_APP_SERVER_VERSIONS,
  clearPersistedAppServerVersions,
  getChromeTrustFilePath,
  getTrustedAppServerVersions,
  loadPersistedAppServerVersions,
  persistTrustedAppServerVersion,
  removePersistedAppServerVersion,
} from "../src/chrome-trust";

const tempRoots: string[] = [];

async function tempConfigHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-chrome-trust-store-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("getChromeTrustFilePath", () => {
  it("prefers an absolute XDG_CONFIG_HOME, falls back to HOME/.config, else nothing", () => {
    expect(getChromeTrustFilePath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/user" }))
      .toBe(join("/xdg", "omp-codex-computer", "trusted-app-servers.json"));
    expect(getChromeTrustFilePath({ HOME: "/home/user" }))
      .toBe(join("/home/user", ".config", "omp-codex-computer", "trusted-app-servers.json"));
    expect(getChromeTrustFilePath({ XDG_CONFIG_HOME: "relative/config", HOME: "also-relative" }))
      .toBeUndefined();
    expect(getChromeTrustFilePath({})).toBeUndefined();
  });
});

describe("persisted trust store", () => {
  it("persists, unions, removes, and clears versions as a roundtrip", async () => {
    const env = { XDG_CONFIG_HOME: await tempConfigHome() };

    const path = await persistTrustedAppServerVersion("0.150.0", env);
    await persistTrustedAppServerVersion("0.151.0", env);
    await persistTrustedAppServerVersion("0.150.0", env);
    expect(await loadPersistedAppServerVersions(env)).toEqual(["0.150.0", "0.151.0"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      appServerVersions: ["0.150.0", "0.151.0"],
    });

    await removePersistedAppServerVersion("0.150.0", env);
    expect(await loadPersistedAppServerVersions(env)).toEqual(["0.151.0"]);

    const cleared = await clearPersistedAppServerVersions(env);
    expect(cleared).toBe(path);
    expect(await loadPersistedAppServerVersions(env)).toEqual([]);
  });

  it("refuses to persist unsafe versions and fails without a config home", async () => {
    const env = { XDG_CONFIG_HOME: await tempConfigHome() };

    await expect(persistTrustedAppServerVersion("/etc/passwd", env)).rejects.toThrow();
    await expect(persistTrustedAppServerVersion("0.150.0", {})).rejects.toThrow();
    expect(await clearPersistedAppServerVersions({})).toBeUndefined();
  });

  it("treats missing, oversized, and malformed stores as empty without widening trust", async () => {
    const configHome = await tempConfigHome();
    const env = { XDG_CONFIG_HOME: configHome };
    expect(await loadPersistedAppServerVersions(env)).toEqual([]);

    const dir = join(configHome, "omp-codex-computer");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "trusted-app-servers.json");

    for (const content of [
      "not json",
      JSON.stringify(["0.150.0"]),
      JSON.stringify({ appServerVersions: "0.150.0" }),
      JSON.stringify({ appServerVersions: [42, "/etc/passwd", "bad version"] }),
      `{"appServerVersions": ["0.150.0"], "padding": "${"x".repeat(64 * 1024)}"}`,
    ]) {
      await writeFile(path, content);
      expect(await loadPersistedAppServerVersions(env)).toEqual([]);
    }
  });
});

describe("getTrustedAppServerVersions", () => {
  it("merges built-in, persisted, and env versions with validation and dedupe", () => {
    expect(getTrustedAppServerVersions({}, [])).toEqual([...BUILT_IN_TRUSTED_APP_SERVER_VERSIONS]);
    expect(getTrustedAppServerVersions(
      { OMP_CODEX_CHROME_TRUST: " 0.152.0 ,0.149.0, plugin@0.153.0 , bad version ,," },
      ["0.150.0", "/etc/passwd"],
    )).toEqual([...BUILT_IN_TRUSTED_APP_SERVER_VERSIONS, "0.150.0", "0.152.0"]);
  });
});
