import * as cheerio from "cheerio";
import { describe, expect, test } from "vitest";
import { NOT_SEEN } from "../src/audit.js";
import { A11Y_NOTICE } from "../src/checks/accessibility.js";
import { getCheck } from "../src/checks/registry.js";
import { renderHtml } from "../src/report/html.js";
import { FIX_FIRST_NOTE, NO_FAILED_CHECKS } from "../src/report/scope.js";
import type { Finding, LighthouseSection } from "../src/types.js";
import { HOSTILE, UNSAFE, makeHostileResult, makeResult } from "./helpers/result.js";

function must<T>(item: T | undefined): T {
  if (item === undefined) throw new Error("Expected a value");
  return item;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`No item at index ${index}`);
  return item;
}

const lighthouse: LighthouseSection = {
  status: "ok",
  version: "13.0.0",
  note: "Lighthouse lab data, one run on this machine, mobile emulation. Results vary between runs.",
  pages: [
    {
      url: "https://site.example/",
      scores: { performance: 91.6, accessibility: 100, bestPractices: 95.2, seo: null },
      metrics: { fcpMs: 1234, lcpMs: 2550, tbtMs: 40, cls: 0.0512, speedIndexMs: null },
      error: null,
    },
  ],
};

describe("renderHtml hostile input", () => {
  test("hostile strings are inert", () => {
    const r = makeResult();
    at(r.checks, 0).findings[0] = {
      ...at(at(r.checks, 0).findings, 0),
      url: "javascript:alert(1)",
      detail: HOSTILE,
      evidence: [HOSTILE],
    }; // fixed result always has these entries
    const html = renderHtml(r);
    const $ = cheerio.load(html);
    expect($("script").length).toBe(0);
    expect($("a[href^='javascript:']").length).toBe(0);
    expect(html).not.toContain("<script>alert(1)</script>");
    // eslint-disable-next-line no-control-regex -- the pattern exists to find control characters
    expect(html).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202e]/);
  });

  test("hostile text in every place the site can reach stays inert", () => {
    const html = renderHtml(makeHostileResult());
    const $ = cheerio.load(html);
    expect($("script").length).toBe(0);
    expect($("a[href^='javascript:']").length).toBe(0);
    expect(html).not.toContain("<script>");
    expect(UNSAFE.test(html.replace(/\n/g, ""))).toBe(false);
    expect($("body *").filter((_, el) => el.tagName === "img").length).toBe(0);
    // The hostile text survives only as escaped text.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("a quote in a URL cannot break out of the href attribute", () => {
    const r = makeResult();
    at(r.checks, 0).findings[0] = {
      ...at(at(r.checks, 0).findings, 0),
      url: 'https://site.example/"onmouseover="alert(1)',
    };
    const $ = cheerio.load(renderHtml(r));
    expect($("[onmouseover]").length).toBe(0);
    for (const a of $("a[href]").toArray()) {
      expect($(a).attr("href")).toMatch(/^(https?:\/\/|#)/);
    }
  });
});

describe("renderHtml document", () => {
  const html = renderHtml(makeResult());
  const $ = cheerio.load(html);

  test("the document makes no external requests", () => {
    expect($("link, img, iframe, script, object, embed, video, audio, source").length).toBe(0);
    expect($("style").text()).not.toMatch(/url\(|@import/);
    expect($("meta[http-equiv='Content-Security-Policy']").attr("content")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
  });

  test("has the head the spec asks for", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect($("html").attr("lang")).toBe("en");
    expect($("meta[charset]").attr("charset")).toBe("utf-8");
    expect($("meta[name='viewport']").attr("content")).toContain("width=device-width");
    expect($("meta[name='robots']").attr("content")).toBe("noindex");
    expect($("title").text()).toBe("Site audit: https://site.example");
    expect($("style").length).toBe(1);
  });

  test("the CSS has a dark scheme and a print block and wraps long URLs", () => {
    const css = $("style").text();
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain("@media print");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("details > *:not(summary)");
    expect(css).toMatch(
      /@media print[\s\S]*details::details-content\s*{\s*content-visibility:\s*visible;\s*display:\s*block;\s*}/,
    );
    expect(css).toMatch(/:root\s*{[^}]*--accent:/);
  });

  test("sections appear in the stated order", () => {
    const ids = [
      "top",
      "scope",
      "summary",
      "fix-first",
      "findings",
      "group-seo",
      "group-health",
      "group-performance",
      "group-accessibility",
      "passed",
      "pages",
      "footer",
    ];
    const at = ids.map((id) => html.indexOf(`id="${id}"`));
    for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("the header names the site, the date and the tool version", () => {
    const header = $("#top").text();
    expect(header).toContain("https://site.example");
    expect(header).toContain("2026-10-04T10:00:00.000Z");
    expect(header).toContain("site-audit-cli 1.0.0");
  });

  test("the scope is a definition list with the fixed not-seen list", () => {
    const scope = $("#scope");
    expect(scope.find("dl dt").length).toBeGreaterThan(8);
    expect(scope.text()).toContain("Pages crawled");
    expect(scope.text()).toContain("3 (limit 50)");
    expect(scope.text()).toContain("Skipped by robots.txt");
    for (const line of NOT_SEEN) expect(scope.text()).toContain(line);
  });

  test("the summary is a table with a row per group, a total and the checks passed", () => {
    const rows = $("#summary table tbody tr")
      .toArray()
      .map((tr) =>
        $(tr)
          .find("th, td")
          .toArray()
          .map((c) => $(c).text().trim()),
      );
    expect(rows[0]).toEqual(["SEO", "12", "0", "0"]);
    expect(rows.at(-1)).toEqual(["Total", "12", "1", "1"]);
    expect($("#summary thead th").length).toBe(4);
    expect($("#summary").text()).toContain("Checks passed: 1 of 3");
  });

  test("fix first is an ordered list under the shared ordering sentence", () => {
    const section = $("#fix-first");
    expect(section.text()).toContain(FIX_FIRST_NOTE);
    const items = section.find("ol > li");
    expect(items.length).toBe(2);
    expect(items.eq(0).text()).toContain("Page has no title");
    expect(items.eq(0).text()).toContain("error");
    expect(items.eq(0).text()).toContain("12");
    expect(items.eq(1).text()).toContain("Images without width and height");
  });

  test("a result with nothing to fix says so", () => {
    const base = makeResult();
    const out = cheerio.load(renderHtml({ ...base, summary: { ...base.summary, fixFirst: [] } }));
    expect(out("#fix-first ol").length).toBe(0);
    expect(out("#fix-first").text()).toContain("No errors or warnings to fix first.");
  });

  test("every failed check is a details element and error checks are open", () => {
    const checks = $("details.check");
    expect(checks.length).toBe(2);
    expect($("#check-SEO-TITLE-001").is("details")).toBe(true);
    expect($("#check-SEO-TITLE-001").attr("open")).toBeDefined();
    expect($("#check-PERF-IMG-052").is("details")).toBe(true);
    expect($("#check-PERF-IMG-052").attr("open")).toBeUndefined();
  });

  test("a check summary has a severity label, the title and the finding count", () => {
    const summary = $("#check-SEO-TITLE-001 > summary");
    expect(summary.find(".sev").text()).toBe("error");
    expect(summary.text()).toContain("Page has no title");
    expect(summary.text()).toContain("12 findings");
    expect($("#check-PERF-IMG-052 > summary .sev").text()).toBe("warning");
  });

  test("a check shows why, fix and the heuristic from the registry", () => {
    for (const id of ["SEO-TITLE-001", "PERF-IMG-052"]) {
      const body = $(`#check-${id}`).text();
      const def = must(getCheck(id));
      expect(body).toContain(def.why);
      expect(body).toContain(def.fix);
      if (def.heuristic !== null) expect(body).toContain(def.heuristic);
    }
    expect($("#check-PERF-IMG-052").text()).toContain("Decorative images are counted too");
  });

  test("a finding with a lower severity than its check shows its own label", () => {
    const rows = $("#check-PERF-IMG-052 tbody tr");
    expect(rows.length).toBe(2);
    expect(rows.eq(0).find(".sev").length).toBe(0);
    expect(rows.eq(1).find(".sev").text()).toBe("info");
  });

  test("findings tables have URL, detail and evidence columns", () => {
    const heads = $("#check-SEO-TITLE-001 thead th")
      .toArray()
      .map((th) => $(th).text());
    expect(heads).toEqual(["Page", "Detail", "Evidence"]);
    expect($("#check-SEO-TITLE-001 tbody tr").eq(0).text()).toContain(
      "https://site.example/sitemap.xml",
    );
  });

  test("the 12-finding check shows all 12 and no 'more' line", () => {
    expect($("#check-SEO-TITLE-001 tbody tr").length).toBe(12);
    expect($("#check-SEO-TITLE-001").text()).not.toContain("see the JSON report");
  });

  test("tables sit inside a scrollable wrapper", () => {
    expect($("table").length).toBeGreaterThan(3);
    for (const table of $("table").toArray()) {
      expect($(table).parent().hasClass("table-wrap")).toBe(true);
    }
  });

  test("the accessibility notice is present once, in the accessibility group", () => {
    expect($("#group-accessibility").text()).toContain(A11Y_NOTICE);
    expect(html.split(A11Y_NOTICE).length - 1).toBe(1);
  });

  test("a group with no failed checks says so", () => {
    expect($("#group-health").text()).toContain(NO_FAILED_CHECKS);
  });

  test("passed and not-applicable checks are collapsed lists", () => {
    const lists = $("#passed details");
    expect(lists.length).toBe(2);
    for (const d of lists.toArray()) expect($(d).attr("open")).toBeUndefined();
    expect($("#passed").text()).toContain("A11Y-ALT-001");
    expect($("#passed").text()).toContain("HEALTH-FAV-040");
  });

  test("the pages table lists URL, status, response time and counts", () => {
    const heads = $("#pages thead th")
      .toArray()
      .map((th) => $(th).text());
    expect(heads).toEqual(["Page", "Status", "Response", "Errors", "Warnings", "Info"]);
    const rows = $("#pages tbody tr");
    expect(rows.length).toBe(3);
    expect(rows.eq(0).text()).toContain("https://site.example/");
    expect(rows.eq(0).text()).toContain("200");
    expect(rows.eq(0).text()).toContain("100 ms");
  });

  test("the footer names the tool and version", () => {
    expect($("#footer").text()).toContain("site-audit-cli 1.0.0");
  });

  test("links are http, https or in-page, and external ones carry the rel", () => {
    const links = $("a[href]").toArray();
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      const href = $(a).attr("href") ?? "";
      expect(href).toMatch(/^(https?:\/\/|#)/);
      if (!href.startsWith("#")) {
        expect($(a).attr("rel")).toBe("noopener noreferrer nofollow");
      }
    }
  });

  test("a finding without a page says whole site and is not a link", () => {
    const r = makeResult();
    at(r.checks, 1).findings[0] = { ...at(at(r.checks, 1).findings, 0), url: null };
    const out = cheerio.load(renderHtml(r));
    expect(out("#check-PERF-IMG-052 tbody tr").eq(0).find("td").eq(0).text()).toBe("(whole site)");
    expect(out("#check-PERF-IMG-052 tbody tr").eq(0).find("a").length).toBe(0);
  });

  test("the robots notice is shown when robots.txt was ignored", () => {
    const base = makeResult();
    const out = cheerio.load(renderHtml({ ...base, scope: { ...base.scope, ignoreRobots: true } }));
    expect(out("#scope .notice").text()).toContain("robots.txt was ignored for this run.");
    expect(cheerio.load(html)("#scope .notice").length).toBe(0);
  });
});

describe("renderHtml finding cap", () => {
  test("a check with 60 findings shows 50 rows and 'and 10 more'", () => {
    const base = makeResult();
    const template = at(at(base.checks, 0).findings, 0);
    const findings: Finding[] = Array.from({ length: 60 }, (_, i) => ({
      ...template,
      url: `https://site.example/p-${i}`,
      evidence: undefined,
    }));
    base.checks[0] = { ...at(base.checks, 0), findings };
    const $ = cheerio.load(renderHtml(base));
    expect($("#check-SEO-TITLE-001 tbody tr").length).toBe(50);
    expect($("#check-SEO-TITLE-001").text()).toContain("and 10 more, see the JSON report");
    expect($("#check-SEO-TITLE-001 > summary").text()).toContain("60 findings");
  });
});

describe("renderHtml lighthouse", () => {
  test("the section is absent when there is no Lighthouse result", () => {
    const $ = cheerio.load(renderHtml(makeResult()));
    expect($("#lighthouse").length).toBe(0);
  });

  test("the section carries the note, the version and formatted values", () => {
    const $ = cheerio.load(renderHtml(makeResult({ lighthouse })));
    const section = $("#lighthouse");
    expect(section.length).toBe(1);
    expect(section.text()).toContain(lighthouse.note);
    expect(section.text()).toContain("13.0.0");
    const cells = section
      .find("tbody tr")
      .eq(0)
      .find("td")
      .toArray()
      .map((c) => $(c).text().trim());
    expect(cells).toEqual([
      "https://site.example/",
      "92",
      "100",
      "95",
      "not available",
      "1.2 s",
      "2.6 s",
      "0.0 s",
      "0.05",
      "not available",
    ]);
  });

  test("sits between the pages table and the footer", () => {
    const html = renderHtml(makeResult({ lighthouse }));
    const at = ['id="pages"', 'id="lighthouse"', 'id="footer"'].map((s) => html.indexOf(s));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(at[0]).toBeGreaterThanOrEqual(0);
  });

  test("a page error is shown", () => {
    const $ = cheerio.load(
      renderHtml(
        makeResult({
          lighthouse: {
            ...lighthouse,
            status: "failed",
            pages: [{ ...at(lighthouse.pages, 0), error: "Lighthouse timed out." }],
          },
        }),
      ),
    );
    expect($("#lighthouse").text()).toContain("Lighthouse timed out.");
  });
});
