//! Inline highlighting of flagged fragments in the original text — the
//! left panel of manual mode's two-panel review (just-ocr style: the text
//! panel highlights what the fix list flags). Every occurrence of a found
//! suggestion's `wrong` fragment becomes a flagged span: active (checked —
//! will be fixed) or muted (unchecked — rejected by the user).
//!
//! Two steps, so the expensive part runs once: `scanFlags` sweeps the text
//! for fragment occurrences (cost scales with text × rows), and
//! `renderFlags` maps check/cursor state onto that scan. Checking a box or
//! moving the review cursor re-renders without rescanning — at document
//! sizes, a rescan per keystroke would jank the review panel.

/** One rendered piece of the highlighted text. `cur` marks fragments that
 *  belong to the keyboard-cursor's suggestion row (the one whose left
 *  vertical indicator is lit in the fix list). */
export interface FlagSeg {
  type: "plain" | "on" | "off";
  text: string;
  cur?: boolean;
}

/** The fields scanFlags needs from a suggestion row. */
export interface FlagFrag {
  wrong: string;
  found: boolean;
}

/** Per-row state applied at render time — the part that changes as the
 *  user reviews, cheap to re-apply over an existing scan. */
export interface FlagState {
  checked: boolean;
  /** True for the row the review cursor is on. */
  current?: boolean;
}

/** One overlap-resolved occurrence range, in text order. */
export interface FlagRange {
  start: number;
  end: number;
  /** Index of the suggestion row that owns the fragment. */
  order: number;
}

/** Result of the occurrence scan — everything independent of the
 *  check/cursor state. */
export interface FlagScan {
  /** Non-overlapping winning ranges, in text order. */
  ranges: FlagRange[];
  /** Raw (pre-overlap) hit starts per row — the render step needs them to
   *  light a covering winner when the cursor row loses every overlap. */
  rawStarts: number[][];
}

/** The fields highlightText needs from a suggestion row (one-shot scan +
 *  render). */
export interface FlagSource extends FlagFrag, FlagState {}

/**
 * Occurrences of `frag` in `text` — an indexOf loop, never `split`:
 * split(".").length - 1 allocates every piece, which explodes when a
 * common fragment occurs often in a long document.
 */
export function countOccurrences(text: string, frag: string): number {
  // guard by contract, not by caller discipline: an empty fragment matches
  // at every index and would loop forever below
  if (frag.length === 0) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(frag, from);
    if (at === -1) return n;
    n += 1;
    from = at + frag.length;
  }
}

/**
 * Sweep `text` for every found fragment's occurrences and resolve
 * overlaps. Overlap rule: earlier-starting wins; at the same start, the
 * longer fragment wins; ties break by suggestion order — deterministic no
 * matter how the model orders its pairs (e.g. "ဖစ်" inside "ဖစ်သည်" flags
 * only the longer one). Occurrences of one fragment never overlap
 * themselves (search resumes at the previous match's end).
 */
export function scanFlags(text: string, frags: FlagFrag[]): FlagScan {
  const rawStarts: number[][] = [];
  const hits: FlagRange[] = [];
  frags.forEach((row, order) => {
    // same empty-fragment guard as countOccurrences
    if (!row.found || row.wrong.length === 0) {
      rawStarts.push([]);
      return;
    }
    const starts: number[] = [];
    let from = 0;
    for (;;) {
      const at = text.indexOf(row.wrong, from);
      if (at === -1) break;
      starts.push(at);
      hits.push({ start: at, end: at + row.wrong.length, order });
      from = at + row.wrong.length;
    }
    rawStarts.push(starts);
  });

  hits.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      a.order - b.order,
  );

  const ranges: FlagRange[] = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.start < lastEnd) continue;
    ranges.push(h);
    lastEnd = h.end;
  }
  return { ranges, rawStarts };
}

/**
 * Map check/cursor state onto a scan: on/off per range from `checked`,
 * `cur` from `current`. If EVERY fragment of the cursor's row lost the
 * overlap rule (e.g. the current row's "ဖစ်" sits inside another row's
 * "ဖစ်သည်"), the cursor would move in the fix list with nothing lighting
 * up in the text panel — light the winning range covering the same spot
 * instead. Splitting `text` into plain/flagged segments never alters
 * content: joining the segments' text reproduces the input exactly.
 */
export function renderFlags(
  text: string,
  scan: FlagScan,
  states: FlagState[],
): FlagSeg[] {
  const rs = scan.ranges.map((r) => ({
    ...r,
    on: states[r.order]?.checked === true,
    cur: states[r.order]?.current === true,
  }));
  if (!rs.some((r) => r.cur)) {
    const lost: number[] = [];
    states.forEach((s, i) => {
      // only the cursor row's fragments participate — collecting every
      // row's starts would outline the whole document's flags
      if (s.current !== true) return;
      // loop, not spread: a common fragment can occur very many times
      for (const start of scan.rawStarts[i] ?? []) lost.push(start);
    });
    if (lost.length > 0) {
      // ranges are non-overlapping and ascending, so walk them in step
      // with the sorted starts instead of rescanning per start
      lost.sort((x, y) => x - y);
      let ri = 0;
      for (const start of lost) {
        while (ri < rs.length && rs[ri].end <= start) ri++;
        const cover = rs[ri];
        if (cover && cover.start <= start) cover.cur = true;
      }
    }
  }

  const segs: FlagSeg[] = [];
  let pos = 0;
  for (const r of rs) {
    if (r.start > pos) segs.push({ type: "plain", text: text.slice(pos, r.start) });
    segs.push({ type: r.on ? "on" : "off", text: text.slice(r.start, r.end), cur: r.cur || undefined });
    pos = r.end;
  }
  if (pos < text.length) segs.push({ type: "plain", text: text.slice(pos) });
  return segs;
}

/** One-shot highlight: scan + render in a single call. */
export function highlightText(text: string, rows: FlagSource[]): FlagSeg[] {
  return renderFlags(text, scanFlags(text, rows), rows);
}
