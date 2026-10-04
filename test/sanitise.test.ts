import { describe, expect, test } from "vitest";
import {
  clean,
  cleanUrl,
  escapeHtml,
  escapeMarkdown,
  escapeMarkdownInline,
  isHttpUrl,
} from "../src/report/sanitise.js";
import { HOSTILE, UNSAFE } from "./helpers/result.js";

describe("clean", () => {
  test("removes control, ANSI and bidi characters and caps length", () => {
    const out = clean(HOSTILE);
    expect(out).not.toMatch(UNSAFE);
    expect(out).not.toContain("\n");
    expect(out).not.toContain("[31m");
    expect(out).not.toContain("[0m");
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("...")).toBe(true);
    expect(clean("a \n\t b")).toBe("a b");
  });

  test("keeps the words around an ANSI sequence", () => {
    expect(clean("before \u001b[1;31mred\u001b[0m after")).toBe("before red after");
  });

  test("removes sequences with intermediate bytes, OSC strings and the C1 introducer", () => {
    expect(clean("a\u001b[?25lb")).toBe("ab");
    expect(clean("a\u001b]0;window title\u0007b")).toBe("ab");
    expect(clean("a\u001b]8;;https://x.example\u001b\\link\u001b]8;;\u001b\\b")).toBe("alinkb");
    expect(clean("a\u009b31mb")).toBe("ab");
  });

  test("drops a lone escape and an unfinished string without hiding the text after it", () => {
    expect(clean("a\u001bb")).toBe("ab");
    expect(clean("a\u001b[31")).toBe("a");
    expect(clean("a\u001b")).toBe("a");
    expect(clean("a\u001b]no terminator here")).toBe("ano terminator here");
  });

  test("removes zero-width and bidi characters and keeps ordinary non-ASCII text", () => {
    expect(clean("a\u200bb\u200ec\u2066d\u2069e\ufeff\u2060f")).toBe("abcdef");
    expect(clean("caf\u00e9 \u4e2d\u6587")).toBe("caf\u00e9 \u4e2d\u6587");
  });

  test("removes Unicode tag characters, the soft hyphen and the Arabic letter mark", () => {
    const tags = "\u{E0041}\u{E0062}\u{E007F}";
    expect(clean(`a${tags}b\u00adc\u061cd`)).toBe("abcd");
    expect(clean(`x ${tags} y`)).toBe("x y");
    expect(clean("\u{1F600}\u{E0020}\u{1F600}")).toBe("\u{1F600}\u{1F600}");
  });

  test("collapses every kind of whitespace and trims", () => {
    expect(clean("  a\u00a0\u00a0b\r\nc\u2028d  ")).toBe("a b c d");
    expect(clean("   ")).toBe("");
  });

  test("honours a custom cap and leaves a string at the cap alone", () => {
    expect(clean("abcdefghij", 10)).toBe("abcdefghij");
    expect(clean("abcdefghijk", 10)).toBe("abcdefg...");
  });

  test("counts characters, not UTF-16 units, when capping", () => {
    const out = clean("\u{1F600}".repeat(20), 10);
    expect(Array.from(out)).toHaveLength(10);
    expect(out.endsWith("...")).toBe(true);
  });
});

describe("cleanUrl", () => {
  test("keeps both ends", () => {
    const u = cleanUrl("https://site.example/" + "x".repeat(400) + "/end.html");
    expect(u.length).toBeLessThanOrEqual(300);
    expect(u.startsWith("https://site.example/")).toBe(true);
    expect(u.endsWith("/end.html")).toBe(true);
    expect(u).toContain("...");
  });

  test("strips hostile characters and honours a custom cap", () => {
    expect(cleanUrl("https://site.example/a\u202eb")).toBe("https://site.example/ab");
    expect(cleanUrl("https://site.example/" + "y".repeat(50), 20)).toHaveLength(20);
  });
});

describe("escapeHtml", () => {
  test("escapes the five markup characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("escapeMarkdown", () => {
  test("neutralises table and link syntax", () => {
    expect(escapeMarkdown("a|b [x](y) `z` <i>")).toBe("a\\|b \\[x\\](y) \\`z\\` \\<i\\>");
  });

  test("escapes backslashes, emphasis markers and headings", () => {
    expect(escapeMarkdown("a\\b *c* _d_ # e")).toBe("a\\\\b \\*c\\* \\_d\\_ \\# e");
  });

  test("escapes a leading list marker or numbered-list marker only", () => {
    expect(escapeMarkdown("- item")).toBe("\\- item");
    expect(escapeMarkdown("+ item")).toBe("\\+ item");
    expect(escapeMarkdown("12. item")).toBe("12\\. item");
    expect(escapeMarkdown("a - b + c 1. d")).toBe("a - b + c 1. d");
    expect(escapeMarkdown("1) item")).toBe("1\\) item");
    expect(escapeMarkdown("12) item")).toBe("12\\) item");
    expect(escapeMarkdown("a 1) b")).toBe("a 1) b");
  });
});

describe("escapeMarkdownInline", () => {
  test("leaves a leading list marker alone, for text that does not start a line", () => {
    expect(escapeMarkdownInline("12.3 seconds")).toBe("12.3 seconds");
    expect(escapeMarkdownInline("- a|b")).toBe("- a\\|b");
  });
});

describe("isHttpUrl", () => {
  test("accepts http and https only", () => {
    expect(isHttpUrl("https://site.example/a")).toBe(true);
    expect(isHttpUrl("http://site.example")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,x")).toBe(false);
    expect(isHttpUrl("ftp://site.example/")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});
