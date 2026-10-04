import type { AuditResult, CheckDef, Group, SiteContext } from "../types.js";
import { ACCESSIBILITY_CHECKS } from "./accessibility.js";
import { htmlPages } from "./helpers.js";
import { HEALTH_CHECKS } from "./health.js";
import { PERFORMANCE_CHECKS } from "./performance.js";
import { SEO_CHECKS } from "./seo.js";

/** Every check, in the order seo, health, performance, accessibility. */
export const CHECKS: readonly CheckDef[] = [
  ...SEO_CHECKS.map((spec): CheckDef => ({ ...spec, group: "seo" })),
  ...HEALTH_CHECKS.map((spec): CheckDef => ({ ...spec, group: "health" })),
  ...PERFORMANCE_CHECKS.map((spec): CheckDef => ({ ...spec, group: "performance" })),
  ...ACCESSIBILITY_CHECKS.map((spec): CheckDef => ({ ...spec, group: "accessibility" })),
];

export type CheckOutcome = AuditResult["checks"][number];

const BY_ID: ReadonlyMap<string, CheckDef> = new Map(CHECKS.map((check) => [check.id, check]));

export function getCheck(id: string): CheckDef | undefined {
  return BY_ID.get(id);
}

function applies(check: CheckDef, ctx: SiteContext): boolean {
  return check.applies ? check.applies(ctx) : htmlPages(ctx).length > 0;
}

/**
 * Runs the checks of the given groups. A check is `not-applicable` when its precondition
 * is false, `fail` when it returns findings, and `pass` otherwise.
 */
export function runChecks(ctx: SiteContext, groups: readonly Group[]): CheckOutcome[] {
  return CHECKS.filter((check) => groups.includes(check.group)).map((check): CheckOutcome => {
    const base = {
      id: check.id,
      group: check.group,
      severity: check.severity,
      title: check.title,
      why: check.why,
      fix: check.fix,
    };
    if (!applies(check, ctx)) return { ...base, status: "not-applicable", findings: [] };
    const findings = check.run(ctx);
    return { ...base, status: findings.length > 0 ? "fail" : "pass", findings };
  });
}
