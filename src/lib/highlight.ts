//! Inline highlighting of flagged fragments in the original text — the
//! left panel of manual mode's two-panel review (just-ocr style: the text
//! panel highlights what the fix list flags). Every occurrence of a found
//! suggestion's `wrong` fragment becomes a flagged span: active (checked —
//! will be fixed) or muted (unchecked — rejected by the user).

/** One rendered piece of the highlighted text. `cur` marks fragments that
 *  belong to the keyboard-cursor's suggestion row (the one whose left
 *  vertical indicator is lit in the fix list). */
export interface FlagSeg {
  type: "plain" | "on" | "off";
  text: string;
  cur?: boolean;
}

/** The fields highlightText needs from a suggestion row. */
export interface FlagSource {
  wrong: string;
  checked: boolean;
  found: boolean;
  /** True for the row the review cursor is on. */
  current?: boolean;
}

interface Range {
  start: number;
  end: number;
  on: boolean;
  cur: boolean;
}

/**
 * Collect non-overlapping occurrence ranges, in text order. Overlap rule:
 * earlier-starting wins; at the same start, the longer fragment wins; ties
 * break by suggestion order — deterministic no matter how the model orders
 * its pairs (e.g. "ဖစ်" inside "ဖစ်သည်" flags only the longer one).
 * Occurrences of one fragment never overlap themselves (search resumes at
 * the previous match's end).
 */
function collectRanges(text: string, rows: FlagSource[]): Range[] {
  const hits: Array<Range & { order: number }> = [];
  rows.forEach((row, order) => {
    // guard by contract, not by caller discipline: an empty `wrong` matches
    // at every index and would loop forever below
    if (!row.found || row.wrong.length === 0) return;
    let from = 0;
    for (;;) {
      const at = text.indexOf(row.wrong, from);
      if (at === -1) break;
      hits.push({
        start: at,
        end: at + row.wrong.length,
        on: row.checked,
        cur: row.current === true,
        order,
      });
      from = at + row.wrong.length;
    }
  });

  hits.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      a.order - b.order,
  );

  const out: Range[] = [];
  let lastEnd = -1;
  const lostCur: number[] = [];
  for (const h of hits) {
    if (h.start < lastEnd) {
      if (h.cur) lostCur.push(h.start);
      continue;
    }
    out.push({ start: h.start, end: h.end, on: h.on, cur: h.cur });
    lastEnd = h.end;
  }
  // If EVERY fragment of the cursor's row lost the overlap rule (e.g. the
  // current row's "ဖစ်" sits inside another row's "ဖစ်သည်"), the cursor
  // would move in the fix list with nothing lighting up in the text panel.
  // Light the winning range covering the same spot instead.
  if (lostCur.length > 0 && !out.some((r) => r.cur)) {
    for (const start of lostCur) {
      const cover = out.find((r) => r.start <= start && start < r.end);
      if (cover) cover.cur = true;
    }
  }
  return out;
}

/**
 * Split `text` into plain/flagged segments. Joining the segments' text
 * always reproduces the input exactly — highlighting never alters content.
 */
export function highlightText(text: string, rows: FlagSource[]): FlagSeg[] {
  const ranges = collectRanges(text, rows);
  const segs: FlagSeg[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start > pos) segs.push({ type: "plain", text: text.slice(pos, r.start) });
    segs.push({ type: r.on ? "on" : "off", text: text.slice(r.start, r.end), cur: r.cur || undefined });
    pos = r.end;
  }
  if (pos < text.length) segs.push({ type: "plain", text: text.slice(pos) });
  return segs;
}
