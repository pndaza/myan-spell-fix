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
});
