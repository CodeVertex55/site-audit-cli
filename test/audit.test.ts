import { afterEach, describe, expect, test } from "vitest";
import { audit, buildScope, NOT_SEEN } from "../src/audit.js";
import { UnreachableError } from "../src/errors.js";
import { DEFAULT_OPTIONS, type LighthouseSection } from "../src/types.js";
import { startSite, type TestSite } from "./server/index.js";
import { cleanSite, messySite } from "./server/sites.js";
import { makeContext } from "./helpers/context.js";

let site: TestSite | undefined;

afterEach(async () => {
  await site?.close();
  site = undefined;
});

describe("audit on the fixture sites", () => {
  test("the clean fixture site has no errors or warnings apart from plain HTTP", async () => {
    site = await startSite(cleanSite());
    const result = await audit({ ...DEFAULT_OPTIONS, startUrl: site.url("/"), delayMs: 0 });
    const failed = result.checks
      .filter((c) => c.status === "fail" && c.severity !== "info")
      .map((c) => c.id);
    expect(failed).toEqual(["HEALTH-HTTPS-020"]); // the fixture server is HTTP on loopback; this finding is correct and expected
    expect(result.schemaVersion).toBe(1);
    expect(result.scope.pagesCrawled).toBe(4);
    expect(result.lighthouse).toBeNull();
  });

  test("the messy fixture site trips the expected checks", async () => {
    site = await startSite(messySite());
    const result = await audit({ ...DEFAULT_OPTIONS, startUrl: site.url("/"), delayMs: 0 });
    const failed = new Set(result.checks.filter((c) => c.status === "fail").map((c) => c.id));
    for (const id of [
      "SEO-TITLE-001",
      "SEO-TITLE-003",
      "SEO-DESC-012",
      "SEO-H1-021",
      "SEO-INDEX-041",
      "SEO-LD-070",
      "HEALTH-LINK-001",
      "HEALTH-LINK-002",
      "HEALTH-REDIR-010",
      "HEALTH-FAV-040",
      "HEALTH-HDR-052",
      "PERF-IMG-050",
      "PERF-IMG-052",
      "PERF-BLOCK-060",
      "PERF-COMP-021",
      "PERF-CACHE-030",
      "A11Y-ALT-001",
      "A11Y-LABEL-010",
      "A11Y-LINK-021",
      "A11Y-HEAD-040",
    ])
      expect(failed, id).toContain(id);
    expect(result.summary.fixFirst.length).toBeGreaterThan(0);
    expect(result.summary.fixFirst.length).toBeLessThanOrEqual(5);
    expect(result.pages.length).toBe(result.scope.pagesCrawled);
  });

  test("page summaries count findings by the page they name", async () => {
    site = await startSite(messySite());
    const result = await audit({ ...DEFAULT_OPTIONS, startUrl: site.url("/"), delayMs: 0 });
    const untitled = result.pages.find((p) => p.url === site?.url("/untitled"));
    expect(untitled).toBeDefined();
    expect(untitled?.status).toBe(200);
    expect(untitled?.counts.error).toBeGreaterThanOrEqual(1);
    const expected = { error: 0, warning: 0, info: 0 };
    for (const check of result.checks) {
      for (const f of check.findings) {
        if (f.url === untitled?.url) expected[f.severity] += 1;
      }
    }
    expect(untitled?.counts).toEqual(expected);
  });

  test("a result is serialisable and carries the tool identity and times", async () => {
    site = await startSite(cleanSite());
    const result = await audit({ ...DEFAULT_OPTIONS, startUrl: site.url("/"), delayMs: 0 });
    expect(result.tool.name).toBe("site-audit-cli");
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("audit options", () => {
  test("only seo yields only SEO outcomes and the scope names the group", async () => {
    site = await startSite(cleanSite());
    const result = await audit({
      ...DEFAULT_OPTIONS,
      startUrl: site.url("/"),
      delayMs: 0,
      only: ["seo"],
    });
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => c.group === "seo")).toBe(true);
    expect(result.scope.groups).toEqual(["seo"]);
    expect(result.summary.byGroup.health).toEqual({ error: 0, warning: 0, info: 0 });
  });

  test("with no group filter the scope lists all four groups", async () => {
    site = await startSite(cleanSite());
    const result = await audit({ ...DEFAULT_OPTIONS, startUrl: site.url("/"), delayMs: 0 });
    expect(result.scope.groups).toEqual(["seo", "health", "performance", "accessibility"]);
  });

  test("lighthouse is skipped unless asked for, even when a runner is supplied", async () => {
    site = await startSite(cleanSite());
    let called = false;
    const result = await audit(
      { ...DEFAULT_OPTIONS, startUrl: site.url("/"), delayMs: 0 },
      {
        lighthouse: async () => {
          called = true;
          return { status: "ok", version: "1", note: "", pages: [] };
        },
      },
    );
    expect(called).toBe(false);
    expect(result.lighthouse).toBeNull();
  });

  test("lighthouse is called with the start URL first, then other crawled pages", async () => {
    site = await startSite(cleanSite());
    const section: LighthouseSection = {
      status: "ok",
      version: "12.0.0",
      note: "Fake runner.",
      pages: [],
    };
    const seen: string[][] = [];
    const result = await audit(
      {
        ...DEFAULT_OPTIONS,
        startUrl: site.url("/"),
        delayMs: 0,
        lighthouse: true,
        lighthousePages: 3,
      },
      {
        lighthouse: async (urls) => {
          seen.push(urls);
          return section;
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(3);
    expect(seen[0]?.[0]).toBe(site.url("/"));
    expect(new Set(seen[0]).size).toBe(3);
    expect(result.lighthouse).toEqual(section);
  });

  test("lighthouse pages are capped at the page option", async () => {
    site = await startSite(cleanSite());
    const seen: string[][] = [];
    await audit(
      {
        ...DEFAULT_OPTIONS,
        startUrl: site.url("/"),
        delayMs: 0,
        lighthouse: true,
        lighthousePages: 1,
      },
      {
        lighthouse: async (urls) => {
          seen.push(urls);
          return { status: "ok", version: null, note: "", pages: [] };
        },
      },
    );
    expect(seen[0]).toEqual([site.url("/")]);
  });

  test("lighthouse requested without a runner leaves the section null", async () => {
    site = await startSite(cleanSite());
    const result = await audit({
      ...DEFAULT_OPTIONS,
      startUrl: site.url("/"),
      delayMs: 0,
      lighthouse: true,
    });
    expect(result.lighthouse).toBeNull();
  });

  test("an unreachable start URL propagates UnreachableError", async () => {
    site = await startSite(cleanSite());
    const dead = site.url("/");
    await site.close();
    site = undefined;
    await expect(
      audit({ ...DEFAULT_OPTIONS, startUrl: dead, delayMs: 0, timeoutMs: 2000 }),
    ).rejects.toBeInstanceOf(UnreachableError);
  });
});

describe("buildScope", () => {
  test("copies the crawl limits and options, and carries the fixed not-seen list", () => {
    const ctx = makeContext({
      originNote: "Redirected from the apex host.",
      limits: {
        maxPages: 50,
        maxDepth: 3,
        pagesCrawled: 12,
        uncrawled: 7,
        blockedByRobots: ["https://site.example/private"],
        assetsNotMeasured: 4,
        delayRaised: true,
      },
    });
    ctx.options = { ...ctx.options, checkExternal: true, ignoreRobots: true, only: ["health"] };
    const scope = buildScope(ctx);
    expect(scope).toEqual({
      startUrl: ctx.startUrl,
      origin: ctx.origin,
      originNote: "Redirected from the apex host.",
      pagesCrawled: 12,
      maxPages: 50,
      maxDepth: 3,
      uncrawled: 7,
      blockedByRobots: ["https://site.example/private"],
      ignoreRobots: true,
      checkExternal: true,
      assetsNotMeasured: 4,
      delayRaised: true,
      groups: ["health"],
      notSeen: [...NOT_SEEN],
    });
  });

  test("the not-seen list is the four fixed lines", () => {
    expect(NOT_SEEN).toHaveLength(4);
    expect(NOT_SEEN.join(" ")).toMatch(/JavaScript/);
    expect(NOT_SEEN.join(" ")).toMatch(/login/);
    expect(NOT_SEEN.join(" ")).toMatch(/real-user/i);
    expect(NOT_SEEN.join(" ")).toMatch(/page limit/);
  });
});
