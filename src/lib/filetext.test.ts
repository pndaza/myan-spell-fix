import { describe, expect, it } from "vitest";
import { normalizeText } from "./filetext";

describe("normalizeText", () => {
  it("passes text through unchanged when newlines are already \\n", () => {
    const s = "မြနာမာ\nဒုတိယ စာပိုဒ်\n";
    expect(normalizeText(s)).toBe(s);
  });

  it("normalizes CRLF newlines", () => {
    expect(normalizeText("က\r\nခ\r\nဂ")).toBe("က\nခ\nဂ");
  });

  it("normalizes lone CR (old Mac) newlines", () => {
    expect(normalizeText("က\rခ")).toBe("က\nခ");
  });

  it("does not touch other characters", () => {
    const s = "က \u00a0 ခ \u200c ဂ 😀 ။ ၊";
    expect(normalizeText(s)).toBe(s);
  });
});
