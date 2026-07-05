import { describe, expect, it } from "vitest";
import { convertCodexContentToOmpContent } from "../src/content";

describe("convertCodexContentToOmpContent", () => {
  it("returns an explicit no-content text block for empty arrays", () => {
    expect(convertCodexContentToOmpContent([])).toEqual([{ type: "text", text: "(no content)" }]);
  });

  it("converts text and image blocks", () => {
    const result = convertCodexContentToOmpContent([
      { type: "text", text: "hello" },
      { type: "image", data: "abc123" },
    ]);

    expect(result).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "abc123", mimeType: "image/jpeg" },
    ]);
  });

  it("preserves mime_type input as output mimeType", () => {
    expect(
      convertCodexContentToOmpContent([{ type: "image", data: "abc", mime_type: "image/png" }]),
    ).toEqual([{ type: "image", data: "abc", mimeType: "image/png" }]);
  });

  it("stringifies unknown object blocks inside arrays as text", () => {
    const result = convertCodexContentToOmpContent([{ type: "resource", uri: "x" }]);

    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("text");
    if (result[0]?.type === "text") {
      expect(result[0].text).toContain("resource");
      expect(result[0].text).toContain("uri");
    }
  });

  it("converts non-array string content to a text block", () => {
    expect(convertCodexContentToOmpContent("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("truncates long text with an explicit marker", () => {
    const result = convertCodexContentToOmpContent([{ type: "text", text: "a\nb\nc" }], {
      maxLines: 2,
      maxBytes: 1000,
    });
    expect(result[0]).toMatchObject({ type: "text" });
    if (result[0]?.type === "text") {
      expect(result[0].text).toContain("Output truncated");
      expect(result[0].text).not.toContain("\nc");
    }
  });

  it("stringifies unknown content", () => {
    const result = convertCodexContentToOmpContent({ ok: true });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("text");
  });
});
