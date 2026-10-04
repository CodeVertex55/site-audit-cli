import { describe, expect, test } from "vitest";
import { runChecks } from "../src/checks/registry.js";
import type { PageRecord, SiteContext } from "../src/types.js";
import { makeContext, makePage } from "./helpers/context.js";

const SITE = "https://site.example";

function ids(ctx: SiteContext): string[] {
  return runChecks(ctx, ["health"])
    .filter((c) => c.status === "fail")
    .map((c) => c.id);
}

function only(id: string, ctx: SiteContext) {
  const outcome = runChecks(ctx, ["health"]).find((c) => c.id === id);
  if (outcome === undefined) throw new Error(`no check ${id} in the registry`);
  return outcome;
}

function at(path: string, over: Parameters<typeof makePage>[0] = {}): PageRecord {
  return makePage({ url: `${SITE}${path}`, finalUrl: `${SITE}${path}`, ...over });
}

function withHeaders(headers: Record<string, string>, extra: PageRecord[] = []): SiteContext {
  const start = makePage({ headers: { "content-type": "text/html", ...headers } });
  return makeContext({ pages: [start, ...extra] });
}

function bare(path: string, headers: Record<string, string> = {}): PageRecord {
  return at(path, { headers: { "content-type": "text/html", ...headers } });
}

describe("link and redirect checks", () => {
  test("HEALTH-LINK-001 names the broken target and its sources", () => {
    const home = makePage({ url: "https://site.example/" });
    const dead = makePage({
      url: "https://site.example/old",
      status: 404,
      doc: null,
      inlinks: [home.url],
    });
    const out = only("HEALTH-LINK-001", makeContext({ pages: [home, dead] }));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ url: dead.url, evidence: [home.url] });
    expect(out.findings[0]?.detail).toContain("404");
  });

  test("HEALTH-LINK-001 covers 5xx and load failures, caps evidence at five sources", () => {
    const sources = Array.from({ length: 7 }, (_, i) => `${SITE}/from-${i}`);
    const boom = at("/boom", { status: 500, doc: null, inlinks: sources });
    const slow = at("/slow", {
      status: null,
      failure: "timeout",
      doc: null,
      inlinks: [`${SITE}/`],
    });
    const out = only("HEALTH-LINK-001", makeContext({ pages: [makePage(), boom, slow] }));
    expect(out.findings.map((f) => f.url)).toEqual([boom.url, slow.url]);
    expect(out.findings[0]?.evidence).toHaveLength(5);
    expect(out.findings[0]?.detail).toContain("500");
    expect(out.findings[1]?.detail).toContain("timeout");
  });

  test("HEALTH-LINK-001 ignores unlinked errors, healthy pages and robots-blocked pages", () => {
    const orphan404 = at("/orphan", { status: 404, doc: null, inlinks: [] });
    const blocked = at("/private", {
      status: null,
      failure: "blocked-by-robots",
      doc: null,
      inlinks: [`${SITE}/`],
    });
    const healthy = at("/ok", { inlinks: [`${SITE}/`] });
    const ctx = makeContext({ pages: [makePage(), orphan404, blocked, healthy] });
    expect(only("HEALTH-LINK-001", ctx).status).toBe("pass");
  });

  test("HEALTH-LINK-002 reports linked redirects with the final target", () => {
    const moved = at("/old", {
      finalUrl: `${SITE}/new`,
      status: 200,
      hops: [{ url: `${SITE}/old`, status: 301, location: `${SITE}/new` }],
      doc: null,
      inlinks: [`${SITE}/`],
    });
    const out = only("HEALTH-LINK-002", makeContext({ pages: [makePage(), moved] }));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ url: moved.url, evidence: [`${SITE}/`] });
    expect(out.findings[0]?.detail).toBe(`Redirects to ${SITE}/new`);
  });

  test("HEALTH-LINK-002 ignores unlinked redirects and redirects that end in an error", () => {
    const unlinked = at("/a", {
      finalUrl: `${SITE}/b`,
      hops: [{ url: `${SITE}/a`, status: 301, location: `${SITE}/b` }],
      doc: null,
      inlinks: [],
    });
    const toMissing = at("/c", {
      finalUrl: `${SITE}/d`,
      status: 404,
      hops: [{ url: `${SITE}/c`, status: 301, location: `${SITE}/d` }],
      doc: null,
      inlinks: [`${SITE}/`],
    });
    const ctx = makeContext({ pages: [makePage(), unlinked, toMissing] });
    expect(only("HEALTH-LINK-002", ctx).status).toBe("pass");
    expect(ids(ctx)).toContain("HEALTH-LINK-001");
  });

  test("HEALTH-REDIR-010 fires on two hops and not on one", () => {
    const hop = (from: string, to: string) => ({ url: from, status: 301, location: to });
    const chain = at("/a", {
      finalUrl: `${SITE}/c`,
      hops: [hop(`${SITE}/a`, `${SITE}/b`), hop(`${SITE}/b`, `${SITE}/c`)],
      doc: null,
    });
    const single = at("/x", {
      finalUrl: `${SITE}/y`,
      hops: [hop(`${SITE}/x`, `${SITE}/y`)],
      doc: null,
    });
    const out = only("HEALTH-REDIR-010", makeContext({ pages: [makePage(), chain, single] }));
    expect(out.findings.map((f) => f.url)).toEqual([chain.url]);
    expect(out.findings[0]?.detail).toContain("2 hops");
    expect(out.findings[0]?.detail).toContain(`${SITE}/c`);
  });

  test("HEALTH-REDIR-011 fires on a loop or too many redirects, not on a long working chain", () => {
    const looped = at("/loop", { status: null, failure: "redirect-loop", doc: null });
    const endless = at("/endless", { status: null, failure: "too-many-redirects", doc: null });
    const out = only("HEALTH-REDIR-011", makeContext({ pages: [makePage(), looped, endless] }));
    expect(out.findings.map((f) => f.url)).toEqual([looped.url, endless.url]);
    const fine = at("/fine", { failure: null });
    expect(only("HEALTH-REDIR-011", makeContext({ pages: [makePage(), fine] })).status).toBe(
      "pass",
    );
  });

  test("redirect and link checks run when no HTML page loaded, but not with no pages", () => {
    const looped = at("/", { status: null, failure: "redirect-loop", doc: null, isHtml: false });
    expect(only("HEALTH-REDIR-011", makeContext({ pages: [looped] })).status).toBe("fail");
    for (const id of [
      "HEALTH-LINK-001",
      "HEALTH-LINK-002",
      "HEALTH-REDIR-010",
      "HEALTH-FETCH-070",
    ]) {
      expect(only(id, makeContext({ pages: [] })).status, id).toBe("not-applicable");
    }
  });
});

describe("https checks", () => {
  test("HEALTH-HTTPS-020 fires on a plain HTTP origin and passes on HTTPS", () => {
    const base = makeContext();
    const http: SiteContext = {
      ...base,
      origin: "http://site.example",
      probes: { ...base.probes, httpRedirectsToHttps: null },
    };
    const out = only("HEALTH-HTTPS-020", http);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      url: null,
      detail: "The site is served over plain HTTP.",
    });
    expect(only("HEALTH-HTTPS-020", base).status).toBe("pass");
  });

  test("HEALTH-HTTPS-020 fires when the HTTP origin does not redirect, and null is no finding", () => {
    const base = makeContext();
    const noRedirect: SiteContext = {
      ...base,
      probes: { ...base.probes, httpRedirectsToHttps: false },
    };
    const out = only("HEALTH-HTTPS-020", noRedirect);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toContain("does not redirect to HTTPS");
    const unknown: SiteContext = {
      ...base,
      probes: { ...base.probes, httpRedirectsToHttps: null },
    };
    expect(only("HEALTH-HTTPS-020", unknown).status).toBe("pass");
  });

  test("HEALTH-HTTPS-020 still applies when no page loaded", () => {
    const base = makeContext({ pages: [] });
    const ctx: SiteContext = {
      ...base,
      probes: { ...base.probes, httpRedirectsToHttps: false },
    };
    expect(only("HEALTH-HTTPS-020", ctx).status).toBe("fail");
  });

  test("HEALTH-HTTPS-021 lists mixed content with evidence and passes when empty", () => {
    const urls = Array.from({ length: 7 }, (_, i) => `http://cdn.example/${i}.js`);
    const out = only(
      "HEALTH-HTTPS-021",
      makeContext({ pages: [makePage({ doc: { mixedContent: urls } })] }),
    );
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ url: `${SITE}/`, evidence: urls.slice(0, 5) });
    expect(out.findings[0]?.detail).toContain("7");
    expect(only("HEALTH-HTTPS-021", makeContext()).status).toBe("pass");
  });

  test("HEALTH-HTTPS-022 fires on an http link to the same host from an https page", () => {
    const link = (url: string, internal: boolean) => ({
      href: url,
      url,
      text: "link",
      internal,
      rel: [],
      hasAccessibleName: true,
    });
    const page = makePage({
      doc: {
        links: [
          link("http://site.example/about", false),
          link("http://site.example/team", false),
          link("http://other.example/page", false),
          link("https://site.example/ok", true),
        ],
      },
    });
    const out = only("HEALTH-HTTPS-022", makeContext({ pages: [page] }));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.evidence).toEqual([
      "http://site.example/about",
      "http://site.example/team",
    ]);
    expect(out.findings[0]?.detail).toContain("2");
  });

  test("HEALTH-HTTPS-022 passes for external http links and for plain HTTP pages", () => {
    const external = makePage({
      doc: {
        links: [
          {
            href: "http://other.example/",
            url: "http://other.example/",
            text: "x",
            internal: false,
            rel: [],
            hasAccessibleName: true,
          },
        ],
      },
    });
    expect(only("HEALTH-HTTPS-022", makeContext({ pages: [external] })).status).toBe("pass");
    const httpPage = makePage({
      url: "http://site.example/",
      finalUrl: "http://site.example/",
      doc: {
        links: [
          {
            href: "http://site.example/a",
            url: "http://site.example/a",
            text: "x",
            internal: true,
            rel: [],
            hasAccessibleName: true,
          },
        ],
      },
    });
    const base = makeContext({ pages: [httpPage] });
    const ctx: SiteContext = { ...base, origin: "http://site.example" };
    expect(only("HEALTH-HTTPS-022", ctx).status).toBe("pass");
  });
});

describe("host, 404 and favicon checks", () => {
  test("HEALTH-HOST-023 fires on false, passes on true and is not applicable without a sibling", () => {
    const base = makeContext();
    const bad: SiteContext = { ...base, probes: { ...base.probes, siblingHostRedirects: false } };
    const out = only("HEALTH-HOST-023", bad);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.url).toBeNull();
    expect(out.findings[0]?.detail).toContain("www.site.example");
    expect(only("HEALTH-HOST-023", base).status).toBe("pass");
    const none: SiteContext = {
      ...base,
      probes: { ...base.probes, siblingHost: null, siblingHostRedirects: null },
    };
    expect(only("HEALTH-HOST-023", none).status).toBe("not-applicable");
  });

  test("HEALTH-HOST-023 does not fire when the probe result is unknown", () => {
    const base = makeContext();
    const unknown: SiteContext = {
      ...base,
      probes: { ...base.probes, siblingHostRedirects: null },
    };
    expect(only("HEALTH-HOST-023", unknown).status).toBe("pass");
  });

  test("HEALTH-404-030 fires only on a soft 404", () => {
    const base = makeContext();
    const soft: SiteContext = { ...base, probes: { ...base.probes, soft404: true } };
    expect(only("HEALTH-404-030", soft).findings).toHaveLength(1);
    expect(only("HEALTH-404-030", base).status).toBe("pass");
    const unknown: SiteContext = { ...base, probes: { ...base.probes, soft404: null } };
    expect(only("HEALTH-404-030", unknown).findings).toEqual([]);
  });

  test("HEALTH-FAV-040 fires only when no favicon was found", () => {
    const base = makeContext();
    const missing: SiteContext = { ...base, probes: { ...base.probes, favicon: false } };
    expect(only("HEALTH-FAV-040", missing).findings).toHaveLength(1);
    expect(only("HEALTH-FAV-040", base).status).toBe("pass");
    const unknown: SiteContext = { ...base, probes: { ...base.probes, favicon: null } };
    expect(only("HEALTH-FAV-040", unknown).findings).toEqual([]);
  });
});

describe("security header checks", () => {
  test("a start page with every header passes all five", () => {
    const got = ids(makeContext());
    for (const id of [
      "HEALTH-HDR-050",
      "HEALTH-HDR-051",
      "HEALTH-HDR-052",
      "HEALTH-HDR-053",
      "HEALTH-HDR-054",
    ]) {
      expect(got, id).not.toContain(id);
    }
  });

  test("HEALTH-HDR-050 fires without Strict-Transport-Security and counts other pages", () => {
    const ctx = withHeaders({}, [
      bare("/a"),
      bare("/b"),
      bare("/c", { "strict-transport-security": "max-age=100" }),
    ]);
    const out = only("HEALTH-HDR-050", ctx);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.url).toBeNull();
    expect(out.findings[0]?.detail).toContain("2 other pages also lack it");
  });

  test("HEALTH-HDR-050 says one other page in the singular", () => {
    const out = only("HEALTH-HDR-050", withHeaders({}, [bare("/a")]));
    expect(out.findings[0]?.detail).toContain("1 other page also lacks it");
    const alone = only("HEALTH-HDR-050", withHeaders({}));
    expect(alone.findings[0]?.detail).toContain("0 other pages also lack it");
  });

  test("HEALTH-HDR-050 is not applicable on an HTTP origin, the others still run", () => {
    const start = makePage({
      url: "http://site.example/",
      finalUrl: "http://site.example/",
      headers: { "content-type": "text/html" },
    });
    const base = makeContext({ pages: [start], startUrl: start.url });
    const http: SiteContext = { ...base, origin: "http://site.example" };
    const outcomes = runChecks(http, ["health"]);
    const byId = (id: string) => outcomes.find((o) => o.id === id);
    expect(byId("HEALTH-HDR-050")?.status).toBe("not-applicable");
    for (const id of ["HEALTH-HDR-051", "HEALTH-HDR-052", "HEALTH-HDR-053", "HEALTH-HDR-054"]) {
      expect(byId(id)?.status, id).toBe("fail");
    }
  });

  test("HEALTH-HDR-051 fires without a Content-Security-Policy", () => {
    const out = only("HEALTH-HDR-051", withHeaders({}, [bare("/a")]));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toContain("1 other page also lacks it");
    const ok = withHeaders({ "content-security-policy": "default-src 'self'" });
    expect(only("HEALTH-HDR-051", ok).status).toBe("pass");
  });

  test("HEALTH-HDR-052 needs nosniff, ignoring case", () => {
    expect(only("HEALTH-HDR-052", withHeaders({})).findings).toHaveLength(1);
    expect(
      only("HEALTH-HDR-052", withHeaders({ "x-content-type-options": "other" })).findings,
    ).toHaveLength(1);
    expect(
      only("HEALTH-HDR-052", withHeaders({ "x-content-type-options": "NoSniff" })).status,
    ).toBe("pass");
  });

  test("HEALTH-HDR-053 fires without a Referrer-Policy", () => {
    expect(only("HEALTH-HDR-053", withHeaders({})).findings).toHaveLength(1);
    expect(only("HEALTH-HDR-053", withHeaders({ "referrer-policy": "no-referrer" })).status).toBe(
      "pass",
    );
  });

  test("HEALTH-HDR-054 passes with X-Frame-Options or CSP frame-ancestors, fails with neither", () => {
    expect(only("HEALTH-HDR-054", withHeaders({})).findings).toHaveLength(1);
    expect(
      only("HEALTH-HDR-054", withHeaders({ "content-security-policy": "default-src 'self'" }))
        .findings,
    ).toHaveLength(1);
    expect(only("HEALTH-HDR-054", withHeaders({ "x-frame-options": "DENY" })).status).toBe("pass");
    expect(
      only(
        "HEALTH-HDR-054",
        withHeaders({ "content-security-policy": "default-src 'self'; Frame-Ancestors 'none'" }),
      ).status,
    ).toBe("pass");
  });

  test("header checks read the start page only, found by its final URL", () => {
    const landed = at("/home", { headers: { "content-type": "text/html" } });
    const redirect = makePage({
      url: `${SITE}/`,
      finalUrl: `${SITE}/home`,
      status: 301,
      hops: [{ url: `${SITE}/`, status: 301, location: `${SITE}/home` }],
      doc: null,
    });
    const ctx = makeContext({ pages: [redirect, landed], startUrl: `${SITE}/home` });
    expect(only("HEALTH-HDR-051", ctx).findings).toHaveLength(1);
  });

  test("header checks are not applicable when the start page did not load as HTML", () => {
    const failed = makePage({ status: 500, doc: null, isHtml: false });
    const ctx = makeContext({ pages: [failed] });
    for (const id of [
      "HEALTH-HDR-050",
      "HEALTH-HDR-051",
      "HEALTH-HDR-052",
      "HEALTH-HDR-053",
      "HEALTH-HDR-054",
    ]) {
      expect(only(id, ctx).status, id).toBe("not-applicable");
    }
  });
});

describe("external link and fetch checks", () => {
  test("HEALTH-EXT-060 is not applicable without external checks and softens refusals", () => {
    expect(only("HEALTH-EXT-060", makeContext()).status).toBe("not-applicable");
    const ctx = makeContext({
      external: [
        {
          url: "https://a.example/",
          status: 404,
          failure: null,
          usedBy: ["https://site.example/"],
        },
        {
          url: "https://b.example/",
          status: 403,
          failure: null,
          usedBy: ["https://site.example/"],
        },
        {
          url: "https://c.example/",
          status: 200,
          failure: null,
          usedBy: ["https://site.example/"],
        },
      ],
    });
    const f = only("HEALTH-EXT-060", ctx).findings;
    expect(f.map((x) => [x.url, x.severity])).toEqual([
      ["https://a.example/", "warning"],
      ["https://b.example/", "info"],
    ]);
  });

  test("HEALTH-EXT-060 treats 401, 405, 429 and 503 as could not verify", () => {
    const used = [`${SITE}/`];
    const ctx = makeContext({
      external: [401, 405, 429, 503, 500, 410].map((status) => ({
        url: `https://x.example/${status}`,
        status,
        failure: null,
        usedBy: used,
      })),
    });
    const f = only("HEALTH-EXT-060", ctx).findings;
    expect(f.map((x) => x.severity)).toEqual([
      "info",
      "info",
      "info",
      "info",
      "warning",
      "warning",
    ]);
    expect(f[0]?.detail).toBe(
      "Could not verify (status 401). Many sites refuse automated requests.",
    );
    expect(f[4]?.detail).toContain("500");
    expect(f[0]?.evidence).toEqual(used);
  });

  test("HEALTH-EXT-060 reports failures as warnings and keeps the check severity", () => {
    const ctx = makeContext({
      external: [
        { url: "https://gone.example/", status: null, failure: "dns", usedBy: [`${SITE}/`] },
      ],
    });
    const out = only("HEALTH-EXT-060", ctx);
    expect(out.severity).toBe("warning");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ severity: "warning", checkId: "HEALTH-EXT-060" });
    expect(out.findings[0]?.detail).toContain("dns");
  });

  test("HEALTH-EXT-060 passes when every external link is fine", () => {
    const ctx = makeContext({
      external: [{ url: "https://ok.example/", status: 200, failure: null, usedBy: [`${SITE}/`] }],
    });
    expect(only("HEALTH-EXT-060", ctx).status).toBe("pass");
  });

  test("HEALTH-FETCH-070 fires on a timeout or a truncated body", () => {
    const timedOut = at("/slow", { status: null, failure: "timeout", doc: null, isHtml: false });
    const cut = at("/big", { truncated: true });
    const out = only("HEALTH-FETCH-070", makeContext({ pages: [makePage(), timedOut, cut] }));
    expect(out.findings.map((f) => f.url)).toEqual([timedOut.url, cut.url]);
    expect(out.findings[0]?.detail).toContain("timed out");
    expect(out.findings[1]?.detail).toContain("truncated");
  });

  test("HEALTH-FETCH-070 ignores other failures and robots-blocked pages", () => {
    const dns = at("/dns", { status: null, failure: "dns", doc: null, isHtml: false });
    const blocked = at("/no", {
      status: null,
      failure: "blocked-by-robots",
      doc: null,
      isHtml: false,
    });
    expect(
      only("HEALTH-FETCH-070", makeContext({ pages: [makePage(), dns, blocked] })).status,
    ).toBe("pass");
  });
});
