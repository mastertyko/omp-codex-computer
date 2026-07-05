export type OmpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface CodexContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  mime_type?: string;
  [key: string]: unknown;
}

export interface ContentConversionOptions {
  maxBytes?: number;
  maxLines?: number;
}

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 3000;
const TRUNCATION_MARKER = "[Output truncated]";

export function convertCodexContentToOmpContent(
  content: unknown,
  options: ContentConversionOptions = {},
): OmpContentBlock[] {
  if (!Array.isArray(content)) {
    return [{ type: "text", text: stringifyUnknownContent(content, options) }];
  }

  const blocks: OmpContentBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") {
      blocks.push({ type: "text", text: String(raw) });
      continue;
    }

    const block = raw as CodexContentBlock;
    if (block.type === "text") {
      blocks.push({ type: "text", text: truncateText(block.text ?? "", options) });
      continue;
    }

    if (block.type === "image" && typeof block.data === "string") {
      blocks.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType ?? block.mime_type ?? "image/jpeg",
      });
      continue;
    }

    blocks.push({ type: "text", text: truncateText(JSON.stringify(block, null, 2), options) });
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "(no content)" }];
}

function truncateText(text: string, options: ContentConversionOptions): string {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const lines = text.split("\n");
  let output = lines.slice(0, maxLines).join("\n");

  while (Buffer.byteLength(output, "utf8") > maxBytes && output.length > 0) {
    output = output.slice(0, Math.max(0, output.length - 256));
  }

  const truncated = lines.length > maxLines || Buffer.byteLength(text, "utf8") > maxBytes;
  if (!truncated) return text;

  return appendTruncationMarker(output, maxBytes);
}

function appendTruncationMarker(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  if (markerBytes >= maxBytes) return trimToByteLength(TRUNCATION_MARKER, maxBytes);

  const separator = text ? "\n" : "";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const textBudget = Math.max(0, maxBytes - markerBytes - separatorBytes);
  const trimmedText = trimToByteLength(text, textBudget);
  return trimmedText ? `${trimmedText}${separator}${TRUNCATION_MARKER}` : TRUNCATION_MARKER;
}

function trimToByteLength(text: string, maxBytes: number): string {
  let bytes = 0;
  let output = "";

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    output += char;
    bytes += charBytes;
  }

  return output;
}

function stringifyUnknownContent(content: unknown, options: ContentConversionOptions): string {
  if (content === undefined) return "(no content)";
  if (typeof content === "string") return truncateText(content, options);
  return truncateText(JSON.stringify(content, null, 2), options);
}
