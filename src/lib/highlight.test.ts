import { describe, expect, it } from "vitest";
import {
  countOccurrences,
  highlightText,
  renderFlags,
  scanFlags,
  type FlagSource,
} from "./highlight";

const TEXT = "မြနာမာနိုင်ငံဖစ်သည်။ မြနာမာ လူမျိုးများ။";

function row(wrong: string, checked = true, found = true): FlagSource {
  return { wrong, checked, found };
}

describe("highlightText", () => {
  it("flags every occurrence of a fragment", () => {
    const segs = highlightText(TEXT, [row("မြနာမာ")]);
    const flagged = segs.filter((s) => s.type === "on");
    expect(flagged).toHaveLength(2);
    expect(flagged.every((s) => s.text === "မြနာမာ")).toBe(true);
    expect(segs.map((s) => s.text).join("")).toBe(TEXT);
  });

  it("renders unchecked rows as off, checked as on", () => {
    const segs = highlightText(TEXT, [row("မြနာမာ", true), row("ဖစ်", false)]);
    expect(segs.filter((s) => s.type === "on").every((s) => s.text === "မြနာမာ")).toBe(true);
    expect(segs.filter((s) => s.type === "off").every((s) => s.text === "ဖစ်")).toBe(true);
  });

  it("ignores not-found rows (hallucinated fragments)", () => {
    const segs = highlightText(TEXT, [row("မရှိသောဖွင့်", true, false)]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ type: "plain", text: TEXT });
  });

  it("resolves overlaps: longer fragment at the same start wins", () => {
    const segs = highlightText("ဖစ်သည်", [row("ဖစ်"), row("ဖစ်သည်")]);
    const flagged = segs.filter((s) => s.type !== "plain");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].text).toBe("ဖစ်သည်");
    expect(segs.map((s) => s.text).join("")).toBe("ဖစ်သည်");
  });

  it("resolves overlaps: earlier-starting fragment wins", () => {
    const segs = highlightText("ကကခ", [row("ကခ"), row("ခ")]);
    const flagged = segs.filter((s) => s.type !== "plain");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].text).toBe("ကခ");
  });

  it("returns the whole text as plain when nothing is flagged", () => {
    expect(highlightText(TEXT, [])).toEqual([{ type: "plain", text: TEXT }]);
  });

  it("marks the current (cursor) row's fragments with cur", () => {
    const rows: FlagSource[] = [
      { wrong: "မြနာမာ", checked: true, found: true, current: true },
      { wrong: "ဖစ်", checked: true, found: true },
    ];
    const segs = highlightText(TEXT, rows);
    const cur = segs.filter((s) => s.cur === true);
    expect(cur).toHaveLength(2); // မြနာမာ occurs twice in TEXT
    expect(cur.every((s) => s.text === "မြနာမာ" && s.type === "on")).toBe(true);
    expect(segs.filter((s) => s.type === "on" && !s.cur)).toHaveLength(1); // ဖစ်
  });

  it("never hangs on an empty fragment, even if a caller forgets to filter", () => {
    const segs = highlightText(TEXT, [{ wrong: "", checked: true, found: true }]);
    expect(segs).toEqual([{ type: "plain", text: TEXT }]);
  });

  it("flags fragments containing a newline", () => {
    const text = "မြနာမာ\nမြနာမာ";
    const segs = highlightText(text, [row("မြနာမာ")]);
    expect(segs.filter((s) => s.type === "on")).toHaveLength(2);
    expect(segs.map((s) => s.text).join("")).toBe(text);
  });

  it("lights the covering winner when the cursor row loses every overlap", () => {
    // the current row's "ဖစ်" sits inside the longer "ဖစ်သည်" — the
    // cursor must still be visible in the text panel
    const rows: FlagSource[] = [
      { wrong: "ဖစ်", checked: true, found: true, current: true },
      { wrong: "ဖစ်သည်", checked: true, found: true },
    ];
    const segs = highlightText("ဖစ်သည်", rows);
    const cur = segs.filter((s) => s.cur === true);
    expect(cur).toHaveLength(1);
    expect(cur[0].text).toBe("ဖစ်သည်");
  });

  it("cursor fallback stays scoped to the current row — unrelated rows stay unlit", () => {
    // three rows: the cursor row loses every overlap, another row wins at
    // the same spots, and a THIRD row wins elsewhere in the document. Only
    // the ranges covering the cursor row's lost fragments may light up.
    const text = "ဖစ်သည်။ ခးန်းရှိသည်။ ဖစ်သည်။";
    const rows: FlagSource[] = [
      { wrong: "ဖစ်", checked: true, found: true, current: true }, // loses to row 1
      { wrong: "ဖစ်သည်", checked: true, found: true }, // wins twice
      { wrong: "ခးန်း", checked: true, found: true }, // wins elsewhere
    ];
    const cur = highlightText(text, rows).filter((s) => s.cur === true);
    expect(cur.map((s) => s.text)).toEqual(["ဖစ်သည်", "ဖစ်သည်"]);
  });
});

describe("scanFlags + renderFlags", () => {
  it("compose to exactly highlightText's output", () => {
    const rows: FlagSource[] = [
      { wrong: "မြနာမာ", checked: true, found: true, current: true },
      { wrong: "ဖစ်", checked: false, found: true },
      { wrong: "မရှိသောဖွင့်", checked: true, found: false },
    ];
    expect(renderFlags(TEXT, scanFlags(TEXT, rows), rows)).toEqual(
      highlightText(TEXT, rows),
    );
  });

  it("re-renders a scan with new check/cursor state without rescanning", () => {
    const scan = scanFlags(TEXT, [row("မြနာမာ"), row("ဖစ်")]);
    const before = renderFlags(TEXT, scan, [
      { checked: true, current: false },
      { checked: true, current: true },
    ]);
    expect(before.filter((s) => s.type === "off")).toHaveLength(0);
    // toggle မြနာမာ off, move the cursor to it — same scan, new render
    const after = renderFlags(TEXT, scan, [
      { checked: false, current: true },
      { checked: true, current: false },
    ]);
    expect(after.filter((s) => s.type === "off").every((s) => s.text === "မြနာမာ")).toBe(true);
    expect(after.filter((s) => s.type === "on").every((s) => s.text === "ဖစ်")).toBe(true);
    expect(after.filter((s) => s.cur === true).every((s) => s.text === "မြနာမာ")).toBe(true);
    expect(after.map((s) => s.text).join("")).toBe(TEXT);
  });
});

describe("countOccurrences", () => {
  it("counts overlapping-free occurrences like split().length - 1", () => {
    expect(countOccurrences("ကာကာကာ", "ကာ")).toBe(3);
    expect(countOccurrences("မြနာမာနိုင်ငံဖစ်သည်။ မြနာမာ လူမျိုးများ။", "မြနာမာ")).toBe(2);
    expect(countOccurrences("abc", "ခ")).toBe(0);
    expect(countOccurrences("abc", "")).toBe(0); // guard, never loops
  });
});
