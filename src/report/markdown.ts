import { A11Y_NOTICE } from "../checks/accessibility.js";
import type { AuditResult } from "../types.js";
import { clean, cleanUrl, escapeMarkdown, escapeMarkdownInline } from "./sanitise.js";
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

// Nothing the audited site supplies starts a line, so the inline form is enough, except for the
// Lighthouse note, which stands alone as a paragraph.
const esc = escapeMarkdownInline;

/** A run of lines that sits apart from its neighbours by one blank line. */
type Block = string[];

function joinBlocks(blocks: Block[]): string[] {
  return blocks.flatMap((block, i) => (i === 0 ? block : ["", ...block]));
}

function scopeBlock(result: AuditResult): Block {
  return joinBlocks([
    ["## Scope"],
    scopeLines(result).map((l) => `- **${esc(l.label)}:** ${esc(l.value)}`),
  ]);
}

function summaryBlock(result: AuditResult): Block {
  return joinBlocks([
    ["## Summary"],
    [
      "| Group | Errors | Warnings | Info |",
      "| --- | ---: | ---: | ---: |",
      ...summaryRows(result).map((r) => {
        const label = r.label === "Total" ? "**Total**" : esc(r.label);
        return `| ${label} | ${r.counts.error} | ${r.counts.warning} | ${r.counts.info} |`;
      }),
    ],
  ]);
}

function fixFirstBlock(result: AuditResult): Block {
  const items = result.summary.fixFirst;
  return joinBlocks([
    ["## Fix first"],
    [FIX_FIRST_NOTE],
    items.length === 0
      ? [NO_FIX_FIRST]
      : items.map(
          (item, i) =>
            `${i + 1}. **${esc(item.title)}** (\`${item.checkId}\`, ${item.severity}, affected: ${item.affected}): ${esc(item.fix)}`,
        ),
  ]);
}

function checkBlock(check: AuditResult["checks"][number]): Block {
  const heuristic = heuristicFor(check.id);
  const { shown, more } = findingsView(check);
  const rows = shown.map((f) => {
    const tag = f.severity === null ? "" : `(${f.severity}) `;
    const evidence = f.evidence.length === 0 ? "" : ` Evidence: ${f.evidence.join("; ")}`;
    return `| ${esc(f.url ?? WHOLE_SITE)} | ${esc(`${tag}${f.detail}${evidence}`)} |`;
  });
  return joinBlocks([
    [`### ${esc(check.title)}`],
    [
      `- **Check:** \`${check.id}\``,
      `- **Severity:** ${check.severity}`,
      `- **Why:** ${esc(check.why)}`,
      `- **Fix:** ${esc(check.fix)}`,
      ...(heuristic === null ? [] : [`- **Heuristic:** ${esc(heuristic)}`]),
    ],
    [`Findings (${check.findings.length}):`],
    ["| Page | Detail |", "| --- | --- |", ...rows],
    ...(more > 0 ? [[`and ${more} more`]] : []),
  ]);
}

function groupBlocks(result: AuditResult): Block[] {
  return groupSections(result).map((section) =>
    joinBlocks([
      [`## ${esc(section.title)}`],
      ...(section.notice ? [[`> ${esc(A11Y_NOTICE)}`]] : []),
      ...(section.failed.length === 0 ? [[NO_FAILED_CHECKS]] : section.failed.map(checkBlock)),
    ]),
  );
}

function lighthouseBlocks(result: AuditResult): Block[] {
  if (result.lighthouse === null) return [];
  const view = lighthouseView(result.lighthouse);
  const blocks: Block[] = [["## Lighthouse"], [escapeMarkdown(view.note)]];
  if (view.version !== null) blocks.push([`Version: ${esc(view.version)}`]);
  const first = view.pages[0];
  if (first !== undefined) {
    const columns = [...first.scores, ...first.metrics].map((c) => c.label);
    blocks.push([
      `| Page | ${columns.join(" | ")} |`,
      `| --- |${columns.map(() => " ---: |").join("")}`,
      ...view.pages.map((page) => {
        const values = [...page.scores, ...page.metrics].map((c) => c.value);
        return `| ${esc(page.url)} | ${values.join(" | ")} |`;
      }),
    ]);
  }
  for (const page of view.pages) {
    if (page.error !== null) blocks.push([`Error for ${esc(page.url)}: ${esc(page.error)}`]);
  }
  return blocks;
}

/**
 * The Markdown report, for a ticket or a proposal. Every string from the audited site is
 * cleaned and then escaped, so none of it can form a link, a table cell or markup.
 */
export function renderMarkdown(result: AuditResult): string {
  const lines = joinBlocks([
    [`# Site audit: ${esc(cleanUrl(result.scope.origin))}`],
    scopeBlock(result),
    summaryBlock(result),
    fixFirstBlock(result),
    ...groupBlocks(result),
    [checkCountsLine(result)],
    ...lighthouseBlocks(result),
    [esc(clean(`${result.tool.name} ${result.tool.version}`))],
  ]);
  return `${lines.join("\n")}\n`;
}
