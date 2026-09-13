import { describe, expect, it } from "vitest";
import { highlightText, type FlagSource } from "./highlight";

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
});
