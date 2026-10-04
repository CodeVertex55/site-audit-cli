import { describe, expect, test } from "vitest";
import { parseSitemap } from "../src/crawl/sitemap.js";

const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';

describe("parseSitemap", () => {
  test("urlset: trims, normalises and de-duplicates", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset ${NS}>
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/a</loc></url>
  <url><loc>
    https://example.com/b#frag
  </loc></url>
</urlset>`;
    expect(parseSitemap(xml)).toEqual({
      kind: "urlset",
      urls: ["https://example.com/a", "https://example.com/b"],
    });
  });

  test("sitemapindex returns the child sitemap URLs", () => {
    const xml = `<?xml version="1.0"?>
<sitemapindex ${NS}>
  <sitemap><loc>https://example.com/s1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/s2.xml</loc></sitemap>
</sitemapindex>`;
    expect(parseSitemap(xml)).toEqual({
      kind: "index",
      urls: ["https://example.com/s1.xml", "https://example.com/s2.xml"],
    });
  });

  test.each([
    ["html", "<!doctype html><html><body><h1>Not found</h1></body></html>"],
    ["plain text", "this is not xml at all"],
    ["empty", ""],
    [
      "other root",
      `<?xml version="1.0"?><rss><channel><link>https://example.com/</link></channel></rss>`,
    ],
  ])("%s is invalid", (_name, body) => {
    expect(parseSitemap(body)).toEqual({ kind: "invalid", urls: [] });
  });

  test("drops non-http locations and empty locs", () => {
    const xml = `<urlset ${NS}>
  <url><loc>ftp://example.com/a</loc></url>
  <url><loc>javascript:alert(1)</loc></url>
  <url><loc>   </loc></url>
  <url><loc>/relative</loc></url>
  <url><loc>https://example.com/ok</loc></url>
</urlset>`;
    expect(parseSitemap(xml).urls).toEqual(["https://example.com/ok"]);
  });

  test("decodes entities and CDATA", () => {
    const xml = `<urlset ${NS}>
  <url><loc>https://example.com/a?x=1&amp;y=2</loc></url>
  <url><loc><![CDATA[https://example.com/c?p=1&q=2]]></loc></url>
</urlset>`;
    expect(parseSitemap(xml).urls).toEqual([
      "https://example.com/a?x=1&y=2",
      "https://example.com/c?p=1&q=2",
    ]);
  });

  test("ignores loc elements outside url entries", () => {
    const xml = `<urlset ${NS}>
  <url><loc>https://example.com/a</loc><image:image xmlns:image="x"><image:loc>https://example.com/img.png</image:loc></image:image></url>
</urlset>`;
    expect(parseSitemap(xml).urls).toEqual(["https://example.com/a"]);
  });

  test("enforces the cap, default 5000", () => {
    const locs = Array.from(
      { length: 6000 },
      (_, i) => `<url><loc>https://example.com/p${i}</loc></url>`,
    );
    const xml = `<urlset ${NS}>${locs.join("")}</urlset>`;
    expect(parseSitemap(xml).urls).toHaveLength(5000);
    expect(parseSitemap(xml, 3).urls).toEqual([
      "https://example.com/p0",
      "https://example.com/p1",
      "https://example.com/p2",
    ]);
  });

  test.each([20_000, 100_000])(
    "%i nested elements inside a loc finish quickly without throwing",
    (depth) => {
      const xml = `<urlset ${NS}><url><loc>https://example.com/a</loc></url><url><loc>${"<x>".repeat(depth)}https://example.com/b${"</x>".repeat(depth)}</loc></url></urlset>`;
      const started = performance.now();
      const parsed = parseSitemap(xml);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(parsed.urls).toEqual(["https://example.com/a"]);
    },
  );

  test("a prefixed urlset is read by local name, and extension locs are still ignored", () => {
    const xml = `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="x">
  <sm:url><sm:loc>https://example.com/a</sm:loc><image:image><image:loc>https://example.com/i.png</image:loc></image:image></sm:url>
  <sm:url><image:loc>https://example.com/j.png</image:loc></sm:url>
  <sm:url><loc>https://example.com/unprefixed</loc></sm:url>
</sm:urlset>`;
    expect(parseSitemap(xml)).toEqual({ kind: "urlset", urls: ["https://example.com/a"] });
  });

  test("a prefixed sitemap index is read by local name", () => {
    const xml = `<sm:sitemapindex xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sm:sitemap><sm:loc>https://example.com/s1.xml</sm:loc></sm:sitemap>
</sm:sitemapindex>`;
    expect(parseSitemap(xml)).toEqual({ kind: "index", urls: ["https://example.com/s1.xml"] });
  });

  test("an unprefixed urlset ignores a prefixed loc inside url", () => {
    const xml = `<urlset ${NS}><url><image:loc>https://example.com/i.png</image:loc><loc>https://example.com/a</loc></url></urlset>`;
    expect(parseSitemap(xml).urls).toEqual(["https://example.com/a"]);
  });

  test("text of a malformed document does not throw", () => {
    expect(() => parseSitemap(`<urlset><url><loc>https://example.com/a</url>`)).not.toThrow();
  });

  test("duplicates do not count towards the cap", () => {
    const xml = `<urlset ${NS}>
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;
    expect(parseSitemap(xml, 2).urls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
});
