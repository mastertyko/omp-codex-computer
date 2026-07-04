import { appendFile } from "node:fs/promises";

const SENSITIVE_KEY_PATTERN = /screenshot|image|base64|token|secret|password|authorization|content|text/i;

export function logDebug(event: string, data: Record<string, unknown> = {}): void {
  if (process.env.OMP_CODEX_COMPUTER_DEBUG !== "1" && !process.env.OMP_CODEX_COMPUTER_LOG) return;

  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...(redactForLog(data) as Record<string, unknown>),
  });

  if (process.env.OMP_CODEX_COMPUTER_DEBUG === "1") {
    process.stderr.write(`[omp-codex-computer] ${entry}\n`);
  }

  const logPath = process.env.OMP_CODEX_COMPUTER_LOG;
  if (logPath) void appendFile(logPath, `${entry}\n`, "utf8").catch(() => undefined);
}

export function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactForLog(entry));
  if (!value || typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redactForLog(nestedValue);
  }
  return redacted;
}
