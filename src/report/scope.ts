import { getCheck, type CheckOutcome } from "../checks/registry.js";
import {
  GROUPS,
  type AuditResult,
  type Group,
  type LighthouseSection,
  type Severity,
} from "../types.js";
import { clean, cleanUrl } from "./sanitise.js";

/*
 * The scope block and the pieces of report content that the text, Markdown and HTML formats
 * share. Every function returns plain, cleaned strings. Each format escapes them its own way.
 */

export const FIX_FIRST_NOTE = "Ordered by severity, then by number of affected pages.";
export const NO_FIX_FIRST = "No errors or warnings to fix first.";
export const NO_FAILED_CHECKS = "No failed checks.";
export const NOT_AVAILABLE = "not available";
/** Shown in place of the page for a finding that has none. */
export const WHOLE_SITE = "(whole site)";

/** Findings listed per check in the text and Markdown reports. */
export const FINDINGS_SHOWN = 10;

export const GROUP_TITLES: Record<Group, string> = {
  seo: "SEO",
  health: "Health",
  performance: "Performance",
  accessibility: "Accessibility",
};

const NOTE_MAX = 400;

/** How long the audit took, for example `12.3 seconds` or `2 minutes 5 seconds`. */
export function durationText(startedAt: string, finishedAt: string): string {
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (Number.isNaN(ms) || ms < 0) return NOT_AVAILABLE;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} seconds`;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const m = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return seconds === 0 ? m : `${m} ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** The scope block in the order of the spec. The notice, when there is one, comes first. */
export function scopeLines(result: AuditResult): { label: string; value: string }[] {
  const { scope } = result;
  const yesNo = (flag: boolean): string => (flag ? "yes" : "no");
  const lines: { label: string; value: string }[] = [];
  if (scope.ignoreRobots) {
    lines.push({ label: "Notice", value: "robots.txt was ignored for this run." });
  }
  lines.push(
    { label: "Tool", value: clean(`${result.tool.name} ${result.tool.version}`) },
    { label: "Start URL", value: cleanUrl(scope.startUrl) },
    { label: "Audited origin", value: cleanUrl(scope.origin) },
  );
  if (scope.originNote !== null) {
    lines.push({ label: "Origin note", value: clean(scope.originNote) });
  }
  lines.push(
    { label: "Date", value: clean(result.startedAt) },
    { label: "Duration", value: durationText(result.startedAt, result.finishedAt) },
    { label: "Pages crawled", value: `${scope.pagesCrawled} (limit ${scope.maxPages})` },
    { label: "Depth limit", value: String(scope.maxDepth) },
    { label: "Left uncrawled", value: String(scope.uncrawled) },
    { label: "Skipped by robots.txt", value: String(scope.blockedByRobots.length) },
    { label: "Ignore robots.txt", value: yesNo(scope.ignoreRobots) },
    { label: "External links checked", value: yesNo(scope.checkExternal) },
    { label: "Assets not measured", value: String(scope.assetsNotMeasured) },
  );
  if (scope.delayRaised) {
    lines.push({
      label: "Delay raised",
      value: "yes, a host kept answering 429 or 503 and the delay to it was doubled",
    });
  }
  lines.push(
    { label: "Check groups", value: scope.groups.join(", ") },
    { label: "What this audit does not see", value: scope.notSeen.map((s) => clean(s)).join(" ") },
  );
  return lines;
}

export type SummaryRow = { label: string; counts: Record<Severity, number> };

/** One row for each group that ran, then the total. */
export function summaryRows(result: AuditResult): SummaryRow[] {
  const rows = GROUPS.filter((g) => result.scope.groups.includes(g)).map((g): SummaryRow => ({
    label: GROUP_TITLES[g],
    counts: result.summary.byGroup[g],
  }));
  const total: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const row of rows) {
    total.error += row.counts.error;
    total.warning += row.counts.warning;
    total.info += row.counts.info;
  }
  return [...rows, { label: "Total", counts: total }];
}

export type GroupSection = {
  group: Group;
  title: string;
  /** True for the group that carries the accessibility notice. */
  notice: boolean;
  failed: CheckOutcome[];
};

/** The groups that ran, in the fixed order, each with its failed checks. */
export function groupSections(result: AuditResult): GroupSection[] {
  return GROUPS.filter((g) => result.scope.groups.includes(g)).map((group) => ({
    group,
    title: GROUP_TITLES[group],
    notice: group === "accessibility",
    failed: result.checks.filter((c) => c.group === group && c.status === "fail"),
  }));
}

/** The rule of thumb behind a check, taken from the registry; the result does not carry it. */
export function heuristicFor(checkId: string): string | null {
  return getCheck(checkId)?.heuristic ?? null;
}

/** Counts of failed, passed and not-applicable checks, as one line. */
export function checkCountsLine(result: AuditResult): string {
  const n = (status: CheckOutcome["status"]): number =>
    result.checks.filter((c) => c.status === status).length;
  return `Checks: ${n("fail")} failed, ${n("pass")} passed, ${n("not-applicable")} not applicable.`;
}

export type FindingView = {
  url: string | null;
  detail: string;
  /** Set only when the finding's severity differs from its check's. */
  severity: Severity | null;
  evidence: string[];
};

/** The first findings of a check, cleaned, and how many were left out. */
export function findingsView(check: CheckOutcome): { shown: FindingView[]; more: number } {
  const shown = check.findings.slice(0, FINDINGS_SHOWN).map((f): FindingView => ({
    url: f.url === null ? null : cleanUrl(f.url),
    detail: clean(f.detail),
    severity: f.severity === check.severity ? null : f.severity,
    evidence: (f.evidence ?? []).map((e) => cleanUrl(e)),
  }));
  return { shown, more: Math.max(0, check.findings.length - shown.length) };
}

function score(value: number | null): string {
  return value === null ? NOT_AVAILABLE : String(Math.round(value));
}

function seconds(ms: number | null): string {
  return ms === null ? NOT_AVAILABLE : `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}

function layoutShift(value: number | null): string {
  return value === null ? NOT_AVAILABLE : value.toFixed(2);
}

export type LighthouseView = {
  note: string;
  version: string | null;
  pages: {
    url: string;
    scores: { label: string; value: string }[];
    metrics: { label: string; value: string }[];
    error: string | null;
  }[];
};

/** The Lighthouse section as cleaned strings: integer scores, seconds, CLS to two decimals. */
export function lighthouseView(section: LighthouseSection): LighthouseView {
  return {
    note: clean(section.note, NOTE_MAX),
    version: section.version === null ? null : clean(section.version, 40),
    pages: section.pages.map((p) => ({
      url: cleanUrl(p.url),
      scores: [
        { label: "Performance", value: score(p.scores.performance) },
        { label: "Accessibility", value: score(p.scores.accessibility) },
        { label: "Best practices", value: score(p.scores.bestPractices) },
        { label: "SEO", value: score(p.scores.seo) },
      ],
      metrics: [
        { label: "FCP", value: seconds(p.metrics.fcpMs) },
        { label: "LCP", value: seconds(p.metrics.lcpMs) },
        { label: "TBT", value: seconds(p.metrics.tbtMs) },
        { label: "CLS", value: layoutShift(p.metrics.cls) },
        { label: "Speed Index", value: seconds(p.metrics.speedIndexMs) },
      ],
      error: p.error === null ? null : clean(p.error, NOTE_MAX),
    })),
  };
}
