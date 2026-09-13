//! Word-level inline diff between the input text and its corrected version.
//!
//! Tokenizes by whitespace boundaries (whitespace kept as its own tokens so
//! spacing renders in place) and computes an LCS-based diff. Tokens that
//! contain Myanmar script — an unspaced script where a whole phrase would
//! be a single token — are further split into base+combining-mark clusters,
//! so a one-syllable correction highlights just that syllable instead of
//! flagging the entire phrase.
//!
//! Adapted from just-ocr's diff engine (MIT, pndaza).

/** One rendered piece of a diff: unchanged, removed (old), added (new), or
 *  a marker for elided unchanged text (compact edit view). */
export interface DiffSeg {
  type: "same" | "del" | "add" | "gap";
  text: string;
}

const MYANMAR = /\p{Script=Myanmar}/u;
const IS_MARK = /\p{M}/u;

/** Split a token into clusters — one base char plus its following combining
 *  marks (Burmese vowel/asat signs stack onto their consonant). Keeps every
 *  character: a leading mark simply opens its own cluster, so
 *  `clusters(t).join("") === t` always holds. */
function clusters(tok: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of tok) {
    if (cur && IS_MARK.test(ch)) cur += ch;
    else {
      if (cur) out.push(cur);
      cur = ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Split into word and whitespace tokens, alternating; whitespace tokens
 *  participate in matching so runs of spaces diff like words. Myanmar-
 *  script tokens are cluster-split — Burmese has no spaces between words,
 *  so without that split any edit to a phrase would diff the whole phrase
 *  as one del+add pair and the inline diff view would be useless. Cluster
 *  granularity localizes the edit to the changed syllable while keeping
 *  syllable stacks (base + marks) intact. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const tok of text.split(/(\s+)/)) {
    if (!tok) continue;
    if (MYANMAR.test(tok)) out.push(...clusters(tok));
    else out.push(tok);
  }
  return out;
}

/** Upper bound on DP-table cells (n·m) — ~16M cells ≈ 130 MB, comfortably
 *  interactive for documents up to ~8k chars. Above it, fall back to a
 *  coarse whole-region diff rather than allocating a table that could
 *  freeze the tab (batched input can now be arbitrarily long). */
const MAX_DP_CELLS = 16_000_000;

/**
 * Word-level diff of `a` (original) against `b` (corrected). Adjacent
 * same-type segments are merged so the result renders compactly.
 *
 * Cost scales with the EDITED region, not the document: identical input
 * returns immediately, and common heads/tails are trimmed before the
 * quadratic DP — so the common "model returned the text unchanged" case is
 * linear even at the app's input cap.
 */
export function diffWords(a: string, b: string): DiffSeg[] {
  if (a === b) return a === "" ? [] : [{ type: "same", text: a }];
  const at = tokenize(a);
  const bt = tokenize(b);

  const segs: DiffSeg[] = [];
  const push = (type: DiffSeg["type"], text: string) => {
    const last = segs[segs.length - 1];
    if (last && last.type === type) last.text += text;
    else segs.push({ type, text });
  };

  // trim the identical head and tail — only the middle is worth a DP table
  let lo = 0;
  while (lo < at.length && lo < bt.length && at[lo] === bt[lo]) lo++;
  let ha = at.length;
  let hb = bt.length;
  while (ha > lo && hb > lo && at[ha - 1] === bt[hb - 1]) {
    ha--;
    hb--;
  }
  if (lo > 0) push("same", at.slice(0, lo).join(""));
  const tail = ha < at.length ? at.slice(ha).join("") : "";

  const midA = at.slice(lo, ha);
  const midB = bt.slice(lo, hb);
  const n = midA.length;
  const m = midB.length;

  if (n * m > MAX_DP_CELLS) {
    // coarse fallback: too different to diff finely — show one replacement
    if (n > 0) push("del", midA.join(""));
    if (m > 0) push("add", midB.join(""));
  } else {
    // dp[i][j] = LCS length of midA[i..] vs midB[j..]
    const dp: number[][] = Array.from({ length: n + 1 }, () =>
      new Array<number>(m + 1).fill(0),
    );
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] =
          midA[i] === midB[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        push("same", midA[i]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        push("del", midA[i]);
        i++;
      } else {
        push("add", midB[j]);
        j++;
      }
    }
    while (i < n) push("del", midA[i++]);
    while (j < m) push("add", midB[j++]);
  }
  if (tail) push("same", tail);
  return segs;
}

/**
 * Compact edit view: like {@link diffWords} but drops unchanged text,
 * keeping only the removed/added parts. A single "gap" segment ("…") marks
 * each run of skipped content BETWEEN edits (never leading or trailing), so
 * multiple edits read clearly without the unchanged context.
 */
export function diffEdits(a: string, b: string): DiffSeg[] {
  const words = diffWords(a, b);
  // index of the last non-same segment — answers "is another edit after i?"
  // in O(1) instead of rescanning the tail per same-run
  let lastChange = -1;
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i].type !== "same") {
      lastChange = i;
      break;
    }
  }
  const out: DiffSeg[] = [];
  for (let i = 0; i < words.length; i++) {
    const seg = words[i];
    if (seg.type === "same") {
      if (!seg.text.trim() || out.length === 0) continue;
      const hasNext = i < lastChange;
      if (hasNext && out[out.length - 1].type !== "gap") {
        out.push({ type: "gap", text: "…" });
      }
    } else {
      const last = out[out.length - 1];
      if (last && last.type === seg.type) last.text += seg.text;
      else out.push({ ...seg });
    }
  }
  return out;
}

/** Number of distinct edits — a del-run immediately followed by an add-run
 *  counts as ONE edit (a replacement), trailing pure-del or pure-add runs
 *  count as their own edits. Drives the "N places fixed" summary. */
export function countEdits(segs: DiffSeg[]): number {
  let n = 0;
  let inRun = false;
  for (const s of segs) {
    if (s.type === "del" || s.type === "add") {
      if (!inRun) {
        n++;
        inRun = true;
      }
    } else {
      inRun = false;
    }
  }
  return n;
}
