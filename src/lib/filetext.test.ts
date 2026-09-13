import { describe, expect, it } from "vitest";
import { prepareText } from "./filetext";

describe("prepareText", () => {
  it("passes short text through unchanged", () => {
    expect(prepareText("မြနာမာ", 8000)).toEqual({
      text: "မြနာမာ",
      truncated: false,
    });
  });

  it("normalizes CRLF and lone-CR newlines to \\n", () => {
    expect(prepareText("က\r\nခ\rဂ", 8000).text).toBe("က\nခ\nဂ");
  });

  it("caps at exactly max characters for BMP text", () => {
    const raw = "က".repeat(9000);
    const r = prepareText(raw, 8000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(8000);
    expect(r.text).toBe("က".repeat(8000));
  });

  it("never cuts a surrogate pair in half when capping", () => {
    // "aaa…😀": the 8000th code unit would be the pair's high half
    const raw = "a".repeat(7999) + "😀";
    const r = prepareText(raw, 8000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(7999); // pair excluded whole, not halved
    expect(r.text).not.toMatch(/[\ud800-\udfff]/);
    expect(r.text.endsWith("a")).toBe(true);
  });

  it("keeps a pair intact when the cap lands after it", () => {
    const raw = "a".repeat(7998) + "😀";
    const r = prepareText(raw, 8000);
    expect(r.truncated).toBe(false); // exactly 8000 units — no cut needed
    expect(r.text).toBe(raw);
  });
});
