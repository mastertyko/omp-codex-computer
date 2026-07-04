import { describe, expect, it } from "vitest";
import { redactForLog } from "../src/log";

describe("redactForLog", () => {
  it("redacts sensitive keys recursively", () => {
    const result = redactForLog({
      token: "abc",
      app: "TextEdit",
      nested: {
        screenshot: "base64",
        message: "visible",
      },
      content: [{ text: "accessibility tree" }],
    });

    expect(result).toEqual({
      token: "[redacted]",
      app: "TextEdit",
      nested: {
        screenshot: "[redacted]",
        message: "visible",
      },
      content: "[redacted]",
    });
  });
});
