import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { VERSION } from "../src/version.js";
import { DEFAULT_OPTIONS } from "../src/types.js";
import { makeAsset, makeContext, makeDoc, makePage } from "./helpers/context.js";

test("VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  expect(VERSION).toBe(pkg.version);
});

test("default options follow the spec", () => {
  expect(DEFAULT_OPTIONS.maxPages).toBe(50);
  expect(DEFAULT_OPTIONS.delayMs).toBe(1000);
  expect(DEFAULT_OPTIONS.concurrency).toBe(2);
  expect(DEFAULT_OPTIONS.userAgent.startsWith("site-audit-cli/1.0.0")).toBe(true);
});

test("context builders return a clean context and honour overrides", () => {
  const ctx = makeContext();
  expect(ctx.origin).toBe("https://site.example");
  expect(ctx.pages).toHaveLength(1);
  expect(ctx.limits.pagesCrawled).toBe(1);
  expect(ctx.external).toBeNull();
  expect(ctx.assets).toEqual([]);

  const doc = ctx.pages[0]?.doc;
  expect(doc?.title?.length).toBeGreaterThanOrEqual(10);
  expect(doc?.metaDescription?.length).toBeGreaterThanOrEqual(50);
  expect(doc?.headings.filter((h) => h.level === 1)).toHaveLength(1);
  expect(Object.keys(doc?.openGraph ?? {}).sort()).toEqual([
    "og:description",
    "og:image",
    "og:title",
  ]);

  expect(makePage({ doc: null }).doc).toBeNull();
  expect(makePage({ doc: { title: null } }).doc?.title).toBeNull();
  expect(makePage({ doc: { title: null } }).doc?.lang).toBe("en");
  expect(makeAsset({ bytes: 1 }).bytes).toBe(1);
  expect(makeDoc({ wordCount: 3 }).wordCount).toBe(3);
  expect(
    makeContext({ pages: [makePage(), makePage({ url: "https://site.example/a" })] }).limits
      .pagesCrawled,
  ).toBe(2);
});

test("the package exports the error classes audit() and the command line throw", async () => {
  const index = await import("../src/index.js");
  const errors = await import("../src/errors.js");
  expect(index.UnreachableError).toBe(errors.UnreachableError);
  expect(index.UsageError).toBe(errors.UsageError);
});
