import type { AuditResult } from "../types.js";

// Characters JSON.stringify leaves as they are but a terminal or editor can act on: C1
// controls, zero-width and bidirectional characters, line and paragraph separators, and the
// byte order mark. They only ever occur inside strings, where a \u escape means the same.
const INVISIBLE = /[\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

function escapeChar(ch: string): string {
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * The complete result as JSON. Nothing is truncated or cleaned, so the output parses back to
 * the same object. Characters that are invisible or act on a terminal are written as escapes.
 */
export function renderJson(result: AuditResult): string {
  return `${JSON.stringify(result, null, 2).replace(INVISIBLE, escapeChar)}\n`;
}
