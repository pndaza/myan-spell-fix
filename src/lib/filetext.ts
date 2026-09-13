//! Preparing an opened plain-text file for the editor: newline
//! normalization and a surrogate-safe length cap.

/** Normalize CRLF / lone-CR newlines to \n (Windows files carry invisible
 *  \r that would otherwise confuse the chunker, the diff, and the editor
 *  itself) and cap the length without ever splitting a surrogate pair —
 *  a cut between the halves of an emoji would corrupt the text. */
export function prepareText(
  raw: string,
  max: number,
): { text: string; truncated: boolean } {
  const text = raw.replace(/\r\n?/g, "\n");
  if (text.length <= max) return { text, truncated: false };
  let cut = max;
  const prev = text.charCodeAt(cut - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  return { text: text.slice(0, cut), truncated: true };
}
