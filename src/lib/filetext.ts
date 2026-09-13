//! Preparing an opened plain-text file for the editor.

/** Normalize CRLF / lone-CR newlines to \n (Windows files carry invisible
 *  \r that would otherwise confuse the chunker, the diff, and the editor
 *  itself). Total length is deliberately NOT capped — long documents are
 *  processed in batches, not rejected. */
export function normalizeText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n");
}
