import { afterEach, describe, expect, test } from "vitest";
import { runChecks } from "../src/checks/registry.js";
import { crawlSite, type CrawlDeps } from "../src/crawl/crawler.js";
import type { Clock } from "../src/crawl/ratelimit.js";
import { UnreachableError } from "../src/errors.js";
import {
  DEFAULT_OPTIONS,
  type AuditOptions,
  type PageRecord,
  type SiteContext,
} from "../src/types.js";
import { startSite, type SiteDef, type TestSite } from "./server/index.js";
import { page } from "./server/html.js";

const sites: TestSite[] = [];

async function start(def: SiteDef): Promise<TestSite> {
  const site = await startSite(def);
  sites.push(site);
  return site;
}

afterEach(async () => {
  await Promise.all(sites.splice(0).map((site) => site.close()));
});

function opts(site: TestSite, over: Partial<AuditOptions> = {}): AuditOptions {
  return { ...DEFAULT_OPTIONS, startUrl: site.url("/"), delayMs: 0, timeoutMs: 2000, ...over };
}

function rawUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** A fetch that serves the site for real and records anything else instead of sending it. */
function offOriginSpy(site: TestSite): { fetchImpl: typeof fetch; seen: string[] } {
  const web = fakeWeb({});
  const real = globalThis.fetch;
  const fetchImpl: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return raw.startsWith(site.origin) ? real(input, init) : web.fetchImpl(input, init);
  };
  return { fetchImpl, seen: web.seen };
}

function pageAt(ctx: SiteContext, url: string): PageRecord {
  const found = ctx.pages.find((p) => p.url === url);
  if (found === undefined) throw new Error(`No page record for ${url}`);
  return found;
}

function urls(ctx: SiteContext): string[] {
  return ctx.pages.map((p) => p.url).sort();
}

/** The paths of every request the site received, in order. */
function paths(site: TestSite): string[] {
  return site.log.map((r) => r.path);
}

/** Differences between consecutive timestamps. */
function gaps(times: number[]): number[] {
  return times.slice(1).map((time, i) => time - (times[i] ?? 0));
}

const ROBOTS_TEXT = { "content-type": "text/plain" };
const SECRET_ROBOTS = "User-agent: *\nDisallow: /secret/\n";
const HOME_WITH_SECRET = page({ body: `<a href="/secret/x">s</a> <a href="/ok">ok</a>` });

function linkTo(...hrefs: string[]): string {
  return hrefs.map((href) => `<a href="${href}">link</a>`).join(" ");
}

/** A deterministic clock: sleeping moves time forward at once. */
function instantClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

type FakeRoute = { status?: number; location?: string; body?: string } | "throw";

/** A network stand-in for hosts the loopback fixture server cannot play. */
function fakeWeb(routes: Record<string, FakeRoute>): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(`${init?.method ?? "GET"} ${raw}`);
    const route = routes[raw] ?? { status: 404 };
    if (route === "throw") return Promise.reject(new TypeError("fetch failed"));
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (route.location !== undefined) headers.location = route.location;
    return Promise.resolve(
      new Response(route.body ?? null, { status: route.status ?? 200, headers }),
    );
  };
  return { fetchImpl, seen };
}

describe("robots.txt", () => {
  test("robots-disallowed pages are never requested", async () => {
    const site = await start({
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nDisallow: /secret/\n",
      },
      "/": { body: page({ body: `<a href="/ok">ok</a> <a href="/secret/x">no</a>` }) },
      "/ok": { body: page({ title: "OK" }) },
      "/secret/x": { body: page({ title: "Secret" }) },
    });
    const ctx = await crawlSite(opts(site));
    expect(site.hits("/secret/x")).toBe(0);
    expect(ctx.limits.blockedByRobots).toEqual([site.url("/secret/x")]);
    expect(ctx.pages.map((p) => p.url).sort()).toEqual([site.url("/"), site.url("/ok")]);
  });

  test("ignoreRobots fetches the disallowed page and records the notice", async () => {
    const site = await start({
      "/robots.txt": { headers: ROBOTS_TEXT, body: "User-agent: *\nDisallow: /secret/\n" },
      "/": { body: page({ body: linkTo("/secret/x") }) },
      "/secret/x": { body: page({ title: "Secret" }) },
    });
    const ctx = await crawlSite(opts(site, { ignoreRobots: true }));
    expect(site.hits("/secret/x")).toBe(1);
    expect(site.hits("/robots.txt")).toBe(1);
    expect(ctx.robots.ignored).toBe(true);
    expect(ctx.robots.present).toBe(true);
    expect(ctx.limits.blockedByRobots).toEqual([]);
    expect(urls(ctx)).toContain(site.url("/secret/x"));
  });

  test("a robots.txt answering 500 makes the site unreachable unless robots are ignored", async () => {
    const site = await start({
      "/robots.txt": { status: 500, body: "oops" },
      "/": { body: page() },
    });
    await expect(crawlSite(opts(site))).rejects.toBeInstanceOf(UnreachableError);
    await expect(crawlSite(opts(site))).rejects.toThrow(/robots\.txt could not be read/);
    expect(site.hits("/")).toBe(0);

    const ctx = await crawlSite(opts(site, { ignoreRobots: true }));
    expect(ctx.robots).toMatchObject({ status: 500, present: false, ignored: true });
    expect(urls(ctx)).toEqual([site.url("/")]);
  });

  test("a missing robots.txt allows everything", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/a") }) },
      "/a": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(ctx.robots).toEqual({
      status: 404,
      present: false,
      disallowAll: false,
      sitemaps: [],
      crawlDelay: null,
      ignored: false,
    });
    expect(urls(ctx)).toHaveLength(2);
  });

  test("a disallowed start URL is unreachable and is never requested", async () => {
    const site = await start({
      "/robots.txt": { headers: ROBOTS_TEXT, body: "User-agent: *\nDisallow: /\n" },
      "/": { body: page() },
    });
    await expect(crawlSite(opts(site))).rejects.toBeInstanceOf(UnreachableError);
    expect(site.hits("/")).toBe(0);
    const ctx = await crawlSite(opts(site, { ignoreRobots: true }));
    expect(ctx.robots.disallowAll).toBe(true);
    expect(urls(ctx)).toEqual([site.url("/")]);
  });

  test("Crawl-delay spaces the first requests by at least 900 ms", async () => {
    const site = await start({
      "/robots.txt": { headers: ROBOTS_TEXT, body: "User-agent: *\nCrawl-delay: 1\n" },
      "/": { body: page({ head: '<link rel="icon" href="data:,">' }) },
    });
    const ctx = await crawlSite(opts(site, { delayMs: 0, concurrency: 2 }));
    expect(ctx.robots.crawlDelay).toBe(1000);
    const times = site.log.slice(0, 3).map((r) => r.at);
    expect(times).toHaveLength(3);
    for (const gap of gaps(times)) expect(gap).toBeGreaterThanOrEqual(900);
  });

  test("robots.txt served as application/octet-stream is still obeyed", async () => {
    const site = await start({
      "/robots.txt": {
        headers: { "content-type": "application/octet-stream" },
        body: SECRET_ROBOTS,
      },
      "/": { body: HOME_WITH_SECRET },
      "/ok": { body: page() },
      "/secret/x": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(site.hits("/secret/x")).toBe(0);
    expect(ctx.robots.present).toBe(true);
    expect(ctx.limits.blockedByRobots).toEqual([site.url("/secret/x")]);
  });

  test("robots.txt served without a Content-Type is still obeyed", async () => {
    const site = await start({
      "/robots.txt": { body: SECRET_ROBOTS },
      "/": { body: HOME_WITH_SECRET },
      "/ok": { body: page() },
      "/secret/x": { body: page() },
    });
    const real = globalThis.fetch;
    const ctx = await crawlSite(opts(site), {
      fetchImpl: async (input, init) => {
        const response = await real(input, init);
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!raw.endsWith("/robots.txt")) return response;
        const headers = new Headers(response.headers);
        headers.delete("content-type");
        return new Response(response.body, { status: response.status, headers });
      },
    });
    expect(site.hits("/secret/x")).toBe(0);
    expect(ctx.limits.blockedByRobots).toEqual([site.url("/secret/x")]);
  });

  test("robots.txt is read up to 512 KB, later rules are ignored and a note says so", async () => {
    const padding = "# padding line\n".repeat(Math.ceil((512 * 1024) / 15));
    const site = await start({
      "/robots.txt": { headers: ROBOTS_TEXT, body: `User-agent: *\n${padding}${SECRET_ROBOTS}` },
      "/": { body: HOME_WITH_SECRET },
      "/ok": { body: page() },
      "/secret/x": { body: page() },
    });
    const notes: string[] = [];
    await crawlSite(opts(site), {
      onProgress: (e) => {
        if (e.kind === "note" && e.message !== undefined) notes.push(e.message);
      },
    });
    expect(site.hits("/secret/x")).toBe(1);
    expect(notes.some((m) => m.includes("robots.txt") && m.includes("512 KB"))).toBe(true);
  });

  test("the crawl-delay is not applied when robots are ignored", async () => {
    const site = await start({
      "/robots.txt": { headers: ROBOTS_TEXT, body: "User-agent: *\nCrawl-delay: 20\n" },
      "/": { body: page({ head: '<link rel="icon" href="data:,">' }) },
    });
    const started = Date.now();
    const ctx = await crawlSite(opts(site, { ignoreRobots: true }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ctx.robots.ignored).toBe(true);
  });
});

describe("start URL", () => {
  test("a closed port is unreachable", async () => {
    const closed = await startSite({});
    const startUrl = closed.url("/");
    await closed.close();
    await expect(
      crawlSite({ ...DEFAULT_OPTIONS, startUrl, delayMs: 0, timeoutMs: 2000 }),
    ).rejects.toBeInstanceOf(UnreachableError);
  });

  test("a non-HTML start URL is unreachable", async () => {
    const site = await start({
      "/": { headers: { "content-type": "application/pdf" }, body: "%PDF-1.4" },
    });
    await expect(crawlSite(opts(site))).rejects.toThrow(UnreachableError);
  });

  test("a start URL answering an error status is unreachable", async () => {
    const site = await start({ "/": { status: 404, body: page() } });
    await expect(crawlSite(opts(site))).rejects.toThrow(/404/);
  });

  test("a start URL that redirects to another origin moves the audit there", async () => {
    const target = await start({
      "/": { body: page({ title: "Target", body: linkTo("/inner") }) },
      "/inner": { body: page({ title: "Inner" }) },
    });
    const origin = await start({ "/": { status: 302, headers: { location: target.url("/") } } });
    const ctx = await crawlSite(opts(origin));
    expect(ctx.origin).toBe(target.origin);
    expect(ctx.originNote).toBe(`Start URL redirected to ${target.origin}/`);
    expect(ctx.startUrl).toBe(target.url("/"));
    expect(urls(ctx)).toEqual([origin.url("/"), target.url("/"), target.url("/inner")].sort());
    expect(pageAt(ctx, origin.url("/")).hops).toHaveLength(1);
    expect(pageAt(ctx, origin.url("/")).doc).toBeNull();
    expect(pageAt(ctx, target.url("/")).doc?.title).toBe("Target");
    expect(origin.hits("/")).toBe(1);
    expect(target.hits("/")).toBe(1);
    expect(target.hits("/robots.txt")).toBe(1);
  });

  test("the origin note is null when the origin does not change", async () => {
    const site = await start({ "/": { body: page() } });
    const ctx = await crawlSite(opts(site));
    expect(ctx.originNote).toBeNull();
    expect(ctx.origin).toBe(site.origin);
    expect(ctx.startUrl).toBe(site.url("/"));
  });
});

describe("limits", () => {
  test("the delay between request starts is honoured", async () => {
    const site = await start({
      "/": { body: page({ body: `<a href="/a">a</a><a href="/b">b</a>` }) },
      "/a": { body: page() },
      "/b": { body: page() },
    });
    await crawlSite(opts(site, { delayMs: 200, concurrency: 2 }));
    const times = site.log.map((r) => r.at);
    for (const gap of gaps(times)) expect(gap).toBeGreaterThanOrEqual(150);
  });

  test("maxPages stops the crawl and counts what was left", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/a", "/b", "/c", "/d") }) },
      "/a": { body: page() },
      "/b": { body: page() },
      "/c": { body: page() },
      "/d": { body: page() },
    });
    const ctx = await crawlSite(opts(site, { maxPages: 2 }));
    const htmlHits = ["/", "/a", "/b", "/c", "/d"].reduce((n, p) => n + site.hits(p), 0);
    expect(htmlHits).toBe(2);
    expect(ctx.pages).toHaveLength(2);
    expect(ctx.limits.pagesCrawled).toBe(2);
    expect(ctx.limits.uncrawled).toBe(3);
    expect(ctx.limits.maxPages).toBe(2);
  });

  test("maxDepth keeps deeper pages out of the queue", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/a") }) },
      "/a": { body: page({ body: linkTo("/deep") }) },
      "/deep": { body: page() },
    });
    const ctx = await crawlSite(opts(site, { maxDepth: 1 }));
    expect(site.hits("/deep")).toBe(0);
    expect(urls(ctx)).toEqual([site.url("/"), site.url("/a")]);
    expect(pageAt(ctx, site.url("/a")).depth).toBe(1);
    expect(ctx.limits.uncrawled).toBe(0);
  });

  test("an excluded pattern prevents requests", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/private/x", "/ok") }) },
      "/ok": { body: page() },
      "/private/x": { body: page() },
    });
    const ctx = await crawlSite(opts(site, { exclude: ["/private/**"] }));
    expect(site.hits("/private/x")).toBe(0);
    expect(urls(ctx)).toEqual([site.url("/"), site.url("/ok")]);
    expect(ctx.limits.blockedByRobots).toEqual([]);
  });

  test("a URL is queued once however many pages link to it", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/a", "/a#top", "/a/../a", "/b") }) },
      "/a": { body: page({ body: linkTo("/b", "/a") }) },
      "/b": { body: page({ body: linkTo("/a") }) },
    });
    await crawlSite(opts(site));
    expect(site.hits("/a")).toBe(1);
    expect(site.hits("/b")).toBe(1);
  });

  test("pages are listed in discovery order", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/a", "/b", "/c") }) },
      "/a": { body: page() },
      "/b": { body: page() },
      "/c": { body: page() },
    });
    const ctx = await crawlSite(opts(site, { concurrency: 3 }));
    expect(ctx.pages.map((p) => p.url)).toEqual(["/", "/a", "/b", "/c"].map((p) => site.url(p)));
  });
});

describe("sitemaps", () => {
  test("an index with two child sitemaps yields every same-origin URL", async () => {
    const site = await start({
      "/robots.txt": (req) => ({
        headers: ROBOTS_TEXT,
        body: `Sitemap: http://${req.headers.host}/index.xml\n`,
      }),
      "/index.xml": (req) => ({
        headers: { "content-type": "application/xml" },
        body: `<sitemapindex><sitemap><loc>http://${req.headers.host}/s1.xml</loc></sitemap><sitemap><loc>http://${req.headers.host}/s2.xml</loc></sitemap></sitemapindex>`,
      }),
      "/s1.xml": (req) => ({
        headers: { "content-type": "application/xml" },
        body: `<urlset><url><loc>http://${req.headers.host}/p1</loc></url><url><loc>http://${req.headers.host}/p2</loc></url></urlset>`,
      }),
      "/s2.xml": (req) => ({
        headers: { "content-type": "text/xml" },
        body: `<urlset><url><loc>http://${req.headers.host}/p3</loc></url><url><loc>http://${req.headers.host}/p1</loc></url><url><loc>https://other.example/x</loc></url></urlset>`,
      }),
      "/": { body: page({ body: linkTo("/p1") }) },
      "/p1": { body: page() },
      "/p2": { body: page() },
      "/p3": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(ctx.sitemap.found).toBe(true);
    expect(ctx.sitemap.urls).toEqual([site.url("/p1"), site.url("/p2"), site.url("/p3")]);
    expect(ctx.sitemap.files.map((f) => [f.url, f.status, f.ok])).toEqual([
      [site.url("/index.xml"), 200, true],
      [site.url("/s1.xml"), 200, true],
      [site.url("/s2.xml"), 200, true],
    ]);
    expect(ctx.robots.sitemaps).toEqual([site.url("/index.xml")]);
    expect(pageAt(ctx, site.url("/p1"))).toMatchObject({ depth: 1, inSitemap: true });
    expect(pageAt(ctx, site.url("/p2"))).toMatchObject({ depth: "sitemap", inSitemap: true });
    expect(pageAt(ctx, site.url("/p3"))).toMatchObject({ depth: "sitemap", inSitemap: true });
    expect(pageAt(ctx, site.url("/")).inSitemap).toBe(false);
    expect(site.hits("/sitemap.xml")).toBe(0);
  });

  test("sitemap.xml is read when robots.txt names none", async () => {
    const site = await start({
      "/sitemap.xml": (req) => ({
        headers: { "content-type": "application/xml" },
        body: `<urlset><url><loc>http://${req.headers.host}/only</loc></url></urlset>`,
      }),
      "/": { body: page() },
      "/only": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(ctx.sitemap.urls).toEqual([site.url("/only")]);
    expect(pageAt(ctx, site.url("/only")).depth).toBe("sitemap");
  });

  test("a guessed sitemap.xml that answers with an HTML page is not recorded as a sitemap file", async () => {
    const site = await start({
      "/sitemap.xml": { body: page({ title: "Home" }) },
      "/": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(site.hits("/sitemap.xml")).toBe(1);
    expect(ctx.sitemap).toEqual({ found: false, urls: [], files: [] });
  });

  test("a guessed sitemap.xml whose body is HTML under an XML type is not recorded either", async () => {
    const site = await start({
      "/sitemap.xml": {
        headers: { "content-type": "application/xml" },
        body: "\n <!DOCTYPE html><html><body>Not found</body></html>",
      },
      "/": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(ctx.sitemap.files).toEqual([]);
  });

  test("a gzip sitemap is skipped with a note and never requested", async () => {
    const site = await start({
      "/robots.txt": (req) => ({
        headers: ROBOTS_TEXT,
        body: `Sitemap: http://${req.headers.host}/sitemap.xml.gz\n`,
      }),
      "/": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(site.hits("/sitemap.xml.gz")).toBe(0);
    expect(ctx.sitemap.found).toBe(false);
    expect(ctx.sitemap.files).toHaveLength(1);
    expect(ctx.sitemap.files[0]).toMatchObject({ status: null, ok: false });
    expect(ctx.sitemap.files[0]?.note).toMatch(/gzip/i);
  });

  test("a missing, failing or invalid sitemap file is recorded with a note", async () => {
    const site = await start({
      "/robots.txt": (req) => ({
        headers: ROBOTS_TEXT,
        body: [
          `Sitemap: http://${req.headers.host}/gone.xml`,
          `Sitemap: http://${req.headers.host}/broken.xml`,
          `Sitemap: http://${req.headers.host}/html.xml`,
        ].join("\n"),
      }),
      "/broken.xml": { status: 500, body: "x" },
      "/html.xml": { body: "<html><body>not a sitemap</body></html>" },
      "/": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(ctx.sitemap.found).toBe(false);
    expect(ctx.sitemap.files.map((f) => [f.status, f.ok, f.note])).toEqual([
      [404, false, "status 404"],
      [500, false, "status 500"],
      [200, false, "invalid"],
    ]);
  });

  test("at most five sitemap files are read", async () => {
    const children = [1, 2, 3, 4, 5, 6, 7].map((n) => `/c${n}.xml`);
    const routes: SiteDef = {
      "/robots.txt": (req) => ({
        headers: ROBOTS_TEXT,
        body: `Sitemap: http://${req.headers.host}/index.xml\n`,
      }),
      "/index.xml": (req) => ({
        headers: { "content-type": "application/xml" },
        body: `<sitemapindex>${children.map((c) => `<sitemap><loc>http://${req.headers.host}${c}</loc></sitemap>`).join("")}</sitemapindex>`,
      }),
      "/": { body: page() },
    };
    for (const c of children) {
      routes[c] = { headers: { "content-type": "application/xml" }, body: "<urlset></urlset>" };
    }
    const site = await start(routes);
    const ctx = await crawlSite(opts(site));
    expect(ctx.sitemap.files).toHaveLength(5);
    expect(site.hits("/c5.xml")).toBe(0);
  });

  test("sitemap URLs that robots.txt disallows are listed and not fetched", async () => {
    const site = await start({
      "/robots.txt": (req) => ({
        headers: ROBOTS_TEXT,
        body: `User-agent: *\nDisallow: /hidden\nSitemap: http://${req.headers.host}/sm.xml\n`,
      }),
      "/sm.xml": (req) => ({
        headers: { "content-type": "application/xml" },
        body: `<urlset><url><loc>http://${req.headers.host}/hidden</loc></url></urlset>`,
      }),
      "/": { body: page() },
      "/hidden": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(site.hits("/hidden")).toBe(0);
    expect(ctx.limits.blockedByRobots).toEqual([site.url("/hidden")]);
  });

  test("sitemap-only pages count in the uncrawled total when maxPages is reached", async () => {
    const site = await start({
      "/sitemap.xml": (req) => ({
        headers: { "content-type": "application/xml" },
        body: `<urlset><url><loc>http://${req.headers.host}/x</loc></url><url><loc>http://${req.headers.host}/y</loc></url></urlset>`,
      }),
      "/": { body: page() },
      "/x": { body: page() },
      "/y": { body: page() },
    });
    const ctx = await crawlSite(opts(site, { maxPages: 1 }));
    expect(ctx.limits.uncrawled).toBe(2);
    expect(urls(ctx)).toEqual([site.url("/")]);
  });
});

describe("redirects", () => {
  test("an internal redirect keeps its hops and the target is its own page", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/old") }) },
      "/old": { status: 301, headers: { location: "/new" } },
      "/new": { body: page({ title: "New", body: linkTo("/deep") }) },
      "/deep": { body: page({ title: "Deep" }) },
    });
    const ctx = await crawlSite(opts(site));
    const old = pageAt(ctx, site.url("/old"));
    expect(old.hops).toEqual([{ url: site.url("/old"), status: 301, location: site.url("/new") }]);
    expect(old.finalUrl).toBe(site.url("/new"));
    expect(old.status).toBe(200);
    expect(old.doc).toBeNull();
    expect(old.inlinks).toEqual([site.url("/")]);
    const target = pageAt(ctx, site.url("/new"));
    expect(target.hops).toEqual([]);
    expect(target.finalUrl).toBe(site.url("/new"));
    expect(target.doc?.title).toBe("New");
    expect(target.depth).toBe(1);
    expect(pageAt(ctx, site.url("/deep")).depth).toBe(2);
    expect(site.hits("/new")).toBe(1);
    expect(site.hits("/old")).toBe(1);
  });

  test("a redirect that leaves the origin is recorded and never followed", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/go") }) },
      "/go": { status: 301, headers: { location: "https://other.example/x" } },
    });
    const web = fakeWeb({});
    const real = globalThis.fetch;
    const ctx = await crawlSite(opts(site), {
      fetchImpl: (input, init) => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return raw.startsWith(site.origin) ? real(input, init) : web.fetchImpl(input, init);
      },
    });
    expect(web.seen).toEqual([]);
    const go = pageAt(ctx, site.url("/go"));
    expect(go.finalUrl).toBe("https://other.example/x");
    expect(go.hops).toHaveLength(1);
    expect(go.status).toBe(301);
    expect(go.doc).toBeNull();
    expect(go.isHtml).toBe(false);
    expect(ctx.pages).toHaveLength(2);
  });

  test("a redirect into a robots-disallowed path stops before the disallowed request", async () => {
    const site = await start({
      "/robots.txt": { headers: ROBOTS_TEXT, body: "User-agent: *\nDisallow: /secret/\n" },
      "/": { body: page({ body: linkTo("/go") }) },
      "/go": { status: 302, headers: { location: "/secret/x" } },
      "/secret/x": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(site.hits("/secret/x")).toBe(0);
    const go = pageAt(ctx, site.url("/go"));
    expect(go.failure).toBe("blocked-by-robots");
    expect(go.finalUrl).toBe(site.url("/secret/x"));
    expect(ctx.limits.blockedByRobots).toEqual([site.url("/secret/x")]);
  });

  test("a redirect into an excluded path stops before the excluded request", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/go") }) },
      "/go": { status: 302, headers: { location: "/private/x" } },
      "/private/x": { body: page() },
    });
    const ctx = await crawlSite(opts(site, { exclude: ["/private/**"] }));
    expect(site.hits("/private/x")).toBe(0);
    expect(pageAt(ctx, site.url("/go")).status).toBe(302);
  });

  test("a redirect loop is recorded as a failure", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/a") }) },
      "/a": { status: 302, headers: { location: "/b" } },
      "/b": { status: 302, headers: { location: "/a" } },
    });
    const ctx = await crawlSite(opts(site));
    const a = pageAt(ctx, site.url("/a"));
    expect(a.failure).toBe("redirect-loop");
    expect(a.status).toBeNull();
    expect(a.hops).toHaveLength(2);
  });

  test("a start URL that redirects inside the origin is audited at its target", async () => {
    const site = await start({
      "/": { status: 301, headers: { location: "/home" } },
      "/home": { body: page({ title: "Home" }) },
    });
    const ctx = await crawlSite(opts(site));
    expect(ctx.originNote).toBeNull();
    expect(ctx.startUrl).toBe(site.url("/home"));
    expect(pageAt(ctx, site.url("/")).hops).toHaveLength(1);
    expect(pageAt(ctx, site.url("/home")).doc?.title).toBe("Home");
    expect(site.hits("/home")).toBe(1);
  });
});

describe("requests stay on the origin and out of disallowed paths", () => {
  test("a robots.txt that redirects to a different site is unreadable and nothing is sent there", async () => {
    const site = await start({
      "/robots.txt": { status: 301, headers: { location: "https://other.example/robots.txt" } },
      "/": { body: page() },
    });
    const spy = offOriginSpy(site);
    const run = crawlSite(opts(site), { fetchImpl: spy.fetchImpl });
    await expect(run).rejects.toBeInstanceOf(UnreachableError);
    await expect(crawlSite(opts(site), { fetchImpl: spy.fetchImpl })).rejects.toThrow(
      /redirected to a different site/,
    );
    expect(site.hits("/")).toBe(0);
    expect(spy.seen).toEqual([]);

    const ctx = await crawlSite(opts(site, { ignoreRobots: true }), { fetchImpl: spy.fetchImpl });
    expect(ctx.robots).toMatchObject({ status: 301, present: false, ignored: true });
    expect(spy.seen).toEqual([]);
  });

  test("a sitemap.xml that redirects to a different site is noted and nothing is sent there", async () => {
    const site = await start({
      "/sitemap.xml": { status: 302, headers: { location: "https://other.example/sitemap.xml" } },
      "/": { body: page() },
    });
    const spy = offOriginSpy(site);
    const ctx = await crawlSite(opts(site), { fetchImpl: spy.fetchImpl });
    expect(spy.seen).toEqual([]);
    expect(ctx.sitemap.found).toBe(false);
    expect(ctx.sitemap.files).toEqual([
      {
        url: site.url("/sitemap.xml"),
        status: 302,
        ok: false,
        note: "redirected to a different site, not read",
      },
    ]);
  });

  test("a sitemap named in robots.txt that redirects to a different site is noted and not followed", async () => {
    const site = await start({
      "/robots.txt": (req) => ({
        headers: ROBOTS_TEXT,
        body: `Sitemap: http://${req.headers.host}/named.xml
`,
      }),
      "/named.xml": { status: 301, headers: { location: "https://other.example/named.xml" } },
      "/": { body: page() },
    });
    const spy = offOriginSpy(site);
    const ctx = await crawlSite(opts(site), { fetchImpl: spy.fetchImpl });
    expect(spy.seen).toEqual([]);
    expect(ctx.sitemap.files).toHaveLength(1);
    expect(ctx.sitemap.files[0]).toMatchObject({ status: 301, ok: false });
    expect(ctx.sitemap.files[0]?.note).toMatch(/different site/);
  });

  test("a start URL that redirects into a disallowed path never requests it", async () => {
    const site = await start({
      "/robots.txt": { headers: ROBOTS_TEXT, body: "User-agent: *\nDisallow: /secret/\n" },
      "/": { status: 302, headers: { location: "/secret/" } },
      "/secret/": { body: page({ title: "Secret" }) },
    });
    await expect(crawlSite(opts(site))).rejects.toBeInstanceOf(UnreachableError);
    await expect(crawlSite(opts(site))).rejects.toThrow(/disallows/);
    expect(site.hits("/secret/")).toBe(0);

    const ctx = await crawlSite(opts(site, { ignoreRobots: true }));
    expect(site.hits("/secret/")).toBe(1);
    expect(pageAt(ctx, site.url("/secret/")).doc?.title).toBe("Secret");
  });

  test("a start URL that redirects into an excluded path never requests it, even with robots ignored", async () => {
    const site = await start({
      "/": { status: 302, headers: { location: "/private/x" } },
      "/private/x": { body: page() },
    });
    await expect(crawlSite(opts(site, { exclude: ["/private/**"] }))).rejects.toThrow(/exclude/);
    await expect(
      crawlSite(opts(site, { exclude: ["/private/**"], ignoreRobots: true })),
    ).rejects.toBeInstanceOf(UnreachableError);
    expect(site.hits("/private/x")).toBe(0);
  });

  test("a start URL that moves to another origin is held to that origin's robots.txt", async () => {
    const target = await start({
      "/robots.txt": { headers: ROBOTS_TEXT, body: "User-agent: *\nDisallow: /secret/\n" },
      "/secret/x": { body: page() },
    });
    const origin = await start({
      "/": { status: 302, headers: { location: target.url("/secret/x") } },
    });
    await expect(crawlSite(opts(origin))).rejects.toThrow(/disallows/);
    expect(target.hits("/secret/x")).toBe(0);
    expect(target.hits("/robots.txt")).toBeGreaterThan(0);
  });

  test("a start URL that moves to an origin with an unreadable robots.txt requests only robots.txt there", async () => {
    const target = await start({
      "/robots.txt": { status: 500, body: "oops" },
      "/": { body: page() },
    });
    const origin = await start({ "/": { status: 302, headers: { location: target.url("/") } } });
    await expect(crawlSite(opts(origin))).rejects.toThrow(/robots.txt could not be read/);
    expect(paths(target)).toEqual(["/robots.txt"]);
  });

  test("a start URL that passes through a second foreign host is not followed there", async () => {
    const last = await start({ "/": { body: page() } });
    const middle = await start({ "/": { status: 302, headers: { location: last.url("/") } } });
    const origin = await start({ "/": { status: 302, headers: { location: middle.url("/") } } });
    await expect(crawlSite(opts(origin))).rejects.toThrow(/several hosts/);
    expect(last.log).toEqual([]);
  });
});

type StandIn = { ctx: Promise<SiteContext>; seen: string[] };

/** Crawls a stand-in network, for tests that need real host names. */
function crawlStandIn(
  routes: Record<string, FakeRoute>,
  startUrl: string,
  over: Partial<AuditOptions> = {},
): StandIn {
  const web = fakeWeb(routes);
  const ctx = crawlSite(
    { ...DEFAULT_OPTIONS, startUrl, delayMs: 0, timeoutMs: 2000, ...over },
    { fetchImpl: web.fetchImpl },
  );
  return { ctx, seen: web.seen };
}

describe("same-site redirects of robots.txt and sitemaps", () => {
  test("a robots.txt redirect to the www sibling is followed and its rules apply to the asked origin", async () => {
    const routes: Record<string, FakeRoute> = {
      "https://site.example/robots.txt": {
        status: 301,
        location: "https://www.site.example/robots.txt",
      },
      "https://www.site.example/robots.txt": { body: SECRET_ROBOTS },
      "https://site.example/": { body: HOME_WITH_SECRET },
      "https://site.example/ok": { body: page() },
      "https://site.example/secret/x": { body: page() },
    };
    const run = crawlStandIn(routes, "https://site.example/");
    const ctx = await run.ctx;
    expect(ctx.robots).toMatchObject({ status: 200, present: true });
    expect(ctx.limits.blockedByRobots).toEqual(["https://site.example/secret/x"]);
    expect(run.seen).not.toContain("GET https://site.example/secret/x");
    expect(run.seen).toContain("GET https://www.site.example/robots.txt");

    const blocked = crawlStandIn(routes, "https://site.example/secret/x");
    await expect(blocked.ctx).rejects.toThrow(/disallows/);
    expect(blocked.seen).not.toContain("GET https://site.example/secret/x");
  });

  test("a robots.txt redirect from http to https is followed", async () => {
    const run = crawlStandIn(
      {
        "http://site.example/robots.txt": {
          status: 301,
          location: "https://site.example/robots.txt",
        },
        "https://site.example/robots.txt": { body: SECRET_ROBOTS },
        "http://site.example/": { body: HOME_WITH_SECRET },
        "http://site.example/ok": { body: page() },
        "http://site.example/secret/x": { body: page() },
      },
      "http://site.example/",
    );
    const ctx = await run.ctx;
    expect(ctx.robots).toMatchObject({ status: 200, present: true });
    expect(ctx.limits.blockedByRobots).toEqual(["http://site.example/secret/x"]);
    expect(run.seen).not.toContain("GET http://site.example/secret/x");
  });

  test("a robots.txt redirect to an unrelated host sends nothing there", async () => {
    const routes: Record<string, FakeRoute> = {
      "https://site.example/robots.txt": {
        status: 301,
        location: "https://other.example/robots.txt",
      },
      "https://site.example/": { body: page() },
    };
    const run = crawlStandIn(routes, "https://site.example/");
    await expect(run.ctx).rejects.toThrow(/different site/);
    expect(run.seen.filter((s) => s.includes("other.example"))).toEqual([]);
    expect(run.seen).not.toContain("GET https://site.example/");

    const ignored = crawlStandIn(routes, "https://site.example/", { ignoreRobots: true });
    expect((await ignored.ctx).robots.present).toBe(false);
    expect(ignored.seen.filter((s) => s.includes("other.example"))).toEqual([]);
  });

  test("a robots.txt redirect chain that is same-site and then leaves the site sends nothing further", async () => {
    const routes: Record<string, FakeRoute> = {
      "https://site.example/robots.txt": {
        status: 301,
        location: "https://www.site.example/robots.txt",
      },
      "https://www.site.example/robots.txt": {
        status: 301,
        location: "https://other.example/robots.txt",
      },
      "https://site.example/": { body: page() },
    };
    const run = crawlStandIn(routes, "https://site.example/");
    await expect(run.ctx).rejects.toThrow(/robots.txt could not be read.*different site/);
    expect(run.seen.filter((s) => s.includes("other.example"))).toEqual([]);
    expect(run.seen).toContain("GET https://www.site.example/robots.txt");
    expect(run.seen).not.toContain("GET https://site.example/");
  });

  test("a sitemap redirect to the www sibling is followed", async () => {
    const run = crawlStandIn(
      {
        "https://site.example/sitemap.xml": {
          status: 301,
          location: "https://www.site.example/sitemap.xml",
        },
        "https://www.site.example/sitemap.xml": {
          body: "<urlset><url><loc>https://site.example/p1</loc></url></urlset>",
        },
        "https://site.example/": { body: page() },
        "https://site.example/p1": { body: page() },
      },
      "https://site.example/",
    );
    const ctx = await run.ctx;
    expect(ctx.sitemap.found).toBe(true);
    expect(ctx.sitemap.urls).toEqual(["https://site.example/p1"]);
    expect(ctx.sitemap.files).toEqual([
      { url: "https://site.example/sitemap.xml", status: 200, ok: true, note: null },
    ]);
    expect(ctx.pages.map((p) => p.url)).toContain("https://site.example/p1");
  });

  test("a sitemap redirect from http to https is followed", async () => {
    const run = crawlStandIn(
      {
        "http://site.example/sitemap.xml": {
          status: 301,
          location: "https://site.example/sitemap.xml",
        },
        "https://site.example/sitemap.xml": {
          body: "<urlset><url><loc>http://site.example/p1</loc></url></urlset>",
        },
        "http://site.example/": { body: page() },
        "http://site.example/p1": { body: page() },
      },
      "http://site.example/",
    );
    const ctx = await run.ctx;
    expect(ctx.sitemap.found).toBe(true);
    expect(ctx.sitemap.urls).toEqual(["http://site.example/p1"]);
  });

  test("a sitemap redirect to an unrelated host sends nothing there", async () => {
    const run = crawlStandIn(
      {
        "https://site.example/sitemap.xml": {
          status: 302,
          location: "https://other.example/sitemap.xml",
        },
        "https://site.example/": { body: page() },
      },
      "https://site.example/",
    );
    const ctx = await run.ctx;
    expect(run.seen.filter((s) => s.includes("other.example"))).toEqual([]);
    expect(ctx.sitemap.files).toEqual([
      {
        url: "https://site.example/sitemap.xml",
        status: 302,
        ok: false,
        note: "redirected to a different site, not read",
      },
    ]);
  });
});

describe("a start redirect that moves the origin", () => {
  test("a shifted URL that fails without being blocked ends the audit instead of repeating", async () => {
    const run = crawlStandIn(
      {
        "https://site.example/": { status: 302, location: "https://www.site.example/" },
        "https://www.site.example/": { status: 302, location: "mailto:a@site.example" },
      },
      "https://site.example/",
    );
    await expect(run.ctx).rejects.toBeInstanceOf(UnreachableError);
    expect(run.seen.filter((s) => s === "GET https://www.site.example/")).toHaveLength(1);
    expect(run.seen.filter((s) => s === "GET https://www.site.example/robots.txt")).toHaveLength(1);
  }, 4000);

  test("a same-site chain from http apex to https www reads each robots.txt before the page", async () => {
    const clock = instantClock();
    const web = fakeWeb({
      "http://site.example/": { status: 301, location: "https://site.example/" },
      "https://site.example/": { status: 301, location: "https://www.site.example/" },
      "https://www.site.example/robots.txt": {
        body: "User-agent: *\nCrawl-delay: 5\nDisallow: /secret/\n",
      },
      "https://www.site.example/": {
        body: page({ title: "Www", body: linkTo("/secret/x", "/ok") }),
      },
      "https://www.site.example/ok": { body: page() },
    });
    const log: { at: number; request: string }[] = [];
    const ctx = await crawlSite(
      { ...DEFAULT_OPTIONS, startUrl: "http://site.example/", delayMs: 0, timeoutMs: 2000 },
      {
        clock,
        fetchImpl: (input, init) => {
          log.push({ at: clock.now(), request: `${init?.method ?? "GET"} ${rawUrl(input)}` });
          return web.fetchImpl(input, init);
        },
      },
    );
    expect(ctx.origin).toBe("https://www.site.example");
    expect(ctx.originNote).toBe("Start URL redirected to https://www.site.example/");
    expect(ctx.robots.crawlDelay).toBe(5000);
    const requests = log.map((entry) => entry.request);
    const indexOf = (request: string): number => {
      const at = requests.indexOf(request);
      expect(at, request).toBeGreaterThanOrEqual(0);
      return at;
    };
    expect(indexOf("GET https://site.example/robots.txt")).toBeLessThan(
      indexOf("GET https://site.example/"),
    );
    const robotsAt = indexOf("GET https://www.site.example/robots.txt");
    const homeAt = indexOf("GET https://www.site.example/");
    expect(robotsAt).toBeLessThan(homeAt);
    expect((log[homeAt]?.at ?? 0) - (log[robotsAt]?.at ?? 0)).toBeGreaterThanOrEqual(5000);
    expect(requests).not.toContain("GET https://www.site.example/secret/x");
  });

  test("a fourth same-site origin shift is not followed", async () => {
    const run = crawlStandIn(
      {
        "http://site.example/": { status: 301, location: "https://site.example/" },
        "https://site.example/": { status: 301, location: "https://www.site.example/" },
        "https://www.site.example/": { status: 301, location: "http://www.site.example/" },
        "http://www.site.example/": { status: 301, location: "http://site.example/home" },
        "http://site.example/home": { body: page() },
      },
      "http://site.example/",
    );
    await expect(run.ctx).rejects.toThrow(/several hosts/);
    expect(run.seen).not.toContain("GET http://site.example/home");
  });

  test("a shifted URL that answers with a broken Location fails once", async () => {
    const run = crawlStandIn(
      {
        "https://site.example/": { status: 301, location: "https://www.site.example/x" },
        "https://www.site.example/x": { status: 301, location: "http://[bad" },
      },
      "https://site.example/",
    );
    await expect(run.ctx).rejects.toBeInstanceOf(UnreachableError);
    expect(run.seen.filter((s) => s === "GET https://www.site.example/x")).toHaveLength(1);
  }, 4000);
});

describe("a start redirect that changes only the scheme", () => {
  test("does not wait on its own gate slot when concurrency is 1", async () => {
    const run = crawlStandIn(
      {
        "http://site.example/": { status: 301, location: "https://site.example/" },
        "https://site.example/": { body: page({ title: "Secure" }) },
      },
      "http://site.example/",
      { concurrency: 1 },
    );
    const ctx = await run.ctx;
    expect(ctx.origin).toBe("https://site.example");
    expect(ctx.originNote).toBe("Start URL redirected to https://site.example/");
    expect(ctx.pages.find((p) => p.url === "https://site.example/")?.doc?.title).toBe("Secure");
    expect(run.seen.filter((s) => s === "GET https://site.example/robots.txt")).toHaveLength(1);
  }, 4000);
});

describe("pages", () => {
  test("a non-HTML page is a resource: recorded, not parsed, not followed", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/file.pdf", "/ok") }) },
      "/file.pdf": { headers: { "content-type": "application/pdf" }, body: "%PDF" },
      "/ok": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    const pdf = pageAt(ctx, site.url("/file.pdf"));
    expect(pdf).toMatchObject({ isHtml: false, doc: null, status: 200 });
    expect(pdf.inlinks).toEqual([site.url("/")]);
  });

  test("resources do not use up the page budget", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/file.pdf", "/a", "/b") }) },
      "/file.pdf": { headers: { "content-type": "application/pdf" }, body: "%PDF" },
      "/a": { body: page() },
      "/b": { body: page() },
    });
    const ctx = await crawlSite(opts(site, { maxPages: 3, concurrency: 1 }));
    expect(urls(ctx)).toEqual(["/", "/a", "/b", "/file.pdf"].map((p) => site.url(p)));
    expect(ctx.limits.uncrawled).toBe(0);
  });

  test("linked files that are not HTML are capped at maxPages and the rest is uncrawled", async () => {
    const files = Array.from({ length: 12 }, (_, i) => `/f${i}.bin`);
    const def: SiteDef = { "/": { body: page({ body: linkTo(...files, "/a") }) } };
    for (const file of files) {
      def[file] = {
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.alloc(300 * 1024),
      };
    }
    def["/a"] = { body: page() };
    const site = await start(def);
    const ctx = await crawlSite(opts(site, { maxPages: 2 }));
    const fetched = files.filter((file) => site.hits(file) > 0);
    expect(fetched).toHaveLength(2);
    expect(ctx.limits.uncrawled).toBe(11);
    const first = pageAt(ctx, site.url("/f0.bin"));
    expect(first).toMatchObject({ isHtml: false, doc: null, bytes: 300 * 1024 });
  });

  test("error pages are recorded without a parsed document", async () => {
    const site = await start({ "/": { body: page({ body: linkTo("/missing") }) } });
    const ctx = await crawlSite(opts(site));
    const missing = pageAt(ctx, site.url("/missing"));
    expect(missing).toMatchObject({ status: 404, failure: null, doc: null, isHtml: true });
    expect(missing.inlinks).toEqual([site.url("/")]);
  });

  test("a page that times out is recorded as a failure", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/slow") }) },
      "/slow": { body: page(), delayMs: 600 },
    });
    const ctx = await crawlSite(opts(site, { timeoutMs: 150 }));
    expect(pageAt(ctx, site.url("/slow"))).toMatchObject({ status: null, failure: "timeout" });
  });

  test("timing, size and header facts are kept on the record", async () => {
    const site = await start({
      "/": { body: page(), headers: { "x-test": "yes" }, gzip: true },
    });
    const ctx = await crawlSite(opts(site));
    const home = pageAt(ctx, site.url("/"));
    expect(home.status).toBe(200);
    expect(home.headers["x-test"]).toBe("yes");
    expect(home.headers["content-encoding"]).toBe("gzip");
    expect(home.responseMs).toBeGreaterThanOrEqual(0);
    expect(home.totalMs).toBeGreaterThanOrEqual(home.responseMs ?? 0);
    expect(home.bytes).toBe(Buffer.byteLength(page()));
    expect(home.transferBytes).toBeGreaterThan(0);
    expect(home.truncated).toBe(false);
    expect(home.doc?.title).toBe("Fixture page for the site audit");
  });

  test("a page nested past the guard is marked truncated", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/deep", "/flat") }) },
      "/deep": { body: page({ body: "<div>".repeat(3000) }) },
      "/flat": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(pageAt(ctx, site.url("/deep")).truncated).toBe(true);
    expect(pageAt(ctx, site.url("/deep")).doc).not.toBeNull();
    expect(pageAt(ctx, site.url("/flat")).truncated).toBe(false);
    expect(pageAt(ctx, site.url("/")).truncated).toBe(false);
  });

  test("links from sitemap-only pages are not followed", async () => {
    const site = await start({
      "/sitemap.xml": (req) => ({
        headers: { "content-type": "application/xml" },
        body: `<urlset><url><loc>http://${req.headers.host}/s</loc></url></urlset>`,
      }),
      "/": { body: page() },
      "/s": { body: page({ body: linkTo("/beyond") }) },
      "/beyond": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(site.hits("/beyond")).toBe(0);
    expect(urls(ctx)).toEqual([site.url("/"), site.url("/s")]);
  });
});

describe("inlinks", () => {
  test("lists the crawled pages that link to each page, once and never itself", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/a", "/b", "/a") }) },
      "/a": { body: page({ body: linkTo("/b", "/", "/a") }) },
      "/b": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(pageAt(ctx, site.url("/")).inlinks).toEqual([site.url("/a")]);
    expect(pageAt(ctx, site.url("/a")).inlinks).toEqual([site.url("/")]);
    expect(pageAt(ctx, site.url("/b")).inlinks).toEqual([site.url("/"), site.url("/a")]);
  });
});

describe("assets", () => {
  const assetPages: SiteDef = {
    "/": { body: page({ body: linkTo("/p2", "/p3") }) },
    "/p2": { body: page() },
    "/p3": { body: page() },
    "/shared.png": { headers: { "content-type": "image/png" }, body: Buffer.alloc(1234) },
    "/app.js": { headers: { "content-type": "application/javascript" }, body: "x".repeat(50) },
    "/style.css": { headers: { "content-type": "text/css" }, body: "b{}" },
  };

  function withAssets(): SiteDef {
    const def: SiteDef = { ...assetPages };
    const assetMarkup = `<img src="/shared.png" alt="s"><script src="/app.js"></script>`;
    def["/"] = {
      body: page({
        head: '<link rel="stylesheet" href="/style.css">',
        body: `${assetMarkup}${linkTo("/p2", "/p3")}`,
      }),
    };
    for (const p of ["/p2", "/p3"]) {
      def[p] = {
        body: page({ head: '<link rel="stylesheet" href="/style.css">', body: assetMarkup }),
      };
    }
    return def;
  }

  test("each asset is probed once however many pages use it", async () => {
    const site = await start(withAssets());
    const ctx = await crawlSite(opts(site));
    expect(site.hits("/shared.png")).toBe(1);
    expect(site.hits("/app.js")).toBe(1);
    expect(site.hits("/style.css")).toBe(1);
    expect(site.log.filter((r) => r.path === "/shared.png").map((r) => r.method)).toEqual(["HEAD"]);
    expect(ctx.assets.map((a) => [a.url, a.kind])).toEqual([
      [site.url("/shared.png"), "image"],
      [site.url("/app.js"), "script"],
      [site.url("/style.css"), "stylesheet"],
    ]);
    const image = ctx.assets[0];
    expect(image).toMatchObject({
      thirdParty: false,
      status: 200,
      bytes: 1234,
      contentType: "image/png",
      contentEncoding: null,
      cacheControl: null,
      measured: true,
    });
    expect(image?.usedBy).toEqual([site.url("/"), site.url("/p2"), site.url("/p3")]);
    expect(ctx.limits.assetsNotMeasured).toBe(0);
  });

  test("maxAssets leaves the rest unmeasured", async () => {
    const site = await start({
      "/": { body: page({ body: `<img src="/1.png"><img src="/2.png"><img src="/3.png">` }) },
      "/1.png": { headers: { "content-type": "image/png" }, body: "1" },
      "/2.png": { headers: { "content-type": "image/png" }, body: "22" },
      "/3.png": { headers: { "content-type": "image/png" }, body: "333" },
    });
    const ctx = await crawlSite(opts(site, { maxAssets: 1 }));
    expect(ctx.assets.map((a) => a.measured)).toEqual([true, false, false]);
    expect(ctx.assets[1]).toMatchObject({ status: null, bytes: null, usedBy: [site.url("/")] });
    expect(ctx.limits.assetsNotMeasured).toBe(2);
    expect(site.hits("/2.png")).toBe(0);
    expect(site.hits("/3.png")).toBe(0);
  });

  test("a robots-disallowed asset is not requested", async () => {
    const site = await start({
      "/robots.txt": { headers: ROBOTS_TEXT, body: "User-agent: *\nDisallow: /private/\n" },
      "/": { body: page({ body: `<img src="/private/a.png"><img src="/b.png">` }) },
      "/private/a.png": { headers: { "content-type": "image/png" }, body: "a" },
      "/b.png": { headers: { "content-type": "image/png" }, body: "bb" },
    });
    const ctx = await crawlSite(opts(site));
    expect(site.hits("/private/a.png")).toBe(0);
    expect(ctx.assets.map((a) => a.measured)).toEqual([false, true]);
    expect(ctx.limits.assetsNotMeasured).toBe(1);
    expect(ctx.limits.blockedByRobots).toEqual([site.url("/private/a.png")]);
  });

  test("a missing asset is recorded with its status and no size", async () => {
    const site = await start({ "/": { body: page({ body: `<img src="/gone.png">` }) } });
    const ctx = await crawlSite(opts(site));
    expect(ctx.assets[0]).toMatchObject({ status: 404, bytes: null, measured: false });
    expect(ctx.limits.assetsNotMeasured).toBe(1);
  });

  test("an asset that redirects off the origin is not followed", async () => {
    const site = await start({
      "/": { body: page({ body: `<script src="/lib.js"></script>` }) },
      "/lib.js": { status: 302, headers: { location: "https://cdn.example/lib.js" } },
    });
    const web = fakeWeb({});
    const real = globalThis.fetch;
    const ctx = await crawlSite(opts(site), {
      fetchImpl: (input, init) => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return raw.startsWith(site.origin) ? real(input, init) : web.fetchImpl(input, init);
      },
    });
    expect(web.seen).toEqual([]);
    expect(ctx.assets[0]).toMatchObject({ measured: false });
  });

  test("the transfer encoding is kept for compressed assets", async () => {
    const site = await start({
      "/": { body: page({ head: '<link rel="stylesheet" href="/a.css">' }) },
      "/a.css": {
        headers: { "content-type": "text/css; charset=utf-8" },
        body: "a{}".repeat(500),
        gzip: true,
      },
    });
    const ctx = await crawlSite(opts(site));
    expect(ctx.assets[0]).toMatchObject({
      contentEncoding: "gzip",
      contentType: "text/css",
      measured: true,
    });
    expect(ctx.assets[0]?.bytes).toBeLessThan(1500);
  });

  test("a script whose HEAD answer has no encoding is checked once with GET for compression", async () => {
    const big = "a{}".repeat(1000);
    const site = await start({
      "/": { body: page({ head: '<link rel="stylesheet" href="/a.css">' }) },
      "/a.css": (req) =>
        req.method === "HEAD"
          ? { headers: { "content-type": "text/css" }, body: big }
          : { headers: { "content-type": "text/css" }, body: big, gzip: true },
    });
    const ctx = await crawlSite(opts(site));
    expect(site.log.filter((r) => r.path === "/a.css").map((r) => r.method)).toEqual([
      "HEAD",
      "GET",
    ]);
    expect(ctx.assets[0]).toMatchObject({ contentEncoding: "gzip", measured: true });
    expect(ctx.assets[0]?.bytes).toBeLessThan(big.length);
    const outcome = runChecks(ctx, ["performance"]).find((c) => c.id === "PERF-COMP-021");
    expect(outcome?.status).toBe("pass");
  });

  test("an image whose HEAD answer has no encoding is not fetched again", async () => {
    const site = await start({
      "/": { body: page({ body: '<img src="/big.png" alt="b">' }) },
      "/big.png": { headers: { "content-type": "image/png" }, body: Buffer.alloc(5000) },
    });
    await crawlSite(opts(site));
    expect(site.log.filter((r) => r.path === "/big.png").map((r) => r.method)).toEqual(["HEAD"]);
  });

  test("cacheControl holds the header, the word expires, or null", async () => {
    const site = await start({
      "/": {
        body: page({
          head: ["a", "b", "c", "d"]
            .map((n) => `<link rel="stylesheet" href="/${n}.css">`)
            .join(""),
        }),
      },
      "/a.css": {
        headers: { "content-type": "text/css", "cache-control": "max-age=60" },
        body: "a",
      },
      "/b.css": {
        headers: { "content-type": "text/css", expires: "Wed, 21 Oct 2037 07:28:00 GMT" },
        body: "b",
      },
      "/c.css": { headers: { "content-type": "text/css" }, body: "c" },
      "/d.css": {
        headers: {
          "content-type": "text/css",
          "cache-control": "no-store",
          expires: "Wed, 21 Oct 2037 07:28:00 GMT",
        },
        body: "d",
      },
    });
    const ctx = await crawlSite(opts(site));
    expect(ctx.assets.map((a) => a.cacheControl)).toEqual([
      "max-age=60",
      "expires",
      null,
      "no-store",
    ]);
  });

  test("an asset answering 503 is recorded as not measured, not as broken", async () => {
    const site = await start({
      "/": { body: page({ body: `<img src="/busy.png">` }) },
      "/busy.png": { status: 503, headers: { "retry-after": "0" }, body: "busy" },
    });
    const ctx = await crawlSite(opts(site));
    expect(ctx.assets[0]).toMatchObject({ status: null, bytes: null, measured: false });
    expect(site.hits("/busy.png")).toBe(1);
  });
});

describe("external hosts", () => {
  test("an off-origin link is never requested without checkExternal", async () => {
    const site = await start({
      "/": {
        body: page({
          body: `${linkTo("https://other.example/x")}<script src="https://cdn.example/lib.js"></script>`,
        }),
      },
    });
    const requested: string[] = [];
    const real = globalThis.fetch;
    const ctx = await crawlSite(opts(site), {
      fetchImpl: (input, init) => {
        requested.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return real(input, init);
      },
    });
    expect(requested.some((u) => u.includes("example/"))).toBe(false);
    expect(ctx.external).toBeNull();
    expect(ctx.assets[0]).toMatchObject({ thirdParty: true, measured: false, status: null });
    expect(ctx.limits.assetsNotMeasured).toBe(1);
    expect(urls(ctx)).toEqual([site.url("/")]);
  });

  test("with checkExternal an external link and a third-party script are probed once each", async () => {
    const other = await start({
      "/x": { body: page() },
      "/lib.js": { headers: { "content-type": "application/javascript" }, body: "12345" },
    });
    const site = await start({
      "/": {
        body: page({
          body: `${linkTo(other.url("/x"))}${linkTo(other.url("/x"))}<script src="${other.url("/lib.js")}"></script>`,
        }),
      },
    });
    const ctx = await crawlSite(opts(site, { checkExternal: true }));
    expect(other.hits("/x")).toBe(1);
    expect(other.hits("/lib.js")).toBe(1);
    expect(other.log.map((r) => r.method)).toEqual(["HEAD", "HEAD"]);
    expect(ctx.external).toEqual([
      { url: other.url("/x"), status: 200, failure: null, usedBy: [site.url("/")] },
    ]);
    expect(ctx.assets[0]).toMatchObject({
      url: other.url("/lib.js"),
      thirdParty: true,
      measured: true,
      bytes: 5,
    });
    expect(urls(ctx)).toEqual([site.url("/")]);
  });

  test("external links record the status as received, including throttling and failures", async () => {
    const other = await start({
      "/busy": { status: 429, body: "slow down" },
      "/gone": { status: 404, body: "no" },
      "/nohead": (req) => ({ status: req.method === "HEAD" ? 405 : 200, body: "fine" }),
    });
    const closed = await startSite({});
    const closedUrl = closed.url("/down");
    await closed.close();
    const site = await start({
      "/": {
        body: page({
          body: linkTo(other.url("/busy"), other.url("/gone"), other.url("/nohead"), closedUrl),
        }),
      },
    });
    const ctx = await crawlSite(opts(site, { checkExternal: true }));
    const byUrl = new Map((ctx.external ?? []).map((e) => [e.url, e]));
    expect(byUrl.get(other.url("/busy"))).toMatchObject({ status: 429, failure: null });
    expect(byUrl.get(other.url("/gone"))).toMatchObject({ status: 404, failure: null });
    expect(byUrl.get(other.url("/nohead"))).toMatchObject({ status: 200, failure: null });
    expect(byUrl.get(closedUrl)).toMatchObject({ status: null, failure: "connection" });
    expect(other.log.filter((r) => r.path === "/nohead").map((r) => r.method)).toEqual([
      "HEAD",
      "GET",
    ]);
    expect(other.hits("/busy")).toBe(1);
  });

  test("a third-party asset answering 503 is not measured", async () => {
    const other = await start({
      "/lib.js": { status: 503, headers: { "retry-after": "0" }, body: "busy" },
    });
    const site = await start({
      "/": { body: page({ body: `<script src="${other.url("/lib.js")}"></script>` }) },
    });
    const ctx = await crawlSite(opts(site, { checkExternal: true }));
    expect(ctx.assets[0]).toMatchObject({ status: null, measured: false, thirdParty: true });
    expect(other.hits("/lib.js")).toBe(1);
  });

  test("a third-party asset that redirects to another host is not followed", async () => {
    const site = await start({
      "/": { body: page({ body: `<script src="https://cdn.example/lib.js"></script>` }) },
    });
    const web = fakeWeb({
      "https://cdn.example/lib.js": { status: 302, location: "https://elsewhere.example/lib.js" },
    });
    const real = globalThis.fetch;
    const ctx = await crawlSite(opts(site, { checkExternal: true }), {
      fetchImpl: (input, init) =>
        rawUrl(input).startsWith(site.origin) ? real(input, init) : web.fetchImpl(input, init),
    });
    expect(web.seen).toEqual(["HEAD https://cdn.example/lib.js"]);
    expect(ctx.assets[0]).toMatchObject({ thirdParty: true, measured: false });
  });

  test("other hosts are held to one request at a time", async () => {
    const other = await start({
      "/a": { body: page(), delayMs: 200 },
      "/b": { body: page(), delayMs: 200 },
      "/c": { body: page(), delayMs: 200 },
    });
    const site = await start({
      "/": { body: page({ body: linkTo(other.url("/a"), other.url("/b"), other.url("/c")) }) },
    });
    await crawlSite(opts(site, { checkExternal: true, concurrency: 4 }));
    const times = other.log.map((r) => r.at);
    expect(times).toHaveLength(3);
    for (const gap of gaps(times)) expect(gap).toBeGreaterThanOrEqual(150);
  });
});

describe("origin probes", () => {
  test("the soft 404 probe is false for a site that answers 404 and checks the probe path", async () => {
    const site = await start({ "/": { body: page() } });
    const ctx = await crawlSite(opts(site));
    expect(ctx.probes.soft404).toBe(false);
    const probe = site.log.filter((r) => r.path.startsWith("/site-audit-cli-probe-"));
    expect(probe).toHaveLength(1);
    expect(probe[0]?.path).toMatch(/^\/site-audit-cli-probe-[0-9a-f]{16}$/);
  });

  test("the soft 404 probe is true when any path answers 200", async () => {
    const site = await start({ "/": { body: page() } });
    const real = globalThis.fetch;
    const ctx = await crawlSite(opts(site), {
      fetchImpl: (input, init) => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(raw).pathname.startsWith("/site-audit-cli-probe-")) {
          return Promise.resolve(
            new Response(page(), { status: 200, headers: { "content-type": "text/html" } }),
          );
        }
        return real(input, init);
      },
    });
    expect(ctx.probes.soft404).toBe(true);
  });

  test("favicon is false with no icon link and no favicon file", async () => {
    const site = await start({ "/": { body: page() } });
    const ctx = await crawlSite(opts(site));
    expect(ctx.probes.favicon).toBe(false);
    expect(site.hits("/favicon.ico")).toBeGreaterThan(0);
  });

  test("favicon is true from an icon link without asking for the file", async () => {
    const site = await start({ "/": { body: page({ head: '<link rel="icon" href="/x.png">' }) } });
    const ctx = await crawlSite(opts(site));
    expect(ctx.probes.favicon).toBe(true);
    expect(site.hits("/favicon.ico")).toBe(0);
  });

  test("favicon is true when the file exists", async () => {
    const site = await start({
      "/": { body: page() },
      "/favicon.ico": { headers: { "content-type": "image/x-icon" }, body: "ico" },
    });
    const ctx = await crawlSite(opts(site));
    expect(ctx.probes.favicon).toBe(true);
  });

  test("a favicon that robots.txt disallows is not requested and not judged", async () => {
    const site = await start({
      "/robots.txt": { headers: ROBOTS_TEXT, body: "User-agent: *\nDisallow: /favicon.ico\n" },
      "/": { body: page() },
    });
    const ctx = await crawlSite(opts(site));
    expect(site.hits("/favicon.ico")).toBe(0);
    expect(ctx.probes.favicon).toBeNull();
  });

  test("on a loopback host there is no sibling host to probe", async () => {
    const site = await start({ "/": { body: page() } });
    const ctx = await crawlSite(opts(site));
    expect(ctx.probes.siblingHost).toBeNull();
    expect(ctx.probes.siblingHostRedirects).toBeNull();
    expect(ctx.probes.httpRedirectsToHttps).toBeNull();
  });

  describe("with a stand-in network", () => {
    const home = page({ title: "Home" });
    const base: Record<string, FakeRoute> = {
      "https://site.example/": { body: home },
      "http://site.example/": { status: 301, location: "https://site.example/" },
    };

    function crawlFake(
      routes: Record<string, FakeRoute>,
      over: Partial<AuditOptions> = {},
    ): Promise<SiteContext> & { seen: string[] } {
      const web = fakeWeb({ ...base, ...routes });
      const run = crawlSite(
        {
          ...DEFAULT_OPTIONS,
          startUrl: "https://site.example/",
          delayMs: 0,
          timeoutMs: 2000,
          ...over,
        },
        { fetchImpl: web.fetchImpl },
      );
      return Object.assign(run, { seen: web.seen });
    }

    test("the http variant redirecting to https is detected with one request", async () => {
      const run = crawlFake({});
      const ctx = await run;
      expect(ctx.probes.httpRedirectsToHttps).toBe(true);
      expect(run.seen.filter((s) => s === "GET http://site.example/")).toHaveLength(1);
    });

    test("the http variant answering 200, or redirecting to an http page that answers 200, is false", async () => {
      const plain = await crawlFake({ "http://site.example/": { body: home } });
      expect(plain.probes.httpRedirectsToHttps).toBe(false);
      const sideways = await crawlFake({
        "http://site.example/": { status: 301, location: "http://site.example/home" },
        "http://site.example/home": { body: home },
      });
      expect(sideways.probes.httpRedirectsToHttps).toBe(false);
    });

    test("the http variant follows same-site redirects until one lands on https", async () => {
      const run = crawlFake({
        "http://site.example/": { status: 301, location: "http://www.site.example/" },
        "http://www.site.example/": { status: 301, location: "https://www.site.example/" },
      });
      const ctx = await run;
      expect(ctx.probes.httpRedirectsToHttps).toBe(true);
      expect(run.seen.filter((s) => s.startsWith("GET http://"))).toEqual([
        "GET http://site.example/",
        "GET http://www.site.example/",
      ]);
    });

    test("the http variant answering 4xx or 5xx, or redirecting off the site, gives null", async () => {
      const missing = await crawlFake({ "http://site.example/": { status: 404 } });
      expect(missing.probes.httpRedirectsToHttps).toBeNull();
      const broken = await crawlFake({ "http://site.example/": { status: 500 } });
      expect(broken.probes.httpRedirectsToHttps).toBeNull();
      const away = crawlFake({
        "http://site.example/": { status: 301, location: "http://other.example/" },
      });
      expect((await away).probes.httpRedirectsToHttps).toBeNull();
      expect(away.seen.filter((s) => s.includes("other.example"))).toEqual([]);
    });

    test("the http variant failing gives null, and an http origin gives no probe", async () => {
      const failing = await crawlFake({ "http://site.example/": "throw" });
      expect(failing.probes.httpRedirectsToHttps).toBeNull();
      const web = fakeWeb({ "http://site.example/": { body: home } });
      const ctx = await crawlSite(
        { ...DEFAULT_OPTIONS, startUrl: "http://site.example/", delayMs: 0, timeoutMs: 2000 },
        { fetchImpl: web.fetchImpl },
      );
      expect(ctx.probes.httpRedirectsToHttps).toBeNull();
      expect(web.seen.filter((s) => s === "GET http://site.example/")).toHaveLength(1);
    });

    test("the www counterpart redirecting to the audit origin is true", async () => {
      const ctx = await crawlFake({
        "https://www.site.example/": { status: 301, location: "https://site.example/" },
      });
      expect(ctx.probes.siblingHost).toBe("www.site.example");
      expect(ctx.probes.siblingHostRedirects).toBe(true);
    });

    test("the www counterpart answering 200 is false", async () => {
      const ctx = await crawlFake({ "https://www.site.example/": { body: home } });
      expect(ctx.probes.siblingHostRedirects).toBe(false);
    });

    test("the www counterpart failing, or redirecting elsewhere, gives null", async () => {
      const failing = await crawlFake({ "https://www.site.example/": "throw" });
      expect(failing.probes.siblingHost).toBe("www.site.example");
      expect(failing.probes.siblingHostRedirects).toBeNull();
      const elsewhere = await crawlFake({
        "https://www.site.example/": { status: 302, location: "https://elsewhere.example/" },
      });
      expect(elsewhere.probes.siblingHostRedirects).toBeNull();
      const missing = await crawlFake({ "https://www.site.example/": { status: 404 } });
      expect(missing.probes.siblingHostRedirects).toBeNull();
    });

    test("the apex counterpart is probed when the audit origin is www", async () => {
      const web = fakeWeb({
        "https://www.site.example/": { body: home },
        "https://site.example/": { status: 301, location: "https://www.site.example/" },
      });
      const ctx = await crawlSite(
        { ...DEFAULT_OPTIONS, startUrl: "https://www.site.example/", delayMs: 0, timeoutMs: 2000 },
        { fetchImpl: web.fetchImpl },
      );
      expect(ctx.probes.siblingHost).toBe("site.example");
      expect(ctx.probes.siblingHostRedirects).toBe(true);
    });

    test("the sibling probe is sent even without checkExternal, and only that one request goes there", async () => {
      const run = crawlFake({
        "https://www.site.example/": { status: 301, location: "https://site.example/" },
      });
      await run;
      expect(run.seen.filter((s) => s.includes("www.site.example"))).toEqual([
        "GET https://www.site.example/",
      ]);
    });
  });
});

describe("throttling and progress", () => {
  test("a host that keeps answering 429 raises the delay once and the context says so", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/a", "/b") }) },
      "/a": { status: 429, headers: { "retry-after": "0" }, body: "wait" },
      "/b": { status: 429, headers: { "retry-after": "0" }, body: "wait" },
    });
    const clock = instantClock();
    const ctx = await crawlSite(opts(site), { clock });
    expect(ctx.limits.delayRaised).toBe(true);
    expect(pageAt(ctx, site.url("/a")).status).toBe(429);
    expect(site.hits("/a")).toBe(3);
  });

  test("delayRaised stays false on a healthy site", async () => {
    const site = await start({ "/": { body: page() } });
    const ctx = await crawlSite(opts(site));
    expect(ctx.limits.delayRaised).toBe(false);
  });

  test("progress events report pages, assets, external links and notes", async () => {
    const other = await start({ "/x": { body: page() } });
    const site = await start({
      "/": {
        body: page({ body: `${linkTo("/a", other.url("/x"))}<img src="/i.png">` }),
      },
      "/a": { body: page() },
      "/i.png": { headers: { "content-type": "image/png" }, body: "i" },
    });
    const events: Parameters<NonNullable<CrawlDeps["onProgress"]>>[0][] = [];
    await crawlSite(opts(site, { checkExternal: true }), { onProgress: (e) => events.push(e) });
    const pageEvents = events.filter((e) => e.kind === "page");
    expect(pageEvents.map((e) => e.done)).toEqual([1, 2]);
    expect(events.filter((e) => e.kind === "asset")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "external")).toHaveLength(1);
    expect(events.every((e) => e.done >= 0)).toBe(true);
  });

  test("a robots.txt crawl-delay above the cap is clamped and noted", async () => {
    const site = await start({
      "/robots.txt": { headers: ROBOTS_TEXT, body: "User-agent: *\nCrawl-delay: 120\n" },
      "/": { body: page({ head: '<link rel="icon" href="data:,">' }) },
    });
    const events: string[] = [];
    const ctx = await crawlSite(opts(site), {
      clock: instantClock(),
      onProgress: (e) => {
        if (e.kind === "note" && e.message !== undefined) events.push(e.message);
      },
    });
    expect(ctx.robots.crawlDelay).toBe(30000);
    expect(events.some((m) => m.includes("Crawl-delay") && m.includes("30"))).toBe(true);
  });
});

describe("the context", () => {
  test("holds plain data only and survives a JSON round trip", async () => {
    const other = await start({ "/x": { body: page() } });
    const site = await start({
      "/": {
        body: page({
          head: '<link rel="stylesheet" href="/s.css">',
          body: `${linkTo("/a", other.url("/x"))}<img src="/i.png" alt="i">`,
        }),
      },
      "/a": { body: page() },
      "/s.css": { headers: { "content-type": "text/css" }, body: "a{}" },
      "/i.png": { headers: { "content-type": "image/png" }, body: "i" },
    });
    const ctx = await crawlSite(opts(site, { checkExternal: true }));
    const text = JSON.stringify(ctx);
    expect(JSON.parse(text)).toEqual(ctx);
    expect(ctx.options.startUrl).toBe(site.url("/"));
    expect(ctx.limits).toMatchObject({ maxPages: 50, maxDepth: 3, pagesCrawled: 2 });
  });

  test("every request carries the configured user agent and no cookie or authorisation header", async () => {
    const site = await start({
      "/": { body: page({ body: linkTo("/a") }) },
      "/a": { body: page() },
    });
    await crawlSite(opts(site, { userAgent: "audit-test/9" }));
    expect(site.log.length).toBeGreaterThan(3);
    for (const entry of site.log) {
      expect(entry.headers["user-agent"]).toBe("audit-test/9");
      expect(entry.headers.cookie).toBeUndefined();
      expect(entry.headers.authorization).toBeUndefined();
      expect(["GET", "HEAD"]).toContain(entry.method);
    }
    expect(paths(site)[0]).toBe("/robots.txt");
  });
});
