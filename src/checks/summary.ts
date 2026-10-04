import { GROUPS, type AuditResult, type FixFirstItem, type Severity } from "../types.js";
import type { CheckOutcome } from "./registry.js";

const FIX_FIRST_LIMIT = 5;

function emptyCounts(): Record<Severity, number> {
  return { error: 0, warning: 0, info: 0 };
}

/** Distinct affected URLs among the findings; all site-level findings together count as one. */
function affectedCount(findings: CheckOutcome["findings"]): number {
  const urls = new Set<string>();
  let siteLevel = 0;
  for (const f of findings) {
    if (f.url === null) siteLevel = 1;
    else urls.add(f.url);
  }
  return urls.size + siteLevel;
}

function byAffectedThenId(a: FixFirstItem, b: FixFirstItem): number {
  if (a.affected !== b.affected) return b.affected - a.affected;
  return a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0;
}

/**
 * Fix first: failed checks of severity error, then warning, each ordered by the number of
 * distinct affected URLs and then by check id, capped at five. Findings that are only info
 * (for example links that could not be verified) are not counted as affected pages, and a
 * check with no other findings is left out.
 */
function fixFirst(checks: CheckOutcome[]): FixFirstItem[] {
  const items = (severity: Severity): FixFirstItem[] =>
    checks
      .filter((c) => c.status === "fail" && c.severity === severity)
      .flatMap((c): FixFirstItem[] => {
        const actionable = c.findings.filter((f) => f.severity !== "info");
        if (actionable.length === 0) return [];
        return [
          {
            checkId: c.id,
            title: c.title,
            severity: c.severity,
            affected: affectedCount(actionable),
            fix: c.fix,
          },
        ];
      })
      .sort(byAffectedThenId);
  return [...items("error"), ...items("warning")].slice(0, FIX_FIRST_LIMIT);
}

/** Totals for the report: findings by group and their own severity, check counts, fix first. */
export function summarise(checks: CheckOutcome[]): AuditResult["summary"] {
  const byGroup = Object.fromEntries(
    GROUPS.map((g) => [g, emptyCounts()]),
  ) as AuditResult["summary"]["byGroup"]; // every group is a key, so the cast only restates the shape
  for (const check of checks) {
    for (const f of check.findings) byGroup[f.group][f.severity] += 1;
  }
  return {
    byGroup,
    checksRun: checks.filter((c) => c.status !== "not-applicable").length,
    checksPassed: checks.filter((c) => c.status === "pass").length,
    fixFirst: fixFirst(checks),
  };
}
