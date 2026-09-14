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
    expect(countEdits(segs)).toBe(1);
  });

  it("handles empty inputs", () => {
    expect(diffWords("", "")).toEqual([]);
    const onlyAdd = diffWords("", "က");
    expect(countEdits(onlyAdd)).toBe(1);
    expect(onlyAdd.map((s) => s.text).join("")).toBe("က");
    const onlyDel = diffWords("က", "");
    expect(countEdits(onlyDel)).toBe(1);
    expect(onlyDel.map((s) => s.text).join("")).toBe("က");
  });

  it("trims shared context: an edit late in a long text is still localized", () => {
    const head = "မြန်မာ".repeat(50);
    const a = head + "ဖစ်သည်။";
    const b = head + "ဖြစ်သည်။";
    const segs = diffWords(a, b);
    expect(countEdits(segs)).toBe(1);
    // the unchanged head+tail collapses into merged same-runs, not a
    // token-by-token blow-up
    const same = segs.filter((s) => s.type === "same").map((s) => s.text).join("");
    expect(same).toBe(head + "စ်သည်။"); // only the ဖ→ဖြ syllable differs
  });

  it("diffs above the DP cap without losing text (split-and-recurse)", () => {
    // enough distinct tokens on both sides to blow past MAX_DP_CELLS (16M)
    // while sharing nothing but the spaces between words — the region is
    // split at the middle and each half diffs finely
    const a = Array.from({ length: 4200 }, (_, i) => `a${i}`).join(" ");
    const b = Array.from({ length: 4200 }, (_, i) => `b${i}`).join(" ");
    const segs = diffWords(a, b);
    expect(countEdits(segs)).toBe(4200); // one replacement per word token
    expect(segs.filter((s) => s.type === "del").map((s) => s.text).join(" ")).toBe(a);
    expect(segs.filter((s) => s.type === "add").map((s) => s.text).join(" ")).toBe(b);
  });

  it("a ~5k-char document with scattered edits still diffs finely", () => {
    // 40 paragraphs, one typo each — the realistic batched-document case;
    // must NOT hit the coarse fallback
    const para = "မြနာမာနိုင်ငံသည် အရှေ့တောင်အာရှဒေသတွင် တည်ရှိသည်။ နိုင်ငံ၏ မြို့တော်မှာ နေပြည်တော်ဖစ်သည်။ လူမျိုးပေါင်းစုံ အတူတကွ နေထိုင်ကြသည်။";
    const a = Array.from({ length: 40 }, () => para).join("\n");
    const b = a.split("မြနာမာ").join("မြန်မာ");
    expect(a.length).toBeGreaterThan(4000);
    expect(countEdits(diffWords(a, b))).toBe(40); // one per paragraph
  });

  it("does not blow the stack on a huge whitespace-free token", () => {
    // PDF-paste shaped: Burmese is unspaced, so a whole document can
    // arrive as ONE token — tokenize must not spread it as call arguments
    const tok = "ကော".repeat(150_000);
    const segs = diffWords(tok, tok + "ာ");
    expect(segs.filter((s) => s.type === "add").map((s) => s.text).join("")).toContain("ာ");
    expect(segs.filter((s) => s.type !== "add").map((s) => s.text).join("")).toBe(tok);
  });

  it("keeps distant edits separate above the DP cap (split-and-recurse)", () => {
    // ~14k chars: the region between the first and last edit exceeds the
    // DP cap. The old coarse fallback showed ONE del+add blob; splitting
    // at the middle and recursing localizes both edits.
    const para = "မြနာမာနိုင်ငံသည် အရှေ့တောင်အာရှဒေသတွင် တည်ရှိသည်။ နိုင်ငံ၏ မြို့တော်မှာ နေပြည်တော်ဖစ်သည်။ လူမျိုးပေါင်းစုံ အတူတကွ နေထိုင်ကြသည်။";
    const paras = Array.from({ length: 100 }, () => para);
    const fixed = [...paras];
    fixed[0] = paras[0].split("မြနာမာ").join("မြန်မာ"); // first paragraph
    fixed[99] = paras[99].split("ဖစ်").join("ဖြစ်"); // last paragraph
    const a = paras.join("\n");
    const b = fixed.join("\n");
    expect(a.length).toBeGreaterThan(10_000);
    const segs = diffWords(a, b);
    expect(countEdits(segs)).toBe(2);
    // round-trip still holds through the recursive fallback
    expect(segs.filter((s) => s.type !== "add").map((s) => s.text).join("")).toBe(a);
    expect(segs.filter((s) => s.type !== "del").map((s) => s.text).join("")).toBe(b);
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
