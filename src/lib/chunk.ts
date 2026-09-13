//! Client-side chunking of long Burmese text into AI-sized requests.
//!
//! The server caps one request at 4000 chars (neuron-friendly, and small
//! enough for the model to obey "change nothing else"). Long input is split
//! at natural Burmese boundaries — paragraph breaks first, then the section
//! marks ။ (U+104B) and ၊ (U+104A) — and small pieces are re-merged so a
//! 3000-char essay becomes 3 requests, not 60.
//!
//! Invariant: `chunkText(t).join("") === t` — chunks carry their own
//! trailing separators, so the corrected chunks concatenate back into the
//! corrected document (the model is told to preserve structure, so each
//! corrected chunk keeps its separators).

/**
 * Split on a separator pattern, keeping each separator attached to the
 * piece before it (Burmese punctuation trails its sentence). `split` with a
 * single capturing group alternates piece, sep, piece, sep…, so separators
 * land on odd indices.
 */
function splitTrailing(text: string, sepSource: string): string[] {
  const parts = text.split(new RegExp(`(${sepSource})`, "g"));
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // separator — attach to the previous piece when one exists
      if (out.length > 0) out[out.length - 1] += parts[i];
      else out.push(parts[i]);
    } else if (parts[i] !== "") {
      out.push(parts[i]);
    }
  }
  return out;
}

/** ။ — Burmese section mark / full stop (U+104B). */
const SECTION = "\\u104B";
/** ၊ — Burmese little section / comma (U+104A). */
const COMMA = "\\u104A";

/**
 * Split `text` into chunks of at most `max` characters (default 1200),
 * preferring paragraph > sentence (။) > clause (၊) boundaries and merging
 * neighbors that fit together. Never returns an empty array for non-empty
 * input; a single unbreakable run longer than `max` is hard-split.
 */
export function chunkText(text: string, max = 1200): string[] {
  if (text.length === 0) return [];
  if (text.length <= max) return [text];

  // 1. atomic pieces: paragraphs, then ။-sentences, then ၊-clauses.
  const pieces: string[] = [];
  for (const para of splitTrailing(text, "\\n")) {
    if (para.length <= max) {
      pieces.push(para);
      continue;
    }
    for (const sent of splitTrailing(para, SECTION)) {
      if (sent.length <= max) {
        pieces.push(sent);
        continue;
      }
      for (const clause of splitTrailing(sent, COMMA)) {
        pieces.push(clause);
      }
    }
  }

  // 2. merge neighbors while they fit.
  const merged: string[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length + p.length <= max) {
      merged[merged.length - 1] = last + p;
    } else {
      merged.push(p);
    }
  }

  // 3. hard-split anything still over (no punctuation at all). Rare;
  //    correctness over elegance.
  const out: string[] = [];
  for (const p of merged) {
    for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
  }
  return out;
}
