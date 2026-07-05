import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { inspectChromeBridgeStatus } from "../src/chrome-status";

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
