import { describe, expect, it } from "vitest";
import { applyFixes, parseFixes, type Suggestion } from "./spellfix";

describe("parseFixes", () => {
  it("parses a well-formed fixes object", () => {
    const raw = JSON.stringify({
      fixes: [
        { wrong: "မြနာမာ", correct: "မြန်မာ" },
        { wrong: "ဖစ်", correct: "ဖြစ်" },
      ],
    });
    expect(parseFixes(raw)).toEqual([
      { wrong: "မြနာမာ", correct: "မြန်မာ" },
      { wrong: "ဖစ်", correct: "ဖြစ်" },
    ]);
  });

  it("returns [] for no-errors replies", () => {
    expect(parseFixes('{"fixes": []}')).toEqual([]);
  });

  it("strips markdown fences", () => {
    const raw = '```json\n{"fixes": [{"wrong": "က", "correct": "ခ"}]}\n```';
    expect(parseFixes(raw)).toEqual([{ wrong: "က", correct: "ခ" }]);
  });

  it("fishes the JSON out of surrounding prose", () => {
    const raw = 'Sure! {"fixes": [{"wrong": "က", "correct": "ခ"}]} hope this helps';
    expect(parseFixes(raw)).toEqual([{ wrong: "က", correct: "ခ" }]);
  });

  it("tolerates a bare array reply", () => {
    expect(parseFixes('[{"wrong": "က", "correct": "ခ"}]')).toEqual([
      { wrong: "က", correct: "ခ" },
    ]);
  });

  it("fishes a bare array out of surrounding prose", () => {
    const raw = 'Sure! [{"wrong": "က", "correct": "ခ"}] hope this helps';
    expect(parseFixes(raw)).toEqual([{ wrong: "က", correct: "ခ" }]);
  });

  it("accepts a single bare fix object", () => {
    expect(parseFixes('{"wrong": "က", "correct": "ခ"}')).toEqual([
      { wrong: "က", correct: "ခ" },
    ]);
  });

  it("drops invalid entries without losing the valid ones", () => {
    const raw = JSON.stringify({
      fixes: [
        { wrong: "က", correct: "ခ" }, // valid
        { wrong: "", correct: "ခ" }, // empty wrong
        { wrong: "တူ", correct: "တူ" }, // wrong === correct
        { wrong: 42, correct: "ခ" }, // non-string
        { wrong: "ဂ" }, // missing correct
        "nonsense", // not an object
        null,
      ],
    });
    expect(parseFixes(raw)).toEqual([{ wrong: "က", correct: "ခ" }]);
  });

  it("dedupes identical pairs", () => {
    const raw = JSON.stringify({
      fixes: [
        { wrong: "က", correct: "ခ" },
        { wrong: "က", correct: "ခ" },
      ],
    });
    expect(parseFixes(raw)).toHaveLength(1);
  });

  it("reads a garbage reply as no suggestions, not an error", () => {
    expect(parseFixes("I could not read the text.")).toEqual([]);
    expect(parseFixes("")).toEqual([]);
  });

  it("caps the list at 200 entries", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      wrong: `w${i}`,
      correct: `c${i}`,
    }));
    expect(parseFixes(JSON.stringify({ fixes: many }))).toHaveLength(200);
  });
});

describe("applyFixes", () => {
  const text = "မြနာမာနိုင်ငံဖစ်သည်။ မြနာမာ လူမျိုးများ။";

  it("substitutes every occurrence of each approved fix", () => {
    const fixes: Suggestion[] = [{ wrong: "မြနာမာ", correct: "မြန်မာ" }];
    const out = applyFixes(text, fixes);
    expect(out.applied).toBe(1);
    expect(out.notFound).toEqual([]);
    expect(out.text).not.toContain("မြနာမာ");
    expect(out.text.split("မြန်မာ").length - 1).toBe(2);
  });

  it("applies multiple fixes in order", () => {
    const fixes: Suggestion[] = [
      { wrong: "မြနာမာ", correct: "မြန်မာ" },
      { wrong: "ဖစ်", correct: "ဖြစ်" },
    ];
    const out = applyFixes(text, fixes);
    expect(out.applied).toBe(2);
    expect(out.text).toBe("မြန်မာနိုင်ငံဖြစ်သည်။ မြန်မာ လူမျိုးများ။");
  });

  it("reports fragments that do not occur instead of forcing them", () => {
    const fixes: Suggestion[] = [{ wrong: "မရှိသောစာလုံး", correct: "အစား" }];
    const out = applyFixes(text, fixes);
    expect(out.applied).toBe(0);
    expect(out.notFound).toEqual(fixes);
    expect(out.text).toBe(text); // untouched
  });

  it("sequential semantics: a later fix may match text an earlier fix created", () => {
    const fixes: Suggestion[] = [
      { wrong: "ဖစ်", correct: "ဖြစ်" },
      { wrong: "ဖြစ်သည်", correct: "ရှိသည်" }, // fragment exists only after fix 1
    ];
    const out = applyFixes("ဖစ်သည်", fixes);
    expect(out.applied).toBe(2);
    expect(out.text).toBe("ရှိသည်");
  });

  it("reports not-found when an earlier fix consumed the later one's fragment", () => {
    const fixes: Suggestion[] = [
      { wrong: "ဖစ်သည်", correct: "ရှိသည်" }, // replaces the whole fragment…
      { wrong: "ဖစ်", correct: "ဖွစ်" }, // …so this no longer occurs
    ];
    const out = applyFixes("ဖစ်သည်", fixes);
    expect(out.applied).toBe(1);
    expect(out.text).toBe("ရှိသည်");
    expect(out.notFound).toEqual([fixes[1]]);
  });

  it("is total on its own: an empty wrong fragment is skipped, never inserted", () => {
    const out = applyFixes("abc", [{ wrong: "", correct: "X" }]);
    expect(out.text).toBe("abc");
    expect(out.applied).toBe(0);
    expect(out.notFound).toEqual([{ wrong: "", correct: "X" }]);
  });

  it("is total on its own: wrong === correct is a no-op, not applied", () => {
    const out = applyFixes("abc", [{ wrong: "b", correct: "b" }]);
    expect(out.text).toBe("abc");
    expect(out.applied).toBe(0);
    expect(out.notFound).toEqual([{ wrong: "b", correct: "b" }]);
  });
});
