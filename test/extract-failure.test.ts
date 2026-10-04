import { afterEach, describe, expect, test, vi } from "vitest";
import { crawlSite } from "../src/crawl/crawler.js";
import { extractWithStatus } from "../src/crawl/extract.js";
import { DEFAULT_OPTIONS } from "../src/types.js";
import { startSite, type TestSite } from "./server/index.js";
import { page } from "./server/html.js";

// Switches that make the HTML parser or the whole extraction throw, to stand in for a bug.
const fail = vi.hoisted(() => ({ parser: false, extract: false }));

vi.mock("htmlparser2", async (importOriginal) => {
  const real = await importOriginal<typeof import("htmlparser2")>();
  class FailingParser extends real.Parser {
    override end(chunk?: string): void {
      if (fail.parser) throw new Error("parser failure");
      super.end(chunk);
    }
  }
  return { ...real, Parser: FailingParser };
});

vi.mock("../src/crawl/extract.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/crawl/extract.js")>();
  return {
    ...real,
    extractWithStatus: (...args: Parameters<typeof real.extractWithStatus>) => {
      if (fail.extract) throw new Error("extract failure");
      return real.extractWithStatus(...args);
    },
  };
});

let site: TestSite | undefined;

afterEach(async () => {
  fail.parser = false;
  fail.extract = false;
  await site?.close();
  site = undefined;
});

describe("a failure inside extraction", () => {
  test("a parser that throws gives an empty document flagged truncated", () => {
    fail.parser = true;
    const result = extractWithStatus(page({ title: "T" }), "https://example.com/");
    expect(result.truncated).toBe(true);
    expect(result.doc.title).toBeNull();
    expect(result.doc.links).toEqual([]);
  });

  test("the crawl keeps the page with no document, flagged truncated, and does not reject", async () => {
    site = await startSite({ "/": { body: page({ title: "T" }) } });
    fail.extract = true;
    const ctx = await crawlSite({
      ...DEFAULT_OPTIONS,
      startUrl: site.url("/"),
      delayMs: 0,
      timeoutMs: 2000,
    });
    const home = ctx.pages.find((p) => p.url === site?.url("/"));
    expect(home).toMatchObject({ status: 200, doc: null, truncated: true });
  });
});
