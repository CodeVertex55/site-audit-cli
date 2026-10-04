const ELLIPSIS = "...";
const ESC = 0x1b;
const BEL = 0x07;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;

function isWhitespace(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** C0 and C1 controls, zero-width characters, bidirectional controls and the byte order mark. */
function isUnsafe(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    code === 0x61c ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** The Unicode tag characters, U+E0000 to U+E007F, which render as nothing. */
function isTagCharacter(point: number): boolean {
  return point >= 0xe0000 && point <= 0xe007f;
}

/** Where the control string opened at `from` ends, or -1 when no terminator follows. */
function stringEnd(text: string, from: number): number {
  for (let j = from; j < text.length; j++) {
    const code = text.charCodeAt(j);
    if (code === BEL || code === C1_ST) return j + 1;
    if (code === ESC && text.charCodeAt(j + 1) === 0x5c) return j + 2;
  }
  return -1;
}

/**
 * Returns the index just after the escape sequence that starts at `i`, where the character
 * there is ESC or the C1 control sequence introducer. Scans forward once and never backtracks:
 * a control sequence is its parameter bytes, its intermediate bytes and one final byte, and a
 * control string runs to its terminator. A lone escape, or a string with no terminator, drops
 * only the introducer so that nothing after it can be hidden.
 */
function skipEscape(text: string, i: number, hasTerminator: boolean): number {
  let j = i + 1;
  if (text.charCodeAt(i) === ESC) {
    const next = text.charCodeAt(j);
    if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
      // OSC, DCS, SOS, PM and APC strings
      if (!hasTerminator) return j + 1;
      const end = stringEnd(text, j + 1);
      return end === -1 ? j + 1 : end;
    }
    if (next !== 0x5b) return j;
    j += 1;
  }
  while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j++;
  while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
  if (j < text.length && text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e) j++;
  return j;
}

/** Strips unsafe characters and escape sequences and collapses whitespace. Does not cap. */
function tidy(text: string): string {
  const lastTerminator = Math.max(
    text.lastIndexOf("\u0007"),
    text.lastIndexOf("\u009c"),
    text.lastIndexOf("\u001b\\") + 1,
  );
  let out = "";
  let pendingSpace = false;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === ESC || code === C1_CSI) {
      i = skipEscape(text, i, lastTerminator > i);
      continue;
    }
    if (isWhitespace(code)) {
      pendingSpace = out.length > 0;
      i++;
      continue;
    }
    if (isUnsafe(code)) {
      i++;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one character; Unicode tag characters are invisible and dropped.
      const point = text.codePointAt(i) ?? code;
      const width = point > 0xffff ? 2 : 1;
      if (isTagCharacter(point)) {
        i += width;
        continue;
      }
      if (pendingSpace) out += " ";
      pendingSpace = false;
      out += text.slice(i, i + width);
      i += width;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += text[i];
    i++;
  }
  return out;
}

/** Cuts the end off at `max` characters (code points), ending with an ellipsis. */
function clipEnd(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= ELLIPSIS.length) return ELLIPSIS.slice(0, Math.max(0, max));
  return chars.slice(0, max - ELLIPSIS.length).join("") + ELLIPSIS;
}

/** Cuts the middle out at `max` characters (code points), keeping both ends. */
function clipMiddle(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= ELLIPSIS.length) return ELLIPSIS.slice(0, Math.max(0, max));
  const keep = max - ELLIPSIS.length;
  const head = Math.ceil(keep / 2);
  return (
    chars.slice(0, head).join("") + ELLIPSIS + chars.slice(chars.length - (keep - head)).join("")
  );
}

/**
 * Makes text from the audited site safe to print. Removes control characters, ANSI escape
 * sequences, bidirectional controls and zero-width characters, collapses whitespace, and
 * caps the length with a trailing ellipsis.
 */
export function clean(value: string, max = 200): string {
  return clipEnd(tidy(value), max);
}

/** As `clean`, for URLs: over the cap, the middle is replaced by an ellipsis. */
export function cleanUrl(value: string, max = 300): string {
  return clipMiddle(tidy(value), max);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Escapes the characters Markdown reads as syntax anywhere in a line: backslash, backtick,
 * asterisk, underscore, square brackets, angle brackets, pipe and hash, and an @ at the start of
 * a word, so it cannot form a mention. Parentheses are left alone because escaped brackets
 * already stop a link from forming.
 */
export function escapeMarkdownInline(value: string): string {
  return value.replace(/[\\`*_[\]<>|#]|(?<![\p{L}\p{N}_])@/gu, "\\$&");
}

/** `escapeMarkdownInline`, plus a list marker (`-`, `+`, or a number and a dot or bracket) at the start. */
export function escapeMarkdown(value: string): string {
  const escaped = escapeMarkdownInline(value);
  if (escaped.startsWith("-") || escaped.startsWith("+")) return `\\${escaped}`;
  return escaped.replace(/^(\d+)([.)])/, "$1\\$2");
}

export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
