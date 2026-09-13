import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk";

/** Verified sample sentence with punctuation marks at known spots. */
const SENT = "မြန်မာနိုင်ငံသည် အရှေ့တောင်အာရှဒေသတွင် တည်ရှိသည်။";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("short")).toEqual(["short"]);
    expect(chunkText("")).toEqual([]);
  });

  it("rejoins to the original text exactly", () => {
    const text = Array.from({ length: 12 }, (_, i) => `${i} ${SENT} ${SENT}`).join("\n");
    const chunks = chunkText(text, 200);
    expect(chunks.join("")).toBe(text);
  });

  it("respects the max length", () => {
    const text = Array.from({ length: 30 }, () => SENT).join("");
    const chunks = chunkText(text, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
  });

  it("prefers paragraph boundaries: no chunk crosses a newline unnecessarily", () => {
    const paras = [SENT, SENT, SENT].join("\n");
    // max large enough that each paragraph (sentence + its newline) fits;
    // separators TRAIL their piece, so chunks 0-1 carry the newline at end
    const chunks = chunkText(paras, SENT.length + 1);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe(`${SENT}\n`);
    expect(chunks[1]).toBe(`${SENT}\n`);
    expect(chunks[2]).toBe(SENT);
  });

  it("keeps ။ trailing its sentence", () => {
    const text = Array.from({ length: 20 }, () => SENT).join("");
    const chunks = chunkText(text, 100);
    // every chunk but possibly the last should end at a sentence boundary
    for (const c of chunks.slice(0, -1)) expect(c.endsWith("။")).toBe(true);
  });

  it("hard-splits a long run with no punctuation", () => {
    const blob = "x".repeat(500);
    const chunks = chunkText(blob, 200);
    expect(chunks.join("")).toBe(blob);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it("hard-split never cuts a surrogate pair in half", () => {
    const blob = "😀".repeat(10); // 20 code units, no break points
    const chunks = chunkText(blob, 3);
    expect(chunks.join("")).toBe(blob);
    // every chunk is a whole number of 😀 pairs (no lone surrogates)
    for (const c of chunks) expect(c.length % 2).toBe(0);
  });

  it("splits on the ၊ clause mark when sentences are still too long", () => {
    // sentence-sized runs joined by ၊ such that ။-splitting alone can't
    // get under max
    const clauses = ["ကခဂဃငစဆဇညဏတထပဒနဖဗမယရလဝသဟဠအ", "ကခဂဃငစဆဇညဏတထပဒနဖဗမယရလဝသဟဠအ", "ကခဂဃငစဆဇညဏတထပဒနဖဗမယရလဝသဟဠအ"];
    const text = `${clauses[0]}၊${clauses[1]}၊${clauses[2]}။`;
    const chunks = chunkText(text, clauses[0].length + 2);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    // ၊ trails its clause
    expect(chunks[0].endsWith("၊")).toBe(true);
  });

  it("handles separator-only and leading-separator input", () => {
    expect(chunkText("။၊\n").join("")).toBe("။၊\n");
    const lead = "\n" + SENT.repeat(20);
    const chunks = chunkText(lead, 100);
    expect(chunks.join("")).toBe(lead);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(101);
  });

  it("clamps a nonsensical max instead of hanging", () => {
    expect(chunkText("abc", 0).join("")).toBe("abc");
    expect(chunkText("abc", -5).join("")).toBe("abc");
  });
});
