import { describe, expect, test } from "vitest";
import { finding, findPage, htmlPages, indexablePages, isNoindex } from "../src/checks/helpers.js";
import { CHECKS, getCheck, runChecks } from "../src/checks/registry.js";
import { GROUPS } from "../src/types.js";
import { makeContext, makePage } from "./helpers/context.js";

describe("registry", () => {
  test("ids are unique and well formed", () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^(SEO|HEALTH|PERF|A11Y)-[A-Z0-9]+-\d{3}$/);
  });

  test("every check has title, why and fix text", () => {
    for (const c of CHECKS) {
      expect(c.title.trim(), c.id).not.toBe("");
      expect(c.why.trim(), c.id).not.toBe("");
      expect(c.fix.trim(), c.id).not.toBe("");
    }
  });

  test("no text field contains an em dash, an en dash or an exclamation mark", () => {
    const banned = /[\u2013\u2014!]/;
    for (const c of CHECKS) {
      for (const text of [c.title, c.why, c.fix, c.heuristic ?? ""]) {
        expect(banned.test(text), `${c.id}: ${text}`).toBe(false);
      }
    }
  });

  test("a check that uses a threshold explains it", () => {
    for (const id of ["SEO-TITLE-002", "SEO-DESC-011", "SEO-THIN-100", "SEO-MAP-094"]) {
      expect(getCheck(id)?.heuristic, id).toBeTruthy();
    }
  });

  test("id prefix matches the group", () => {
    const prefix = { seo: "SEO", health: "HEALTH", performance: "PERF", accessibility: "A11Y" };
    for (const c of CHECKS) expect(c.id.startsWith(`${prefix[c.group]}-`), c.id).toBe(true);
  });

  test("getCheck finds a check by id and returns undefined for an unknown id", () => {
    expect(getCheck("SEO-TITLE-001")?.group).toBe("seo");
    expect(getCheck("SEO-NOPE-999")).toBeUndefined();
  });

  test("a clean context with one clean page yields zero findings from every check", () => {
    const outcomes = runChecks(makeContext(), GROUPS);
    expect(outcomes).toHaveLength(CHECKS.length);
    expect(outcomes.flatMap((o) => o.findings)).toEqual([]);
    expect(outcomes.filter((o) => o.status === "fail")).toEqual([]);
  });

  test("a clean context passes the page-level checks rather than skipping them", () => {
    const outcome = runChecks(makeContext(), ["seo"]).find((o) => o.id === "SEO-TITLE-001");
    expect(outcome?.status).toBe("pass");
  });

  test("page-level checks are not-applicable when no HTML page loaded", () => {
    const none = runChecks(makeContext({ pages: [] }), GROUPS);
    const pageLevel = CHECKS.filter((c) => c.scope === "page" && c.applies === undefined);
    expect(pageLevel.length).toBeGreaterThan(0);
    for (const c of pageLevel) {
      expect(none.find((o) => o.id === c.id)?.status, c.id).toBe("not-applicable");
    }
    const notFound = makePage({ status: 404, doc: null, isHtml: false });
    const onlyError = runChecks(makeContext({ pages: [notFound] }), ["seo"]);
    expect(onlyError.find((o) => o.id === "SEO-TITLE-001")?.status).toBe("not-applicable");
  });

  test("site-level checks still run when no HTML page loaded", () => {
    const base = makeContext({ pages: [] });
    const ctx = { ...base, sitemap: { ...base.sitemap, found: false, files: [] } };
    const outcome = runChecks(ctx, ["seo"]).find((o) => o.id === "SEO-MAP-090");
    expect(outcome?.status).toBe("fail");
  });

  test("filtering by group returns only that group", () => {
    const ctx = makeContext();
    const seo = runChecks(ctx, ["seo"]);
    expect(seo.length).toBeGreaterThan(0);
    expect(seo.every((o) => o.group === "seo")).toBe(true);
    expect(runChecks(ctx, [])).toEqual([]);
    expect(runChecks(ctx, ["health"]).every((o) => o.group === "health")).toBe(true);
  });

  test("outcomes carry the check text and severity", () => {
    const outcome = runChecks(makeContext(), ["seo"]).find((o) => o.id === "SEO-VIEW-051");
    const def = getCheck("SEO-VIEW-051");
    expect(outcome).toMatchObject({
      severity: "error",
      group: "seo",
      title: def?.title,
      why: def?.why,
      fix: def?.fix,
    });
  });
});

describe("check helpers", () => {
  test("htmlPages keeps 200 parsed HTML pages on the audit origin", () => {
    const good = makePage();
    const redirectSource = makePage({
      url: "https://site.example/old",
      status: 301,
      hops: [{ url: "https://site.example/old", status: 301, location: "https://site.example/" }],
      doc: null,
    });
    const missing = makePage({ url: "https://site.example/gone", status: 404, doc: null });
    const asset = makePage({ url: "https://site.example/a.pdf", isHtml: false, doc: null });
    const elsewhere = makePage({
      url: "https://site.example/away",
      finalUrl: "https://other.example/away",
    });
    const ctx = makeContext({ pages: [good, redirectSource, missing, asset, elsewhere] });
    expect(htmlPages(ctx)).toEqual([good]);
  });

  test("indexablePages drops noindex and none, isNoindex reads the same directives", () => {
    const a = makePage({ url: "https://site.example/a" });
    const b = makePage({ url: "https://site.example/b", doc: { metaRobots: ["noindex"] } });
    const c = makePage({ url: "https://site.example/c", doc: { metaRobots: ["none"] } });
    const d = makePage({ url: "https://site.example/d", doc: { metaRobots: ["nofollow"] } });
    const ctx = makeContext({ pages: [a, b, c, d] });
    expect(indexablePages(ctx).map((p) => p.url)).toEqual([a.url, d.url]);
    expect([a, b, c, d].map(isNoindex)).toEqual([false, true, true, false]);
    expect(isNoindex(makePage({ doc: null }))).toBe(false);
  });

  test("findPage matches the requested URL, not a final URL", () => {
    const moved = makePage({
      url: "https://site.example/old",
      finalUrl: "https://site.example/new",
      status: 301,
      doc: null,
    });
    const ctx = makeContext({ pages: [makePage(), moved] });
    expect(findPage(ctx, "https://site.example/old")).toBe(moved);
    expect(findPage(ctx, "https://site.example/new")).toBeUndefined();
    expect(findPage(ctx, "https://site.example/#top")).toBe(ctx.pages[0]);
  });

  test("finding carries the check identity and caps the detail at 200 characters", () => {
    const f = finding({ id: "SEO-X-001", group: "seo", severity: "info" }, null, "x".repeat(500));
    expect(f).toMatchObject({ checkId: "SEO-X-001", group: "seo", severity: "info", url: null });
    expect(f.detail.length).toBe(200);
    expect(f.detail.endsWith("...")).toBe(true);
    expect(f.evidence).toBeUndefined();
  });

  test("finding strips control and bidirectional characters and collapses whitespace", () => {
    const hostile = "a\u001b[31m  b\u202ec\n\td\u0007";
    const f = finding({ id: "SEO-X-001", group: "seo", severity: "info" }, null, hostile);
    expect(f.detail).toBe("a[31m bc d");
  });

  test("finding keeps five evidence items and caps each in the middle", () => {
    const items = Array.from({ length: 8 }, (_, i) => `https://site.example/${i}`);
    items[0] = `https://site.example/${"p".repeat(600)}`;
    const f = finding({ id: "SEO-X-001", group: "seo", severity: "info" }, "u", "d", items);
    expect(f.evidence).toHaveLength(5);
    expect(f.evidence?.[0]?.length).toBe(300);
    expect(f.evidence?.[0]).toContain("...");
    expect(f.evidence?.[1]).toBe("https://site.example/1");
  });
});
