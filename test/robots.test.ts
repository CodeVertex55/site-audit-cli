import { describe, expect, test } from "vitest";
import {
  crawlDelayMs,
  disallowsEverything,
  isAllowed,
  parseRobots,
  patternMatches,
  selectGroup,
} from "../src/crawl/robots.js";

const file = parseRobots(`
# comment
User-agent: *
Disallow: /private/
Allow: /private/public.html
Disallow: /*.pdf$
Crawl-delay: 2

User-agent: site-audit-cli
Disallow: /only-me/

Sitemap: https://example.com/sitemap.xml
`);

describe("group selection and matching", () => {
  test("group selection prefers the specific agent", () => {
    expect(isAllowed(file, "site-audit-cli", "/private/x")).toBe(true);
    expect(isAllowed(file, "site-audit-cli", "/only-me/x")).toBe(false);
    expect(isAllowed(file, "otherbot", "/private/x")).toBe(false);
    expect(isAllowed(file, "otherbot", "/private/public.html")).toBe(true);
    expect(isAllowed(file, "otherbot", "/files/a.pdf")).toBe(false);
    expect(isAllowed(file, "otherbot", "/files/a.pdf?x=1")).toBe(true);
    expect(file.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(crawlDelayMs(file, "otherbot")).toEqual({ ms: 2000, clamped: false });
    expect(crawlDelayMs(file, "site-audit-cli")).toEqual({ ms: null, clamped: false });
  });

  test("agent match is a case-insensitive prefix of the token, longest wins", () => {
    const f = parseRobots(
      "User-agent: Site\nDisallow: /a\n\nUser-agent: site-audit\nDisallow: /b\n\nUser-agent: *\nDisallow: /c\n",
    );
    expect(selectGroup(f, "SITE-AUDIT-CLI")?.agents).toEqual(["site-audit"]);
    expect(selectGroup(f, "site-other")?.agents).toEqual(["Site"]);
    expect(selectGroup(f, "other")?.agents).toEqual(["*"]);
  });

  test("returns null when no group matches and there is no star group", () => {
    const f = parseRobots("User-agent: somebot\nDisallow: /\n");
    expect(selectGroup(f, "site-audit-cli")).toBeNull();
    expect(isAllowed(f, "site-audit-cli", "/anything")).toBe(true);
    expect(crawlDelayMs(f, "site-audit-cli")).toEqual({ ms: null, clamped: false });
  });

  test("consecutive User-agent lines share one group", () => {
    const f = parseRobots("User-agent: botone\nUser-agent: bottwo\nDisallow: /x\n");
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0]?.agents).toEqual(["botone", "bottwo"]);
    expect(isAllowed(f, "botone", "/x")).toBe(false);
    expect(isAllowed(f, "bottwo", "/x")).toBe(false);
    expect(isAllowed(f, "botthree", "/x")).toBe(true);
  });

  test("a User-agent line after rules starts a new group", () => {
    const f = parseRobots("User-agent: a\nDisallow: /1\nUser-agent: b\nDisallow: /2\n");
    expect(f.groups).toHaveLength(2);
  });

  test("empty Disallow allows everything", () => {
    const f = parseRobots("User-agent: *\nDisallow:\n");
    expect(isAllowed(f, "x", "/anything")).toBe(true);
    expect(disallowsEverything(f)).toBe(false);
  });

  test("longest pattern wins and Allow wins ties", () => {
    const f = parseRobots(
      "User-agent: *\nDisallow: /a/b\nAllow: /a\nDisallow: /same\nAllow: /same\n",
    );
    expect(isAllowed(f, "x", "/a/b/c")).toBe(false);
    expect(isAllowed(f, "x", "/a/z")).toBe(true);
    expect(isAllowed(f, "x", "/same")).toBe(true);
  });

  test("an empty file allows everything", () => {
    const f = parseRobots("");
    expect(f).toEqual({ groups: [], sitemaps: [] });
    expect(isAllowed(f, "x", "/anything")).toBe(true);
    expect(disallowsEverything(f)).toBe(false);
  });
});

describe("disallowsEverything", () => {
  test("true for Disallow slash with no Allow rules", () => {
    expect(disallowsEverything(parseRobots("User-agent: *\nDisallow: /\n"))).toBe(true);
  });

  test("false when an Allow rule exists", () => {
    expect(disallowsEverything(parseRobots("User-agent: *\nDisallow: /\nAllow: /ok\n"))).toBe(
      false,
    );
  });

  test("false when only a specific agent disallows", () => {
    expect(disallowsEverything(parseRobots("User-agent: badbot\nDisallow: /\n"))).toBe(false);
  });

  test("false when only a sub-path is disallowed", () => {
    expect(disallowsEverything(parseRobots("User-agent: *\nDisallow: /private/\n"))).toBe(false);
  });
});

describe("crawl delay", () => {
  test("clamps at 30 seconds", () => {
    const f = parseRobots("User-agent: *\nCrawl-delay: 120\n");
    expect(crawlDelayMs(f, "x")).toEqual({ ms: 30000, clamped: true });
  });

  test("exactly 30 seconds is not clamped", () => {
    const f = parseRobots("User-agent: *\nCrawl-delay: 30\n");
    expect(crawlDelayMs(f, "x")).toEqual({ ms: 30000, clamped: false });
  });

  test("accepts fractions and ignores invalid values", () => {
    expect(crawlDelayMs(parseRobots("User-agent: *\nCrawl-delay: 0.5\n"), "x").ms).toBe(500);
    expect(crawlDelayMs(parseRobots("User-agent: *\nCrawl-delay: soon\n"), "x").ms).toBeNull();
    expect(crawlDelayMs(parseRobots("User-agent: *\nCrawl-delay: -3\n"), "x").ms).toBeNull();
  });
});

describe("tolerant parsing", () => {
  test("handles CRLF, a byte order mark, unknown directives and garbage", () => {
    const text =
      "﻿User-agent: *\r\nDisallow: /secret\r\nHost: example.com\r\nthis line is garbage\r\n" +
      ": no name\r\nNoindex: /x\r\nSitemap: https://example.com/a.xml\r\n";
    const f = parseRobots(text);
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0]?.rules).toEqual([{ allow: false, pattern: "/secret" }]);
    expect(f.sitemaps).toEqual(["https://example.com/a.xml"]);
    expect(isAllowed(f, "x", "/secret")).toBe(false);
  });

  test("strips trailing comments and is case-insensitive on directives", () => {
    const f = parseRobots(
      "USER-AGENT: * # everyone\nDISALLOW: /x # no\nsitemap: https://example.com/s.xml\n",
    );
    expect(isAllowed(f, "any", "/x")).toBe(false);
    expect(f.sitemaps).toEqual(["https://example.com/s.xml"]);
  });

  test("rules before any User-agent line are ignored", () => {
    const f = parseRobots("Disallow: /x\nUser-agent: *\nDisallow: /y\n");
    expect(isAllowed(f, "any", "/x")).toBe(true);
    expect(isAllowed(f, "any", "/y")).toBe(false);
  });

  test("keeps colons inside values", () => {
    const f = parseRobots("User-agent: *\nDisallow: /a:b\n");
    expect(isAllowed(f, "any", "/a:b")).toBe(false);
  });
});

describe("patternMatches", () => {
  test.each([
    ["/", "/anything", true],
    ["/a", "/a", true],
    ["/a", "/ab", true],
    ["/a", "/b", false],
    ["/a$", "/a", true],
    ["/a$", "/ab", false],
    ["/*.pdf", "/x/y.pdf", true],
    ["/*.pdf$", "/x/y.pdf", true],
    ["/*.pdf$", "/x/y.pdf?q=1", false],
    ["/a*b", "/a/zzz/b/c", true],
    ["/a*b$", "/a/zzz/b/c", false],
    ["/a*b$", "/ab", true],
    ["/*", "/x", true],
    ["/a**b", "/axxb", true],
    ["/ab*ba$", "/aba", false],
    ["/ab*ba$", "/abba", true],
    ["", "/x", true],
  ])("patternMatches(%s, %s)", (pattern, path, want) => {
    expect(patternMatches(pattern, path)).toBe(want);
  });

  test("returns quickly on a pathological pattern", () => {
    const start = Date.now();
    const got = patternMatches("/a*b*c*d*e*f*g*h$", "/" + "a".repeat(50000));
    expect(got).toBe(false);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
