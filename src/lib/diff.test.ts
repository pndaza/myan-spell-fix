import { describe, expect, it } from "vitest";
import { countEdits, diffEdits, diffWords } from "./diff";

describe("diffWords", () => {
  it("returns all-same for identical text", () => {
    const segs = diffWords("မြန်မာ", "မြန်မာ");
    expect(segs).toEqual([{ type: "same", text: "မြန်မာ" }]);
    expect(countEdits(segs)).toBe(0);
  });

  it("localizes a Burmese edit to the changed syllable, not the phrase", () => {
    // မြနာမာ → မြန်မာ: only the န syllable changes
    const segs = diffWords("မြနာမာနိုင်ငံ", "မြန်မာနိုင်ငံ");
    expect(segs.some((s) => s.type === "same" && s.text.includes("နိုင်ငံ"))).toBe(true);
    expect(segs.some((s) => s.type === "del" && s.text.includes("နာ"))).toBe(true);
    expect(segs.some((s) => s.type === "add" && s.text.includes("န်"))).toBe(true);
    expect(countEdits(segs)).toBe(1);
  });

  it("counts a replacement as one edit, not two", () => {
    const segs = diffWords("ဖစ်သည်", "ဖြစ်သည်");
    expect(countEdits(segs)).toBe(1);
  });

  it("counts multiple separate edits", () => {
    const a = "မြနာမာနိုင်ငံဖစ်သည်။";
    const b = "မြန်မာနိုင်ငံဖြစ်သည်။";
    expect(countEdits(diffWords(a, b))).toBe(2);
  });

  it("round-trips: same+del rebuilds the original, same+add the correction", () => {
    const a = "က ခ ဂ";
    const b = "က ခ ဃ";
    const segs = diffWords(a, b);
    const rebuiltA = segs.filter((s) => s.type !== "add").map((s) => s.text).join("");
    const rebuiltB = segs.filter((s) => s.type !== "del").map((s) => s.text).join("");
    expect(rebuiltA).toBe(a);
    expect(rebuiltB).toBe(b);
  });

  it("diffs mixed Burmese + English text", () => {
    const segs = diffWords("Google ကို ရှာပါ", "Google ကို‌ ရှာပါ");
    expect(countEdits(segs)).toBeLessThanOrEqual(2);
  });
});

describe("diffEdits", () => {
  it("drops unchanged context and inserts gaps between edits", () => {
    const a = "မြနာမာနိုင်ငံ အလှဆုံး ဖစ်သည်။";
    const b = "မြန်မာနိုင်ငံ အလှဆုံး ဖြစ်သည်။";
    const segs = diffEdits(a, b);
    expect(segs.every((s) => s.type !== "same")).toBe(true);
    expect(segs.some((s) => s.type === "gap" && s.text === "…")).toBe(true);
    expect(segs[0].type).not.toBe("gap"); // never a leading gap
  });

  it("returns empty for identical text", () => {
    expect(diffEdits("တူညာသည်", "တူညာသည်")).toEqual([]);
  });
});
