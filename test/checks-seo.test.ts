import { describe, expect, test } from "vitest";
import { runChecks } from "../src/checks/registry.js";
import type { PageRecord, SiteContext } from "../src/types.js";
import { makeContext, makePage } from "./helpers/context.js";

const SITE = "https://site.example";

function ids(ctx: SiteContext): string[] {
  return runChecks(ctx, ["seo"])
    .filter((c) => c.status === "fail")
    .map((c) => c.id);
}

function only(id: string, ctx: SiteContext) {
  const outcome = runChecks(ctx, ["seo"]).find((c) => c.id === id);
  if (outcome === undefined) throw new Error(`no check ${id} in the registry`);
  return outcome;
}

function one(page: PageRecord): SiteContext {
  return makeContext({ pages: [page] });
}

/** A page at a path other than the start page. */
function at(path: string, over: Parameters<typeof makePage>[0] = {}): PageRecord {
  return makePage({ url: `${SITE}${path}`, finalUrl: `${SITE}${path}`, ...over });
}

function withRobots(over: Partial<SiteContext["robots"]>): SiteContext {
  const base = makeContext();
  return { ...base, robots: { ...base.robots, ...over } };
}

function withSitemap(over: Partial<SiteContext["sitemap"]>): SiteContext {
  const base = makeContext();
  return { ...base, sitemap: { ...base.sitemap, ...over } };
}

function withLimits(
  pages: PageRecord[],
  over: Partial<SiteContext["limits"]>,
  rest: Partial<SiteContext> = {},
): SiteContext {
  const base = makeContext({ pages, ...rest });
  return { ...base, limits: { ...base.limits, ...over } };
}

describe("title checks", () => {
  test("SEO-TITLE-001 fires on a missing title and not on a present one", () => {
    expect(ids(one(makePage({ doc: { title: null, titleCount: 0 } })))).toContain("SEO-TITLE-001");
    expect(ids(one(makePage({ doc: { title: "   ", titleCount: 1 } })))).toContain("SEO-TITLE-001");
    expect(ids(makeContext({ pages: [makePage()] }))).not.toContain("SEO-TITLE-001");
  });

  test("SEO-TITLE-002 fires below 10 and above 60 characters, not at 30", () => {
    expect(ids(one(makePage({ doc: { title: "Short" } })))).toContain("SEO-TITLE-002");
    expect(ids(one(makePage({ doc: { title: "t".repeat(75) } })))).toContain("SEO-TITLE-002");
    expect(ids(one(makePage({ doc: { title: "t".repeat(30) } })))).not.toContain("SEO-TITLE-002");
    expect(ids(one(makePage({ doc: { title: "t".repeat(10) } })))).not.toContain("SEO-TITLE-002");
    expect(ids(one(makePage({ doc: { title: "t".repeat(60) } })))).not.toContain("SEO-TITLE-002");
    expect(ids(one(makePage({ doc: { title: "t".repeat(61) } })))).toContain("SEO-TITLE-002");
  });

  test("SEO-TITLE-002 leaves a missing title to SEO-TITLE-001", () => {
    expect(ids(one(makePage({ doc: { title: null, titleCount: 0 } })))).not.toContain(
      "SEO-TITLE-002",
    );
  });

  test("SEO-TITLE-003 reports each page in a duplicate set, ignoring canonicalised variants", () => {
    const a = makePage({ url: "https://site.example/a", doc: { title: "Same" } });
    const b = makePage({ url: "https://site.example/b", doc: { title: "same " } });
    const c = makePage({
      url: "https://site.example/a?ref=1",
      doc: { title: "Same", canonicals: ["https://site.example/a"] },
    });
    const out = only("SEO-TITLE-003", makeContext({ pages: [a, b, c] }));
    expect(out.findings.map((f) => f.url).sort()).toEqual([a.url, b.url]);
  });

  test("SEO-TITLE-003 lists up to five other URLs as evidence", () => {
    const pages = Array.from({ length: 8 }, (_, i) =>
      at(`/p${i}`, { doc: { title: "Shared title text", canonicals: [`${SITE}/p${i}`] } }),
    );
    const out = only("SEO-TITLE-003", makeContext({ pages }));
    expect(out.findings).toHaveLength(8);
    expect(out.findings[0]?.evidence).toHaveLength(5);
    expect(out.findings[0]?.evidence).not.toContain(pages[0]?.url);
  });

  test("SEO-TITLE-003 stays quiet for different titles, a lone canonicalised page and noindex pages", () => {
    const a = at("/a", { doc: { title: "First page title here" } });
    const b = at("/b", { doc: { title: "Second page title here" } });
    expect(ids(makeContext({ pages: [a, b] }))).not.toContain("SEO-TITLE-003");
    const c = at("/c", { doc: { title: "Same title here", canonicals: [a.url] } });
    const d = at("/d", { doc: { title: "Same title here" } });
    const lone = makeContext({ pages: [at("/a", { doc: { title: "Same title here" } }), c] });
    expect(ids(lone)).not.toContain("SEO-TITLE-003");
    const hidden = at("/e", { doc: { title: "Same title here", metaRobots: ["noindex"] } });
    expect(ids(makeContext({ pages: [d, hidden] }))).not.toContain("SEO-TITLE-003");
  });

  test("SEO-TITLE-004 fires on two title elements and not on one", () => {
    expect(ids(one(makePage({ doc: { titleCount: 2 } })))).toContain("SEO-TITLE-004");
    expect(ids(one(makePage({ doc: { titleCount: 1 } })))).not.toContain("SEO-TITLE-004");
  });
});

describe("description checks", () => {
  test("SEO-DESC-010 fires on a missing description and not on a present one", () => {
    expect(ids(one(makePage({ doc: { metaDescription: null } })))).toContain("SEO-DESC-010");
    expect(ids(one(makePage()))).not.toContain("SEO-DESC-010");
  });

  test("SEO-DESC-011 fires at 20 and 200 characters, not at 120", () => {
    expect(ids(one(makePage({ doc: { metaDescription: "d".repeat(20) } })))).toContain(
      "SEO-DESC-011",
    );
    expect(ids(one(makePage({ doc: { metaDescription: "d".repeat(200) } })))).toContain(
      "SEO-DESC-011",
    );
    expect(ids(one(makePage({ doc: { metaDescription: "d".repeat(120) } })))).not.toContain(
      "SEO-DESC-011",
    );
    expect(ids(one(makePage({ doc: { metaDescription: "d".repeat(50) } })))).not.toContain(
      "SEO-DESC-011",
    );
    expect(ids(one(makePage({ doc: { metaDescription: "d".repeat(160) } })))).not.toContain(
      "SEO-DESC-011",
    );
    expect(ids(one(makePage({ doc: { metaDescription: null } })))).not.toContain("SEO-DESC-011");
  });

  test("SEO-DESC-012 fires for two pages with the same description and not for different ones", () => {
    const text = "A shared description that is long enough to be a sensible snippet for a page.";
    const same = makeContext({
      pages: [
        at("/a", { doc: { metaDescription: text } }),
        at("/b", { doc: { metaDescription: text.toUpperCase() } }),
      ],
    });
    expect(only("SEO-DESC-012", same).findings).toHaveLength(2);
    const different = makeContext({
      pages: [
        at("/a", { doc: { metaDescription: `${text} First.` } }),
        at("/b", { doc: { metaDescription: `${text} Second.` } }),
      ],
    });
    expect(ids(different)).not.toContain("SEO-DESC-012");
  });
});

describe("heading checks", () => {
  test("SEO-H1-020 fires without a level 1 heading and not with one", () => {
    expect(ids(one(makePage({ doc: { headings: [{ level: 2, text: "Sub" }] } })))).toContain(
      "SEO-H1-020",
    );
    expect(ids(one(makePage({ doc: { headings: [] } })))).toContain("SEO-H1-020");
    expect(ids(one(makePage()))).not.toContain("SEO-H1-020");
  });

  test("SEO-H1-021 fires on two h1 and not on one", () => {
    const two = [
      { level: 1, text: "One" },
      { level: 1, text: "Two" },
    ];
    expect(ids(one(makePage({ doc: { headings: two } })))).toContain("SEO-H1-021");
    expect(ids(one(makePage()))).not.toContain("SEO-H1-021");
  });
});

describe("canonical checks", () => {
  test("SEO-CANON-030 fires without a canonical and not with a self canonical", () => {
    expect(ids(one(makePage({ doc: { canonicals: [] } })))).toContain("SEO-CANON-030");
    expect(ids(one(makePage({ doc: { canonicals: [`${SITE}/`] } })))).not.toContain(
      "SEO-CANON-030",
    );
  });

  test("SEO-CANON-031 fires on two different canonicals and not on two identical ones", () => {
    const differ = [`${SITE}/`, `${SITE}/other`];
    expect(ids(one(makePage({ doc: { canonicals: differ } })))).toContain("SEO-CANON-031");
    const same = [`${SITE}/`, `${SITE}/`];
    expect(ids(one(makePage({ doc: { canonicals: same } })))).not.toContain("SEO-CANON-031");
  });

  test("SEO-CANON-032 fires for a crawled 404 target", () => {
    const gone = at("/gone", { status: 404, isHtml: false, doc: null });
    const start = makePage({ doc: { canonicals: [gone.url] } });
    const out = only("SEO-CANON-032", makeContext({ pages: [start, gone] }));
    expect(out.status).toBe("fail");
    expect(out.findings[0]?.url).toBe(start.url);
    expect(out.findings[0]?.evidence).toEqual([gone.url]);
  });

  test("SEO-CANON-032 fires for a crawled target that redirects", () => {
    const moved = at("/moved", {
      finalUrl: `${SITE}/new`,
      status: 301,
      doc: null,
      hops: [{ url: `${SITE}/moved`, status: 301, location: `${SITE}/new` }],
    });
    const start = makePage({ doc: { canonicals: [moved.url] } });
    expect(ids(makeContext({ pages: [start, moved] }))).toContain("SEO-CANON-032");
  });

  test("SEO-CANON-032 fires when the canonical target failed to load", () => {
    const down = at("/down", { status: null, failure: "timeout", isHtml: false, doc: null });
    const start = makePage({ doc: { canonicals: [down.url] } });
    expect(ids(makeContext({ pages: [start, down] }))).toContain("SEO-CANON-032");
  });

  test("SEO-CANON-032 does not fire for a crawled 200 page, an uncrawled URL or a self canonical", () => {
    const fine = at("/fine", { doc: { canonicals: [`${SITE}/fine`] } });
    const start = makePage({ doc: { canonicals: [fine.url] } });
    expect(only("SEO-CANON-032", makeContext({ pages: [start, fine] })).status).toBe("pass");
    const uncrawled = makePage({ doc: { canonicals: [`${SITE}/never-crawled`] } });
    expect(ids(one(uncrawled))).not.toContain("SEO-CANON-032");
    expect(ids(one(makePage()))).not.toContain("SEO-CANON-032");
  });

  test("SEO-CANON-032 does not fire for a target answering 429 or 503", () => {
    for (const status of [429, 503]) {
      const busy = at("/busy", { status, isHtml: true, doc: null });
      const start = makePage({ doc: { canonicals: [busy.url] } });
      expect(ids(makeContext({ pages: [start, busy] })), String(status)).not.toContain(
        "SEO-CANON-032",
      );
    }
  });

  test("SEO-CANON-032 ignores a target that robots.txt kept the crawler from fetching", () => {
    const blocked = at("/private", {
      status: null,
      failure: "blocked-by-robots",
      isHtml: false,
      doc: null,
    });
    const start = makePage({ doc: { canonicals: [blocked.url] } });
    expect(ids(makeContext({ pages: [start, blocked] }))).not.toContain("SEO-CANON-032");
  });

  test("SEO-CANON-033 fires for a canonical on another origin and not for the same origin", () => {
    const away = makePage({ doc: { canonicals: ["https://other.example/"] } });
    expect(ids(one(away))).toContain("SEO-CANON-033");
    const otherScheme = makePage({ doc: { canonicals: ["http://site.example/"] } });
    expect(ids(one(otherScheme))).toContain("SEO-CANON-033");
    expect(ids(one(makePage()))).not.toContain("SEO-CANON-033");
  });

  test("canonical checks skip noindex pages", () => {
    const gone = at("/gone", { status: 404, isHtml: false, doc: null });
    const hidden = makePage({
      doc: {
        canonicals: [`${SITE}/gone`, "https://other.example/"],
        metaRobots: ["noindex"],
      },
    });
    const noCanonical = makePage({ doc: { canonicals: [], metaRobots: ["noindex"] } });
    const got = ids(makeContext({ pages: [hidden, gone] }));
    for (const id of ["SEO-CANON-030", "SEO-CANON-031", "SEO-CANON-032", "SEO-CANON-033"]) {
      expect(got, id).not.toContain(id);
      expect(only(id, one(noCanonical)).status, id).toBe("pass");
    }
  });
});

describe("indexing checks", () => {
  test("noindex pages are exempt from on-page checks but listed by SEO-INDEX-040", () => {
    const p = makePage({ doc: { title: null, titleCount: 0, metaRobots: ["noindex"] } });
    const got = ids(makeContext({ pages: [p] }));
    expect(got).toContain("SEO-INDEX-040");
    expect(got).not.toContain("SEO-TITLE-001");
  });

  test("SEO-INDEX-040 reads none and does not list indexable pages", () => {
    expect(ids(one(makePage({ doc: { metaRobots: ["none"] } })))).toContain("SEO-INDEX-040");
    expect(ids(one(makePage()))).not.toContain("SEO-INDEX-040");
  });

  test("SEO-INDEX-041 fires for noindex in the sitemap and not outside it", () => {
    const listed = makePage({ inSitemap: true, doc: { metaRobots: ["noindex"] } });
    expect(ids(one(listed))).toContain("SEO-INDEX-041");
    const unlisted = makePage({ inSitemap: false, doc: { metaRobots: ["noindex"] } });
    expect(ids(one(unlisted))).not.toContain("SEO-INDEX-041");
    expect(ids(one(makePage({ inSitemap: true })))).not.toContain("SEO-INDEX-041");
  });

  test("SEO-INDEX-042 fires for a URL in both the sitemap and the blocked list", () => {
    const url = `${SITE}/private`;
    const hit = withLimits(
      [makePage()],
      { blockedByRobots: [url] },
      {
        sitemap: { found: true, urls: [url, `${SITE}/open`], files: makeContext().sitemap.files },
      },
    );
    const out = only("SEO-INDEX-042", hit);
    expect(out.status).toBe("fail");
    expect(out.findings.map((f) => f.url)).toEqual([url]);
  });

  test("SEO-INDEX-042 stays quiet when the lists are disjoint", () => {
    const miss = withLimits(
      [makePage()],
      { blockedByRobots: [`${SITE}/private`] },
      {
        sitemap: { found: true, urls: [`${SITE}/open`], files: makeContext().sitemap.files },
      },
    );
    expect(only("SEO-INDEX-042", miss).status).toBe("pass");
  });

  test("SEO-INDEX-043 fires when the start page is noindex and not when another page is", () => {
    const start = makePage({ doc: { metaRobots: ["noindex"] } });
    expect(ids(one(start))).toContain("SEO-INDEX-043");
    const other = at("/other", { doc: { metaRobots: ["noindex"] } });
    expect(ids(makeContext({ pages: [makePage(), other] }))).not.toContain("SEO-INDEX-043");
  });

  test("SEO-INDEX-042 is not-applicable when robots.txt was ignored", () => {
    const url = `${SITE}/private`;
    const base = makeContext();
    const ctx = {
      ...base,
      robots: { ...base.robots, ignored: true },
      sitemap: { ...base.sitemap, urls: [url] },
    };
    const out = only("SEO-INDEX-042", ctx);
    expect(out.status).toBe("not-applicable");
    expect(out.findings).toEqual([]);
  });

  test("SEO-INDEX-042 is not-applicable when the sitemap lists no URLs", () => {
    const ctx = withLimits([makePage()], { blockedByRobots: [`${SITE}/private`] });
    expect(ctx.sitemap.urls).toEqual([]);
    expect(only("SEO-INDEX-042", ctx).status).toBe("not-applicable");
  });

  test("SEO-INDEX-043 reports a start page reached through a redirect once", () => {
    const redirect = at("/start", {
      finalUrl: `${SITE}/home`,
      status: 301,
      isHtml: false,
      doc: null,
      hops: [{ url: `${SITE}/start`, status: 301, location: `${SITE}/home` }],
    });
    const target = at("/home", { doc: { metaRobots: ["noindex"] } });
    const ctx = makeContext({ pages: [redirect, target], startUrl: `${SITE}/home` });
    const out = only("SEO-INDEX-043", ctx);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.url).toBe(target.url);
  });
});

describe("document checks", () => {
  test("SEO-LANG-050 fires without a lang and not with one", () => {
    expect(ids(one(makePage({ doc: { lang: null } })))).toContain("SEO-LANG-050");
    expect(ids(one(makePage({ doc: { lang: "en" } })))).not.toContain("SEO-LANG-050");
  });

  test("SEO-VIEW-051 fires without a viewport and not with one", () => {
    expect(ids(one(makePage({ doc: { hasViewport: false } })))).toContain("SEO-VIEW-051");
    expect(ids(one(makePage({ doc: { hasViewport: true } })))).not.toContain("SEO-VIEW-051");
  });

  test("SEO-OG-060 names the missing tags and does not fire when all three exist", () => {
    const partial = makePage({ doc: { openGraph: { "og:title": "x" } } });
    const out = only("SEO-OG-060", one(partial));
    expect(out.status).toBe("fail");
    expect(out.findings[0]?.detail).toContain("og:description");
    expect(out.findings[0]?.detail).toContain("og:image");
    expect(out.findings[0]?.detail).not.toContain("og:title");
    expect(ids(one(makePage()))).not.toContain("SEO-OG-060");
  });

  test("SEO-LD-070 fires on an invalid block and not on a valid one or none", () => {
    const bad = makePage({
      doc: { jsonLd: [{ ok: false, types: [], error: "not valid JSON" }] },
    });
    const out = only("SEO-LD-070", one(bad));
    expect(out.status).toBe("fail");
    expect(out.findings[0]?.detail).toBe("A JSON-LD block is not valid JSON.");
    const good = makePage({
      doc: { jsonLd: [{ ok: true, types: ["Organization"], error: null }] },
    });
    expect(ids(one(good))).not.toContain("SEO-LD-070");
    expect(ids(one(makePage({ doc: { jsonLd: [] } })))).not.toContain("SEO-LD-070");
  });

  test("SEO-LD-070 gives one finding per page when several blocks are invalid", () => {
    const bad = makePage({
      doc: {
        jsonLd: [
          { ok: true, types: ["Thing"], error: null },
          { ok: false, types: [], error: null },
          { ok: false, types: [], error: "Bad" },
        ],
      },
    });
    const out = only("SEO-LD-070", one(bad));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toBe("A JSON-LD block is not valid JSON.");
  });

  test("SEO-THIN-100 fires at 40 words and not at 400", () => {
    expect(ids(one(makePage({ doc: { wordCount: 40 } })))).toContain("SEO-THIN-100");
    expect(ids(one(makePage({ doc: { wordCount: 149 } })))).toContain("SEO-THIN-100");
    expect(ids(one(makePage({ doc: { wordCount: 150 } })))).not.toContain("SEO-THIN-100");
    expect(ids(one(makePage({ doc: { wordCount: 400 } })))).not.toContain("SEO-THIN-100");
  });
});

describe("robots checks", () => {
  test("SEO-ROBOTS-080 fires on a 404 and any 4xx, not on 200 or a server error", () => {
    expect(ids(withRobots({ status: 404, present: false }))).toContain("SEO-ROBOTS-080");
    expect(ids(withRobots({ status: 410, present: false }))).toContain("SEO-ROBOTS-080");
    expect(ids(withRobots({ status: 200 }))).not.toContain("SEO-ROBOTS-080");
    expect(ids(withRobots({ status: 503 }))).not.toContain("SEO-ROBOTS-080");
    expect(ids(withRobots({ status: null, present: false }))).not.toContain("SEO-ROBOTS-080");
  });

  test("SEO-ROBOTS-081 fires when everything is disallowed and not otherwise", () => {
    expect(ids(withRobots({ disallowAll: true }))).toContain("SEO-ROBOTS-081");
    expect(ids(withRobots({ disallowAll: false }))).not.toContain("SEO-ROBOTS-081");
    expect(only("SEO-ROBOTS-081", withRobots({})).why).toBe(
      "It tells search engine crawlers not to fetch any page of the site.",
    );
  });

  test("SEO-ROBOTS-082 fires on a server error and not on 200", () => {
    expect(ids(withRobots({ status: 503, present: false }))).toContain("SEO-ROBOTS-082");
    expect(ids(withRobots({ status: 500 }))).toContain("SEO-ROBOTS-082");
    expect(ids(withRobots({ status: 200 }))).not.toContain("SEO-ROBOTS-082");
    expect(ids(withRobots({ status: 404 }))).not.toContain("SEO-ROBOTS-082");
  });

  test("robots checks run even when no HTML page loaded", () => {
    const base = makeContext({ pages: [] });
    const ctx = { ...base, robots: { ...base.robots, status: 404, present: false } };
    expect(only("SEO-ROBOTS-080", ctx).status).toBe("fail");
    expect(only("SEO-ROBOTS-081", ctx).status).toBe("pass");
  });
});

describe("sitemap checks", () => {
  test("SEO-MAP-090 fires when no sitemap was found and not when one was", () => {
    expect(ids(withSitemap({ found: false, files: [] }))).toContain("SEO-MAP-090");
    expect(ids(withSitemap({ found: true }))).not.toContain("SEO-MAP-090");
  });

  test("SEO-MAP-090 says when no sitemap was named and none was found", () => {
    const base = makeContext();
    const ctx: SiteContext = {
      ...base,
      robots: { ...base.robots, sitemaps: [] },
      sitemap: { found: false, urls: [], files: [] },
    };
    expect(only("SEO-MAP-090", ctx).findings[0]?.detail).toBe(
      "No sitemap was named in robots.txt and none was found at /sitemap.xml.",
    );
  });

  test("SEO-MAP-090 says when robots.txt names a sitemap that could not be read", () => {
    const named = `${SITE}/sitemap.xml.gz`;
    const base = makeContext();
    const ctx: SiteContext = {
      ...base,
      robots: { ...base.robots, sitemaps: [named] },
      sitemap: {
        found: false,
        urls: [],
        files: [{ url: named, status: null, ok: false, note: "gzip sitemaps are skipped" }],
      },
    };
    expect(only("SEO-MAP-090", ctx).findings[0]?.detail).toBe(
      "robots.txt names a sitemap, but it could not be read: gzip sitemaps are skipped.",
    );
  });

  test("a guessed sitemap.xml that was an HTML page leaves no file: SEO-MAP-090 fires, SEO-MAP-093 does not apply", () => {
    const base = makeContext();
    const ctx: SiteContext = {
      ...base,
      robots: { ...base.robots, sitemaps: [] },
      sitemap: { found: false, urls: [], files: [] },
    };
    expect(only("SEO-MAP-090", ctx).status).toBe("fail");
    expect(only("SEO-MAP-093", ctx).status).toBe("not-applicable");
  });

  test("an invalid sitemap that answered 200 gives SEO-MAP-093 only, not SEO-MAP-090", () => {
    const invalid = withSitemap({
      found: false,
      files: [{ url: `${SITE}/sitemap.xml`, status: 200, ok: false, note: "invalid" }],
    });
    const got = ids(invalid).filter((id) => id.startsWith("SEO-MAP-"));
    expect(got).toEqual(["SEO-MAP-093"]);
  });

  test("no sitemap at all gives SEO-MAP-090 only", () => {
    const missing = withSitemap({
      found: false,
      files: [{ url: `${SITE}/sitemap.xml`, status: 404, ok: false, note: "status 404" }],
    });
    const got = ids(missing).filter((id) => id.startsWith("SEO-MAP-"));
    expect(got).toEqual(["SEO-MAP-090"]);
  });

  test("SEO-MAP-091, 092 and 093 are not-applicable when no sitemap file was tried", () => {
    const ctx = withSitemap({ found: false, urls: [], files: [] });
    for (const id of ["SEO-MAP-091", "SEO-MAP-092", "SEO-MAP-093"]) {
      expect(only(id, ctx).status, id).toBe("not-applicable");
    }
    expect(only("SEO-MAP-090", ctx).status).toBe("fail");
  });

  test("SEO-MAP-091 fires when robots.txt does not list a found sitemap", () => {
    const base = makeContext();
    const unlisted = { ...base, robots: { ...base.robots, sitemaps: [] } };
    expect(ids(unlisted)).toContain("SEO-MAP-091");
    expect(ids(makeContext())).not.toContain("SEO-MAP-091");
    const none = { ...unlisted, sitemap: { ...unlisted.sitemap, found: false, files: [] } };
    expect(ids(none)).not.toContain("SEO-MAP-091");
  });

  test("SEO-MAP-092 fires for a sitemap page with status 404", () => {
    const gone = at("/gone", { inSitemap: true, status: 404, isHtml: false, doc: null });
    const out = only("SEO-MAP-092", makeContext({ pages: [makePage(), gone] }));
    expect(out.status).toBe("fail");
    expect(out.findings.map((f) => f.url)).toEqual([gone.url]);
  });

  test("SEO-MAP-092 fires for a sitemap page that redirects", () => {
    const moved = at("/moved", {
      inSitemap: true,
      finalUrl: `${SITE}/new`,
      hops: [{ url: `${SITE}/moved`, status: 301, location: `${SITE}/new` }],
    });
    const out = only("SEO-MAP-092", makeContext({ pages: [makePage(), moved] }));
    expect(out.findings.map((f) => f.url)).toEqual([moved.url]);
    expect(out.findings[0]?.evidence).toEqual([`${SITE}/new`]);
  });

  test("SEO-MAP-092 does not fire for a sitemap page answering 429 or 503", () => {
    for (const status of [429, 503]) {
      const busy = at("/busy", { inSitemap: true, status, doc: null });
      expect(ids(makeContext({ pages: [makePage(), busy] })), String(status)).not.toContain(
        "SEO-MAP-092",
      );
    }
  });

  test("SEO-MAP-092 fires for a sitemap page that failed to load", () => {
    const down = at("/down", { inSitemap: true, status: null, failure: "timeout", doc: null });
    expect(ids(makeContext({ pages: [makePage(), down] }))).toContain("SEO-MAP-092");
  });

  test("SEO-MAP-092 stays quiet for a clean sitemap page, a page outside the sitemap and a robots block", () => {
    const fine = at("/fine", { inSitemap: true, inlinks: [`${SITE}/`] });
    expect(ids(makeContext({ pages: [makePage(), fine] }))).not.toContain("SEO-MAP-092");
    const outside = at("/gone", { inSitemap: false, status: 404, isHtml: false, doc: null });
    expect(ids(makeContext({ pages: [makePage(), outside] }))).not.toContain("SEO-MAP-092");
    const blocked = at("/private", {
      inSitemap: true,
      status: null,
      failure: "blocked-by-robots",
      isHtml: false,
      doc: null,
    });
    expect(ids(makeContext({ pages: [makePage(), blocked] }))).not.toContain("SEO-MAP-092");
  });

  test("SEO-MAP-093 fires for a sitemap file that did not parse and not for a good one", () => {
    const bad = withSitemap({
      files: [
        { url: `${SITE}/sitemap.xml`, status: 200, ok: false, note: "not valid sitemap XML" },
      ],
    });
    const out = only("SEO-MAP-093", bad);
    expect(out.status).toBe("fail");
    expect(out.findings[0]?.url).toBe(`${SITE}/sitemap.xml`);
    expect(ids(makeContext())).not.toContain("SEO-MAP-093");
  });

  test("SEO-MAP-093 does not treat a fetch failure or a skipped nested index as a parse error", () => {
    const other = withSitemap({
      files: [
        { url: `${SITE}/a.xml`, status: 404, ok: false, note: "status 404" },
        { url: `${SITE}/b.xml`, status: 200, ok: false, note: "nested sitemap index not followed" },
        { url: `${SITE}/c.xml`, status: null, ok: false, note: "gzip sitemaps are skipped" },
      ],
    });
    expect(ids(other)).not.toContain("SEO-MAP-093");
  });

  test("SEO-MAP-094 fires for a sitemap page with no inlinks when the crawl was complete", () => {
    const orphan = at("/orphan", { inSitemap: true, inlinks: [] });
    const ctx = withLimits([makePage(), orphan], { uncrawled: 0 });
    const out = only("SEO-MAP-094", ctx);
    expect(out.status).toBe("fail");
    expect(out.findings.map((f) => f.url)).toEqual([orphan.url]);
  });

  test("SEO-MAP-094 stays quiet for a linked sitemap page and the start page", () => {
    const linked = at("/linked", { inSitemap: true, inlinks: [`${SITE}/`] });
    const start = makePage({ inSitemap: true });
    const ctx = withLimits([start, linked], { uncrawled: 0 });
    expect(only("SEO-MAP-094", ctx).status).toBe("pass");
  });

  test("SEO-MAP-094 exempts a start page reached through a redirect", () => {
    const redirect = at("/start", {
      finalUrl: `${SITE}/home`,
      status: 301,
      isHtml: false,
      doc: null,
      hops: [{ url: `${SITE}/start`, status: 301, location: `${SITE}/home` }],
    });
    const target = at("/home", { inSitemap: true, inlinks: [] });
    const ctx = withLimits([redirect, target], { uncrawled: 0 }, { startUrl: `${SITE}/home` });
    expect(only("SEO-MAP-094", ctx).status).toBe("pass");
  });

  test("SEO-MAP-094 is not-applicable when URLs were left uncrawled", () => {
    const orphan = at("/orphan", { inSitemap: true, inlinks: [] });
    const ctx = withLimits([makePage(), orphan], { uncrawled: 5 });
    const out = only("SEO-MAP-094", ctx);
    expect(out.status).toBe("not-applicable");
    expect(out.findings).toEqual([]);
  });

  test("SEO-MAP-094 does not report a page that is linked through a redirect", () => {
    const old = at("/old", {
      finalUrl: `${SITE}/new`,
      status: 301,
      doc: null,
      isHtml: false,
      hops: [{ url: `${SITE}/old`, status: 301, location: `${SITE}/new` }],
      inlinks: [`${SITE}/`],
    });
    const target = at("/new", { inSitemap: true, inlinks: [] });
    const ctx = withLimits([makePage(), old, target], { uncrawled: 0 });
    expect(only("SEO-MAP-094", ctx).status).toBe("pass");
  });
});
