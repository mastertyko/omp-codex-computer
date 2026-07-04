import { describe, expect, it } from "vitest";
import { convertCodexContentToOmpContent } from "../src/content";

describe("convertCodexContentToOmpContent", () => {
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
