import type { AuditResult } from "../types.js";

// Characters JSON.stringify leaves as they are but a terminal or editor can act on: C1
// controls, the soft hyphen, the Arabic letter mark, zero-width and bidirectional characters,
// line and paragraph separators, the byte order mark and the Unicode tag characters. They only
// ever occur inside strings, where a \u escape means the same. The u flag makes the astral
// tag range match whole characters.
const INVISIBLE =
  /[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/** Every UTF-16 unit of the character, so an astral character becomes a pair of escapes. */
function escapeChar(ch: string): string {
  let out = "";
  for (let i = 0; i < ch.length; i++) {
    out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
  }
  return out;
}

/**
 * The complete result as JSON. Nothing is truncated or cleaned, so the output parses back to
 * the same object. Characters that are invisible or act on a terminal are written as escapes.
 */
export function renderJson(result: AuditResult): string {
  return `${JSON.stringify(result, null, 2).replace(INVISIBLE, escapeChar)}\n`;
}
