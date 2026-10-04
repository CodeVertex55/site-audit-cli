import { A11Y_NOTICE } from "../checks/accessibility.js";
import type { AuditResult, Severity } from "../types.js";
import { clean, cleanUrl } from "./sanitise.js";
import {
  FIX_FIRST_NOTE,
  NO_FAILED_CHECKS,
  NO_FIX_FIRST,
  WHOLE_SITE,
  checkCountsLine,
  findingsView,
  groupSections,
  heuristicFor,
  lighthouseView,
  scopeLines,
  summaryRows,
} from "./scope.js";

const SEVERITY_CODE: Record<Severity, string> = { error: "31", warning: "33", info: "36" };
const BOLD = "1";

type Paint = (code: string, text: string) => string;

function painter(color: boolean): Paint {
  return (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
}

function renderScope(result: AuditResult, paint: Paint): string[] {
  const lines = scopeLines(result).map((l) => ({
    label: l.label === "Notice" ? "NOTICE" : l.label,
    value: l.value,
  }));
  const width = Math.max(...lines.map((l) => l.label.length)) + 2;
  return [paint(BOLD, "Scope"), ...lines.map((l) => `  ${`${l.label}:`.padEnd(width)}${l.value}`)];
}

function renderSummary(result: AuditResult, paint: Paint): string[] {
  const rows = summaryRows(result);
  const labelWidth = Math.max("Group".length, ...rows.map((r) => r.label.length)) + 2;
  const cell = (n: number | string, width: number): string => String(n).padStart(width);
  const head = `  ${"Group".padEnd(labelWidth)}${cell("Errors", 8)}${cell("Warnings", 10)}${cell("Info", 6)}`;
  return [
    paint(BOLD, "Summary"),
    head,
    ...rows.map(
      (r) =>
        `  ${r.label.padEnd(labelWidth)}${cell(r.counts.error, 8)}${cell(r.counts.warning, 10)}${cell(r.counts.info, 6)}`,
    ),
  ];
}

function renderFixFirst(result: AuditResult, paint: Paint): string[] {
  const items = result.summary.fixFirst;
  const lines = [paint(BOLD, "Fix first"), FIX_FIRST_NOTE];
  if (items.length === 0) return [...lines, `  ${NO_FIX_FIRST}`];
  items.forEach((item, i) => {
    lines.push(
      `  ${i + 1}. ${item.title} (${item.checkId}), ${paint(SEVERITY_CODE[item.severity], item.severity)}, affected: ${item.affected}`,
      `     Fix: ${item.fix}`,
    );
  });
  return lines;
}

function renderGroups(result: AuditResult, paint: Paint): string[] {
  const lines: string[] = [];
  for (const section of groupSections(result)) {
    lines.push("", paint(BOLD, section.title));
    if (section.notice) lines.push(A11Y_NOTICE);
    if (section.failed.length === 0) lines.push(`  ${NO_FAILED_CHECKS}`);
    for (const check of section.failed) {
      lines.push(
        "",
        `  ${paint(BOLD, check.title)} (${check.id}), ${paint(SEVERITY_CODE[check.severity], check.severity)}`,
        `    Why: ${check.why}`,
        `    Fix: ${check.fix}`,
      );
      const heuristic = heuristicFor(check.id);
      if (heuristic !== null) lines.push(`    Heuristic: ${heuristic}`);
      const { shown, more } = findingsView(check);
      lines.push(`    Findings (${check.findings.length}):`);
      for (const f of shown) {
        const tag =
          f.severity === null ? "" : `${paint(SEVERITY_CODE[f.severity], `[${f.severity}]`)} `;
        lines.push(`      - ${tag}${f.url ?? WHOLE_SITE}: ${f.detail}`);
        for (const e of f.evidence) lines.push(`        Evidence: ${e}`);
      }
      if (more > 0) lines.push(`      and ${more} more`);
    }
  }
  return lines;
}

function renderLighthouse(result: AuditResult, paint: Paint): string[] {
  if (result.lighthouse === null) return [];
  const view = lighthouseView(result.lighthouse);
  const lines = ["", paint(BOLD, "Lighthouse"), `  ${view.note}`];
  if (view.version !== null) lines.push(`  Version: ${view.version}`);
  for (const page of view.pages) {
    lines.push(
      "",
      `  ${page.url}`,
      `    ${page.scores.map((s) => `${s.label}: ${s.value}`).join(", ")}`,
      `    ${page.metrics.map((m) => `${m.label}: ${m.value}`).join(", ")}`,
    );
    if (page.error !== null) lines.push(`    Error: ${page.error}`);
  }
  return lines;
}

/**
 * The plain text report. Every string from the audited site is cleaned first, so the only
 * escape sequences in the output are the colour codes this function adds when `color` is true.
 */
export function renderText(result: AuditResult, opts: { color?: boolean } = {}): string {
  const paint = painter(opts.color === true);
  const lines = [
    paint(BOLD, `Site audit: ${cleanUrl(result.scope.origin)}`),
    "",
    ...renderScope(result, paint),
    "",
    ...renderSummary(result, paint),
    "",
    ...renderFixFirst(result, paint),
    ...renderGroups(result, paint),
    "",
    checkCountsLine(result),
    ...renderLighthouse(result, paint),
    "",
    clean(`${result.tool.name} ${result.tool.version}`),
  ];
  return `${lines.join("\n")}\n`;
}
