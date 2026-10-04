import { describe, expect, test } from "vitest";
import { UsageError } from "../src/errors.js";
import {
  isExcluded,
  normaliseUrl,
  originOf,
  parseStartUrl,
  pathWithQuery,
  sameOrigin,
  siblingHost,
} from "../src/crawl/url.js";

describe("parseStartUrl", () => {
  test.each([
    ["example.com", "https://example.com/"],
    ["HTTP://Example.COM:80/a/../b#frag", "http://example.com/b"],
    ["https://example.com:443/x?b=2&a=1", "https://example.com/x?b=2&a=1"],
    ["  example.com/docs  ", "https://example.com/docs"],
    ["localhost:3000", "https://localhost:3000/"],
    ["127.0.0.1:8080/x", "https://127.0.0.1:8080/x"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080/"],
  ])("parseStartUrl(%s)", (input, want) => {
    expect(parseStartUrl(input)).toBe(want);
  });

  test.each([
    "ftp://example.com",
    "https://user:pw@example.com/",
    "https://user@example.com/",
    "",
    "   ",
    "http://",
    "javascript:alert(1)",
    "mailto:a@example.com",
  ])("parseStartUrl rejects %s", (bad) => {
    expect(() => parseStartUrl(bad)).toThrow(UsageError);
  });
});

describe("normaliseUrl", () => {
  test.each([
    ["/a#x", "https://example.com/dir/", "https://example.com/a"],
    ["b/c", "https://example.com/dir/", "https://example.com/dir/b/c"],
    ["mailto:a@example.com", "https://example.com/", null],
    ["tel:+15550100", "https://example.com/", null],
    ["javascript:void(0)", "https://example.com/", null],
    ["data:text/plain,hi", "https://example.com/", null],
    ["//cdn.example/x.js", "https://example.com/", "https://cdn.example/x.js"],
    ["http://[bad", "https://example.com/", null],
    [
      "HTTPS://EXAMPLE.com:443/A?Q=1&b=2#top",
      "https://example.com/",
      "https://example.com/A?Q=1&b=2",
    ],
    ["../up", "https://example.com/a/b/", "https://example.com/a/up"],
    ["  /trim  ", "https://example.com/", "https://example.com/trim"],
    ["/page?", "https://example.com/", "https://example.com/page?"],
    ["", "https://example.com/dir/page", "https://example.com/dir/page"],
  ])("normaliseUrl(%s, %s)", (href, base, want) => {
    expect(normaliseUrl(href, base)).toBe(want);
  });

  test("works without a base for absolute URLs", () => {
    expect(normaliseUrl("http://Example.com:80/x#y")).toBe("http://example.com/x");
  });

  test("returns null for a relative href without a base", () => {
    expect(normaliseUrl("/a")).toBeNull();
  });
});

describe("originOf, sameOrigin, pathWithQuery", () => {
  test("originOf", () => {
    expect(originOf("https://example.com/a?b=1")).toBe("https://example.com");
    expect(originOf("http://example.com:8080/a")).toBe("http://example.com:8080");
  });

  test.each([
    ["https://example.com/a", "https://example.com/b?x=1", true],
    ["https://example.com/", "http://example.com/", false],
    ["https://example.com/", "https://www.example.com/", false],
    ["https://example.com/", "https://example.com:8443/", false],
    ["https://example.com/", "not a url", false],
  ])("sameOrigin(%s, %s)", (a, b, want) => {
    expect(sameOrigin(a, b)).toBe(want);
  });

  test.each([
    ["https://example.com/a/b?x=1", "/a/b?x=1"],
    ["https://example.com", "/"],
    ["https://example.com/a#frag", "/a"],
  ])("pathWithQuery(%s)", (url, want) => {
    expect(pathWithQuery(url)).toBe(want);
  });
});

describe("isExcluded", () => {
  test.each([
    ["https://example.com/blog/a", ["/blog/*"], true],
    ["https://example.com/blog/a/b", ["/blog/*"], false],
    ["https://example.com/blog/a/b", ["/blog/**"], true],
    ["https://example.com/shop", ["/blog/**"], false],
    ["https://example.com/shop", [], false],
    ["https://example.com/shop", ["/blog/**", "/shop"], true],
    ["https://example.com/a.pdf", ["/*.pdf"], true],
    ["https://example.com/docs/a.pdf", ["/*.pdf"], false],
    ["https://example.com/docs/a.pdf", ["/**.pdf"], true],
    ["https://example.com/blog/a?page=2", ["/blog/*"], true],
    ["https://example.com/blogger", ["/blog"], false],
    ["not a url", ["/**"], false],
  ])("isExcluded(%s, %j)", (url, pats, want) => {
    expect(isExcluded(url, pats)).toBe(want);
  });

  test("matches in bounded time on adversarial input", () => {
    const url = "https://example.com/" + "a".repeat(20000);
    const start = Date.now();
    expect(isExcluded(url, ["/*a*a*a*a*a*a*a*a*a*b"])).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("siblingHost", () => {
  test.each([
    ["example.com", "www.example.com"],
    ["www.example.com", "example.com"],
    ["EXAMPLE.com", "www.example.com"],
    ["127.0.0.1", null],
    ["[::1]", null],
    ["::1", null],
    ["localhost", null],
    ["www.localhost", null],
    ["intranet", null],
    ["shop.example.com", null],
    ["www", null],
    ["", null],
  ])("siblingHost(%s)", (h, want) => {
    expect(siblingHost(h)).toBe(want);
  });
});
