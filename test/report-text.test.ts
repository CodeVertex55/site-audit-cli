import { describe, expect, test } from "vitest";
import { NOT_SEEN } from "../src/audit.js";
import { A11Y_NOTICE } from "../src/checks/accessibility.js";
import { renderText } from "../src/report/text.js";
import { durationText, scopeLines } from "../src/report/scope.js";
import type { LighthouseSection } from "../src/types.js";
import { SGR, UNSAFE, makeHostileResult, makeResult } from "./helpers/result.js";

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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

describe("renderText structure", () => {
  const out = renderText(makeResult());

  test("opens with the header line and then the scope block", () => {
    expect(out.startsWith("Site audit: https://site.example\n")).toBe(true);
    expect(out.indexOf("Scope")).toBeGreaterThan(0);
    expect(out).toContain("site-audit-cli 1.0.0");
    expect(out).toContain("https://site.example/");
  });

  test("scope lists pages, uncrawled, robots-blocked and what the audit does not see", () => {
    expect(out).toMatch(/Pages crawled:\s+3 \(limit 50\)/);
    expect(out).toMatch(/Left uncrawled:\s+4/);
    expect(out).toMatch(/Skipped by robots\.txt:\s+2/);
    expect(out).toMatch(/Assets not measured:\s+6/);
    expect(out).toMatch(/Duration:\s+12\.3 seconds/);
    for (const line of NOT_SEEN) expect(out).toContain(line);
  });

  test("sections come in the specified order", () => {
    const order = [
      "Site audit:",
      "Scope",
      "Summary",
      "Fix first",
      "Ordered by severity, then by number of affected pages.",
      "SEO",
      "Performance",
      "Accessibility",
      "1 passed",
      "site-audit-cli 1.0.0",
    ].map((s) => out.lastIndexOf(s));
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the summary table has a row per group and a total", () => {
    expect(out).toMatch(/SEO\s+12\s+0\s+0/);
    expect(out).toMatch(/Performance\s+0\s+1\s+1/);
    expect(out).toMatch(/Total\s+12\s+1\s+1/);
  });

  test("fix first lists the failed checks in order with their fix", () => {
    const fix = out.slice(out.indexOf("Fix first"), out.indexOf("\nSEO\n"));
    expect(fix.indexOf("Page has no title")).toBeGreaterThan(-1);
    expect(fix.indexOf("Page has no title")).toBeLessThan(fix.indexOf("Images without width"));
    expect(fix).toContain("Add a unique <title>");
  });

  test("a failed check shows title, id, severity, why, fix, heuristic and findings", () => {
    expect(out).toContain("Images without width and height (PERF-IMG-052)");
    expect(out).toContain("Why:");
    expect(out).toContain("Fix:");
    expect(out).toContain("Heuristic: Decorative images are counted too");
    expect(out).toContain("https://site.example/contact: 2 images have no width and height.");
  });

  test("a finding with a lower severity than its check shows its own severity", () => {
    expect(out).toContain("[info] https://site.example/about: 1 image has no width and height.");
    expect(out).not.toContain("[warning] ");
  });

  test("evidence is listed under its finding", () => {
    expect(out).toContain("Evidence: https://site.example/sitemap.xml");
  });

  test("shows the first 10 findings and then 'and 2 more'", () => {
    expect(out).toContain("and 2 more");
    expect(count(out, "No <title> element, or it is empty.")).toBe(10);
    expect(out).not.toContain("and 1 more");
  });

  test("ends with passed and not-applicable counts and the footer", () => {
    expect(out).toContain("1 passed, 1 not applicable");
    expect(out.trimEnd().split("\n").at(-1)).toBe("site-audit-cli 1.0.0");
    expect(out.endsWith("\n")).toBe(true);
  });

  test("fix first states the full ordering and exclusion rule", () => {
    expect(out).toContain(
      "Ordered by severity, then by number of affected pages. Info findings are not counted, and checks whose findings are all info are left out.",
    );
  });

  test("states when there are no errors or warnings to fix first", () => {
    const result = makeResult();
    const out2 = renderText({ ...result, summary: { ...result.summary, fixFirst: [] } });
    expect(out2).toContain("No errors or warnings to fix first.");
  });

  test("states when a group has no failed checks", () => {
    expect(out.slice(out.indexOf("Accessibility\n"))).toContain("No failed checks.");
  });
});

describe("renderText accessibility notice", () => {
  test("appears exactly once when the accessibility group ran, above that group's checks", () => {
    const out = renderText(makeResult());
    expect(count(out, A11Y_NOTICE)).toBe(1);
    const heading = out.lastIndexOf("Accessibility\n");
    expect(out.indexOf(A11Y_NOTICE)).toBeGreaterThan(heading);
  });

  test("is absent when the accessibility group did not run", () => {
    const base = makeResult();
    const out = renderText({
      ...base,
      scope: { ...base.scope, groups: ["seo", "health"] },
      checks: base.checks.filter((c) => c.group !== "accessibility" && c.group !== "performance"),
    });
    expect(count(out, A11Y_NOTICE)).toBe(0);
    expect(out).not.toContain("Accessibility\n");
  });
});

describe("renderText scope variants", () => {
  test("ignoreRobots prints the notice as the first scope line, with an upper-case label", () => {
    const base = makeResult();
    const out = renderText({ ...base, scope: { ...base.scope, ignoreRobots: true } });
    expect(out).toMatch(/NOTICE:\s+robots\.txt was ignored for this run\./);
    expect(out.indexOf("NOTICE")).toBeLessThan(out.indexOf("Tool:"));
    expect(renderText(makeResult())).not.toContain("robots.txt was ignored");
  });

  test("prints the redirect note and a raised delay when there are any", () => {
    const base = makeResult();
    const out = renderText({
      ...base,
      scope: {
        ...base.scope,
        startUrl: "http://site.example/",
        originNote: "http://site.example/ redirected to https://site.example/.",
        delayRaised: true,
        checkExternal: true,
      },
    });
    expect(out).toContain("redirected to https://site.example/.");
    expect(out).toMatch(/Delay raised:\s+yes/);
    expect(out).toMatch(/External links checked:\s+yes/);
    expect(out).toContain("http://site.example/");
  });
});

describe("renderText lighthouse", () => {
  test("renders scores as integers, seconds to one decimal, CLS to two decimals", () => {
    const out = renderText(makeResult({ lighthouse }));
    expect(out).toContain("Lighthouse");
    expect(out).toContain("Lighthouse lab data, one run on this machine, mobile emulation.");
    expect(out).toContain("Version: 13.0.0");
    expect(out).toContain("Performance: 92");
    expect(out).toContain("Accessibility: 100");
    expect(out).toContain("Best practices: 95");
    expect(out).toContain("SEO: not available");
    expect(out).toContain("FCP: 1.2 s");
    expect(out).toContain("LCP: 2.6 s");
    expect(out).toContain("TBT: 0.0 s");
    expect(out).toContain("CLS: 0.05");
    expect(out).toContain("Speed Index: not available");
  });

  test("prints after the findings and before the footer", () => {
    const out = renderText(makeResult({ lighthouse }));
    expect(out.indexOf("Lighthouse lab data")).toBeGreaterThan(out.indexOf("1 passed"));
    expect(out.indexOf("Lighthouse lab data")).toBeLessThan(
      out.lastIndexOf("site-audit-cli 1.0.0"),
    );
  });

  test("prints the given note when Lighthouse was not found and lists no pages", () => {
    const out = renderText(
      makeResult({
        lighthouse: {
          status: "not-found",
          version: null,
          note: "not run: Lighthouse was not found",
          pages: [],
        },
      }),
    );
    expect(out).toContain("not run: Lighthouse was not found");
    expect(out).not.toContain("Version:");
  });

  test("prints a page error", () => {
    const out = renderText(
      makeResult({
        lighthouse: {
          ...lighthouse,
          status: "failed",
          pages: [
            {
              url: "https://site.example/",
              scores: { performance: null, accessibility: null, bestPractices: null, seo: null },
              metrics: { fcpMs: null, lcpMs: null, tbtMs: null, cls: null, speedIndexMs: null },
              error: "timed out after 120 seconds",
            },
          ],
        },
      }),
    );
    expect(out).toContain("Error: timed out after 120 seconds");
  });

  test("omits the section when there is none", () => {
    expect(renderText(makeResult())).not.toContain("Lighthouse");
  });
});

describe("renderText colour and safety", () => {
  test("colour false prints no escape sequences", () => {
    expect(renderText(makeResult())).not.toContain("\u001b");
    expect(renderText(makeResult(), { color: false })).not.toContain("\u001b");
    expect(renderText(makeHostileResult(), { color: false })).not.toContain("\u001b");
  });

  test("colour true uses red, yellow, cyan and bold, and balances every sequence", () => {
    const out = renderText(makeResult(), { color: true });
    expect(out).toContain("\u001b[31m");
    expect(out).toContain("\u001b[33m");
    expect(out).toContain("\u001b[36m");
    expect(out).toContain("\u001b[1m");
    const opens = count(out, "\u001b[31m") + count(out, "\u001b[33m") + count(out, "\u001b[36m");
    expect(count(out, "\u001b[0m")).toBeGreaterThanOrEqual(opens);
    expect(out.replace(SGR, "")).toBe(renderText(makeResult()));
  });

  test("hostile site text leaves no control character, ANSI sequence or bidi control", () => {
    for (const color of [false, true]) {
      const out = renderText(makeHostileResult(), { color });
      expect(out.replace(SGR, "")).not.toMatch(UNSAFE);
      expect(out.replace(SGR, "")).not.toContain("[31m");
      expect(out).toContain("<script>alert(1)</script>"); // plain text in a terminal is harmless
    }
  });

  test("hostile text is capped", () => {
    const out = renderText(makeHostileResult());
    expect(out).not.toContain("A".repeat(400));
  });
});

describe("scopeLines", () => {
  test("follows the order of the spec", () => {
    const labels = scopeLines(makeResult()).map((l) => l.label);
    expect(labels).toEqual([
      "Tool",
      "Start URL",
      "Audited origin",
      "Date",
      "Duration",
      "Pages crawled",
      "Depth limit",
      "Left uncrawled",
      "Skipped by robots.txt",
      "Ignore robots.txt",
      "External links checked",
      "Assets not measured",
      "Check groups",
      "What this audit does not see",
    ]);
  });

  test("puts the notice first when robots.txt was ignored", () => {
    const base = makeResult();
    const lines = scopeLines({ ...base, scope: { ...base.scope, ignoreRobots: true } });
    expect(lines[0]).toEqual({ label: "Notice", value: "robots.txt was ignored for this run." });
  });
});

describe("durationText", () => {
  test("shows seconds to one decimal under a minute", () => {
    expect(durationText("2026-10-04T10:00:00.000Z", "2026-10-04T10:00:12.300Z")).toBe(
      "12.3 seconds",
    );
  });

  test("does not show 60.0 seconds at the minute boundary", () => {
    expect(durationText("2026-10-04T10:00:00.000Z", "2026-10-04T10:00:59.940Z")).toBe(
      "59.9 seconds",
    );
    expect(durationText("2026-10-04T10:00:00.000Z", "2026-10-04T10:00:59.960Z")).toBe("1 minute");
    expect(durationText("2026-10-04T10:00:00.000Z", "2026-10-04T10:01:59.600Z")).toBe("2 minutes");
  });

  test("shows minutes and whole seconds from a minute up", () => {
    expect(durationText("2026-10-04T10:00:00.000Z", "2026-10-04T10:02:05.400Z")).toBe(
      "2 minutes 5 seconds",
    );
    expect(durationText("2026-10-04T10:00:00.000Z", "2026-10-04T10:01:01.000Z")).toBe(
      "1 minute 1 second",
    );
  });

  test("says not available for dates it cannot read or a negative span", () => {
    expect(durationText("nope", "2026-10-04T10:00:00.000Z")).toBe("not available");
    expect(durationText("2026-10-04T10:00:10.000Z", "2026-10-04T10:00:00.000Z")).toBe(
      "not available",
    );
  });
});
