import { NOT_SEEN } from "../../src/audit.js";
import { finding } from "../../src/checks/helpers.js";
import { getCheck, type CheckOutcome } from "../../src/checks/registry.js";
import { summarise } from "../../src/checks/summary.js";
import {
  GROUPS,
  type AuditResult,
  type Finding,
  type PageSummary,
  type Severity,
} from "../../src/types.js";

/** A string that tries every trick the report layer has to neutralise. */
export const HOSTILE: string =
  "<script>alert(1)</script> | `x` [a](javascript:alert(1)) \u001b[31mred\u001b[0m \u202eevil\u0007 " +
  "A".repeat(500);

/* eslint-disable no-control-regex -- these patterns exist to find control characters */

/**
 * Matches any control character except the line feed, plus bidirectional controls,
 * zero-width characters and line separators.
 */
export const UNSAFE =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/;

/** The colour sequences the text report adds itself. */
export const SGR = /\u001b\[[0-9;]*m/g;

/* eslint-enable no-control-regex */

const ORIGIN = "https://site.example";

/** A check as the registry describes it, with the given outcome. */
function outcome(
  id: string,
  status: CheckOutcome["status"],
  findings: Finding[] = [],
): CheckOutcome {
  const def = getCheck(id);
  if (def === undefined) throw new Error(`No such check in the registry: ${id}`);
  return {
    id: def.id,
    group: def.group,
    severity: def.severity,
    title: def.title,
    why: def.why,
    fix: def.fix,
    status,
    findings,
  };
}

function pageSummaries(checks: CheckOutcome[]): PageSummary[] {
  const urls = [`${ORIGIN}/`, `${ORIGIN}/about`, `${ORIGIN}/contact`];
  return urls.map((url, i) => {
    const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
    for (const check of checks) {
      for (const f of check.findings) if (f.url === url) counts[f.severity] += 1;
    }
    return { url, status: 200, responseMs: 100 + i * 40, counts };
  });
}

/**
 * A fixed result: two failed checks (an error with 12 findings, a warning with 2), one
 * passed check, one not-applicable check and three pages. All four groups ran.
 */
export function makeResult(over: Partial<AuditResult> = {}): AuditResult {
  const titleDef = { id: "SEO-TITLE-001", group: "seo", severity: "error" } as const;
  const titleFindings: Finding[] = Array.from({ length: 12 }, (_, i) =>
    finding(
      titleDef,
      i === 0 ? `${ORIGIN}/` : i === 1 ? `${ORIGIN}/about` : `${ORIGIN}/page-${i}`,
      "No <title> element, or it is empty.",
      i === 0 ? [`${ORIGIN}/sitemap.xml`] : undefined,
    ),
  );
  const imageDef = { id: "PERF-IMG-052", group: "performance", severity: "warning" } as const;
  const imageFindings: Finding[] = [
    finding(imageDef, `${ORIGIN}/contact`, "2 images have no width and height."),
    {
      ...finding(imageDef, `${ORIGIN}/about`, "1 image has no width and height."),
      severity: "info",
    },
  ];
  const checks: CheckOutcome[] = [
    outcome("SEO-TITLE-001", "fail", titleFindings),
    outcome("PERF-IMG-052", "fail", imageFindings),
    outcome("A11Y-ALT-001", "pass"),
    outcome("HEALTH-FAV-040", "not-applicable"),
  ];
  const base: AuditResult = {
    schemaVersion: 1,
    tool: { name: "site-audit-cli", version: "1.0.0" },
    startedAt: "2026-10-04T10:00:00.000Z",
    finishedAt: "2026-10-04T10:00:12.300Z",
    scope: {
      startUrl: `${ORIGIN}/`,
      origin: ORIGIN,
      originNote: null,
      pagesCrawled: 3,
      maxPages: 50,
      maxDepth: 3,
      uncrawled: 4,
      blockedByRobots: [`${ORIGIN}/private`, `${ORIGIN}/admin`],
      ignoreRobots: false,
      checkExternal: false,
      assetsNotMeasured: 6,
      delayRaised: false,
      crawlDelayMs: null,
      groups: [...GROUPS],
      notSeen: [...NOT_SEEN],
    },
    summary: summarise(checks),
    checks,
    pages: pageSummaries(checks),
    lighthouse: null,
  };
  return { ...base, ...over };
}

/**
 * `makeResult()` with hostile text in every place the audited site can reach: the first
 * finding, the start URL, the origin and its note, and a Lighthouse section.
 */
export function makeHostileResult(): AuditResult {
  const result = makeResult();
  const checks = result.checks.map((check, index) =>
    index === 0
      ? {
          ...check,
          findings: check.findings.map((f, i): Finding =>
            i === 0 ? { ...f, url: HOSTILE, detail: HOSTILE, evidence: [HOSTILE] } : f,
          ),
        }
      : check,
  );
  return {
    ...result,
    checks,
    scope: {
      ...result.scope,
      startUrl: HOSTILE,
      origin: HOSTILE,
      originNote: HOSTILE,
      blockedByRobots: [HOSTILE],
    },
    lighthouse: {
      status: "failed",
      version: "13.0.0",
      note: HOSTILE,
      pages: [
        {
          url: HOSTILE,
          scores: { performance: null, accessibility: null, bestPractices: null, seo: null },
          metrics: { fcpMs: null, lcpMs: null, tbtMs: null, cls: null, speedIndexMs: null },
          error: HOSTILE,
        },
      ],
    },
  };
}
