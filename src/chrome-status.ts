import { access } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CODEX_APP_PATH } from "./status";

export interface ChromeBridgeStatus {
  available: boolean;
  reason: "available" | "missing_files";
  root: string;
  missing: string[];
  files: {
    chromeApiJson: string;
    chromeBrowserClient: string;
    browserClient: string;
  };
}

export async function inspectChromeBridgeStatus(codexAppPath = DEFAULT_CODEX_APP_PATH): Promise<ChromeBridgeStatus> {
  const pluginRoot = join(codexAppPath, "Contents/Resources/plugins/openai-bundled/plugins");
  const files = {
    chromeApiJson: join(pluginRoot, "chrome/docs/api.json"),
    chromeBrowserClient: join(pluginRoot, "chrome/scripts/browser-client.mjs"),
    browserClient: join(pluginRoot, "browser/scripts/browser-client.mjs"),
  };

  const missing: string[] = [];
  for (const path of Object.values(files)) {
    if (!(await pathExists(path))) missing.push(path);
  }

  return {
    available: missing.length === 0,
    reason: missing.length === 0 ? "available" : "missing_files",
    root: pluginRoot,
    missing,
    files,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
