import { describe, expect, test } from "vitest";
import { NOT_SEEN } from "../src/audit.js";
import { A11Y_NOTICE } from "../src/checks/accessibility.js";
import { renderMarkdown } from "../src/report/markdown.js";
import type { LighthouseSection } from "../src/types.js";
import { UNSAFE, makeHostileResult, makeResult } from "./helpers/result.js";

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The number of cell separators in a table row once escaped pipes are removed. */
function separators(row: string): number {
  return row.replace(/\\\|/g, "").split("|").length - 1;
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

describe("renderMarkdown structure", () => {
  const out = renderMarkdown(makeResult());

  test("opens with a heading naming the origin and has a scope list", () => {
    expect(out.startsWith("# Site audit: https://site.example\n")).toBe(true);
    expect(out).toContain("## Scope");
    expect(out).toContain("- **Tool:** site-audit-cli 1.0.0");
    expect(out).toContain("- **Pages crawled:** 3 (limit 50)");
    expect(out).toContain("- **Skipped by robots.txt:** 2");
    expect(out).toContain("- **Left uncrawled:** 4");
    for (const line of NOT_SEEN) expect(out).toContain(line);
  });

  test("has a summary table with a row per group and a total", () => {
    expect(out).toContain("## Summary");
    expect(out).toContain("| Group | Errors | Warnings | Info |");
    expect(out).toContain("| --- | ---: | ---: | ---: |");
    expect(out).toContain("| SEO | 12 | 0 | 0 |");
    expect(out).toContain("| **Total** | 12 | 1 | 1 |");
  });

  test("sections come in the specified order", () => {
    const order = [
      "# Site audit:",
      "## Scope",
      "## Summary",
      "## Fix first",
      "Ordered by severity, then by number of affected pages.",
      "## SEO",
      "## Performance",
      "## Accessibility",
      "1 passed",
      "site-audit-cli 1.0.0",
    ].map((s) => out.lastIndexOf(s));
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("fix first states the full ordering and exclusion rule", () => {
    expect(out).toContain(
      "Ordered by severity, then by number of affected pages. Info findings are not counted, and checks whose findings are all info are left out.",
    );
  });

  test("fix first is a numbered list", () => {
    expect(out).toMatch(/^1\. \*\*Page has no title\*\* \(`SEO-TITLE-001`, error, affected: 12\)/m);
    expect(out).toMatch(/^2\. \*\*Images without width and height\*\*/m);
  });

  test("each failed check has a heading, details and a findings table", () => {
    expect(out).toContain("### Images without width and height");
    expect(out).toContain("- **Check:** `PERF-IMG-052`");
    expect(out).toContain("- **Severity:** warning");
    expect(out).toContain("- **Why:**");
    expect(out).toContain("- **Fix:**");
    expect(out).toContain("- **Heuristic:** Decorative images are counted too");
    expect(out).toContain("| Page | Detail |");
    expect(out).toContain("| https://site.example/contact | 2 images have no width and height. |");
  });

  test("angle brackets in check text are escaped", () => {
    expect(out).toContain("Add a unique \\<title\\>");
    expect(out).not.toContain("<title>");
  });

  test("a finding with a lower severity than its check shows its own severity", () => {
    expect(out).toContain("(info) 1 image has no width and height.");
  });

  test("evidence is added to the detail cell", () => {
    expect(out).toContain("Evidence: https://site.example/sitemap.xml");
  });

  test("shows the first 10 findings and then 'and 2 more'", () => {
    expect(out).toContain("and 2 more");
    expect(count(out, "No \\<title\\> element, or it is empty.")).toBe(10);
  });

  test("ends with passed and not-applicable counts and the footer", () => {
    expect(out).toContain("1 passed, 1 not applicable");
    expect(out.trimEnd().split("\n").at(-1)).toBe("site-audit-cli 1.0.0");
    expect(out.endsWith("\n")).toBe(true);
  });
});

describe("renderMarkdown accessibility notice", () => {
  test("appears exactly once when the accessibility group ran", () => {
    const out = renderMarkdown(makeResult());
    expect(count(out, A11Y_NOTICE)).toBe(1);
    expect(out.indexOf(A11Y_NOTICE)).toBeGreaterThan(out.lastIndexOf("## Accessibility"));
  });

  test("is absent when the accessibility group did not run", () => {
    const base = makeResult();
    const out = renderMarkdown({
      ...base,
      scope: { ...base.scope, groups: ["seo"] },
      checks: base.checks.filter((c) => c.group === "seo"),
    });
    expect(count(out, A11Y_NOTICE)).toBe(0);
    expect(out).not.toContain("## Accessibility");
  });
});

describe("renderMarkdown scope variants", () => {
  test("ignoreRobots prints the notice as the first scope line", () => {
    const base = makeResult();
    const out = renderMarkdown({ ...base, scope: { ...base.scope, ignoreRobots: true } });
    const scope = out.slice(out.indexOf("## Scope"));
    expect(scope.split("\n")[2]).toBe("- **Notice:** robots.txt was ignored for this run.");
  });
});

describe("renderMarkdown lighthouse", () => {
  test("renders a table with integer scores, seconds, CLS and 'not available'", () => {
    const out = renderMarkdown(makeResult({ lighthouse }));
    expect(out).toContain("## Lighthouse");
    expect(out).toContain("Lighthouse lab data, one run on this machine, mobile emulation.");
    expect(out).toContain("Version: 13.0.0");
    expect(out).toContain(
      "| https://site.example/ | 92 | 100 | 95 | not available | 1.2 s | 2.6 s | 0.0 s | 0.05 | not available |",
    );
    expect(out.indexOf("## Lighthouse")).toBeGreaterThan(out.indexOf("1 passed"));
    expect(out.indexOf("## Lighthouse")).toBeLessThan(out.lastIndexOf("site-audit-cli 1.0.0"));
  });

  test("prints the note and no table when Lighthouse was not found", () => {
    const out = renderMarkdown(
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
    expect(out).not.toContain("| Page | Performance");
  });

  test("lists a page error below the table", () => {
    const out = renderMarkdown(
      makeResult({
        lighthouse: {
          ...lighthouse,
          pages: [
            { ...(lighthouse.pages[0] as (typeof lighthouse.pages)[number]), error: "timed out" },
          ],
        },
      }),
    );
    expect(out).toContain("Error for https://site.example/: timed out");
  });

  test("omits the section when there is none", () => {
    expect(renderMarkdown(makeResult())).not.toContain("Lighthouse");
  });
});

describe("renderMarkdown safety", () => {
  const out = renderMarkdown(makeHostileResult());

  test("no raw control character, no ANSI, no raw script tag", () => {
    expect(out).not.toMatch(UNSAFE);
    expect(out).not.toContain("[31m");
    expect(out).not.toContain("<script>");
    expect(out).not.toMatch(/(^|[^\\])</); // every angle bracket is escaped
  });

  test("hostile pipes inside table cells are escaped", () => {
    const lines = out.split("\n");
    let columns = 0;
    let checked = 0;
    lines.forEach((row, i) => {
      if (!row.startsWith("|")) return;
      const next = lines[i + 1] ?? "";
      if (next.startsWith("| ---")) columns = separators(next); // a header row opens a table
      expect(separators(row)).toBe(columns);
      checked += 1;
    });
    expect(checked).toBeGreaterThan(10);
    expect(lines.some((l) => l.startsWith("|") && l.includes("alert"))).toBe(true);
  });

  test("brackets are escaped so the hostile link cannot form", () => {
    expect(out).not.toContain("[a](javascript:");
    expect(out).toContain("\\[a\\](javascript:");
  });

  test("hostile text is capped and a hostile heading stays on one line", () => {
    expect(out).not.toContain("A".repeat(400));
    const heading = out.split("\n")[0] ?? "";
    expect(heading.startsWith("# Site audit: ")).toBe(true);
    expect(heading).not.toContain("<script>");
  });
});
