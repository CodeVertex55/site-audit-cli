import { A11Y_NOTICE } from "../checks/accessibility.js";
import type { AuditResult, PageSummary, Severity } from "../types.js";
import { clean, cleanUrl, escapeHtml, isHttpUrl } from "./sanitise.js";
import {
  FIX_FIRST_NOTE,
  NOT_AVAILABLE,
  NO_FAILED_CHECKS,
  NO_FIX_FIRST,
  WHOLE_SITE,
  findingsView,
  groupSections,
  heuristicFor,
  lighthouseView,
  scopeLines,
  summaryRows,
  type GroupSection,
} from "./scope.js";

/** Findings listed per check in the HTML report. The JSON report carries all of them. */
const FINDINGS_SHOWN_HTML = 50;

const LINK_REL = "noopener noreferrer nofollow";

const SEVERITIES: readonly Severity[] = ["error", "warning", "info"];

/**
 * Cleans and escapes text from the audit result. Callers apply their own length cap first
 * (`clean` or `cleanUrl`), so no cap is applied here and cleaned text passes through intact.
 */
function e(value: string): string {
  return escapeHtml(clean(value, Number.POSITIVE_INFINITY));
}

/** The address a link should point to, or null when the value is not an http or https URL. */
function hrefFor(raw: string): string | null {
  const cleaned = clean(raw, Number.POSITIVE_INFINITY);
  return isHttpUrl(cleaned) ? new URL(cleaned).href : null;
}

/** A URL as text, made a link only when it is http or https. `shown` is already capped. */
function urlCell(raw: string, shown: string): string {
  const href = hrefFor(raw);
  const text = e(shown);
  return href === null ? text : `<a href="${escapeHtml(href)}" rel="${LINK_REL}">${text}</a>`;
}

function severityLabel(severity: Severity): string {
  const kind = SEVERITIES.includes(severity) ? severity : "info";
  return `<span class="sev sev-${kind}">${e(severity)}</span>`;
}

function tableWrap(label: string, table: string): string {
  return `<div class="table-wrap" role="region" aria-label="${e(label)}" tabindex="0">${table}</div>`;
}

function section(id: string, title: string, body: string): string {
  return `<section id="${id}">\n<h2>${e(title)}</h2>\n${body}\n</section>`;
}

function headerBlock(result: AuditResult, nav: { id: string; label: string }[]): string {
  const tool = `${result.tool.name} ${result.tool.version}`;
  return [
    `<header id="top">`,
    `<p class="eyebrow">Site audit</p>`,
    `<h1>${e(cleanUrl(result.scope.origin))}</h1>`,
    `<p class="meta"><span>${e(result.startedAt)}</span><span>${e(tool)}</span></p>`,
    `<nav aria-label="Sections"><ul>${nav
      .map((n) => `<li><a href="#${n.id}">${e(n.label)}</a></li>`)
      .join("")}</ul></nav>`,
    `</header>`,
  ].join("\n");
}

function scopeBlock(result: AuditResult): string {
  const lines = scopeLines(result);
  const notice = lines.find((l) => l.label === "Notice");
  const rest = lines.filter((l) => l.label !== "Notice");
  const list = rest
    .map((l) => `<div><dt>${e(l.label)}</dt><dd>${e(l.value)}</dd></div>`)
    .join("\n");
  return section(
    "scope",
    "Scope",
    [notice === undefined ? "" : `<p class="notice">${e(notice.value)}</p>`, `<dl>\n${list}\n</dl>`]
      .filter((s) => s !== "")
      .join("\n"),
  );
}

function summaryBlock(result: AuditResult): string {
  const rows = summaryRows(result)
    .map((r) => {
      const cells = [r.counts.error, r.counts.warning, r.counts.info]
        .map((n) => `<td class="num${n === 0 ? " zero" : ""}">${n}</td>`)
        .join("");
      const cls = r.label === "Total" ? ` class="total"` : "";
      return `<tr${cls}><th scope="row">${e(r.label)}</th>${cells}</tr>`;
    })
    .join("\n");
  const table = [
    `<table>`,
    `<thead><tr><th scope="col">Group</th><th scope="col" class="num">Errors</th><th scope="col" class="num">Warnings</th><th scope="col" class="num">Info</th></tr></thead>`,
    `<tbody>\n${rows}\n</tbody>`,
    `</table>`,
  ].join("\n");
  const { checksPassed, checksRun } = result.summary;
  return section(
    "summary",
    "Summary",
    `${tableWrap("Findings by group and severity", table)}\n<p class="note">Checks passed: ${checksPassed} of ${checksRun} checks run.</p>`,
  );
}

function fixFirstBlock(result: AuditResult): string {
  const items = result.summary.fixFirst;
  const body =
    items.length === 0
      ? `<p>${e(NO_FIX_FIRST)}</p>`
      : `<ol class="fix-first">\n${items
          .map(
            (item) =>
              `<li><p class="lead">${severityLabel(item.severity)}<strong>${e(item.title)}</strong><code>${e(item.checkId)}</code><span class="count">affected: ${item.affected}</span></p><p>${e(item.fix)}</p></li>`,
          )
          .join("\n")}\n</ol>`;
  return section("fix-first", "Fix first", `<p class="note">${e(FIX_FIRST_NOTE)}</p>\n${body}`);
}

function evidenceList(items: { raw: string; shown: string }[]): string {
  if (items.length === 0) return "";
  return `<ul class="evidence">${items
    .map((i) => `<li>${urlCell(i.raw, i.shown)}</li>`)
    .join("")}</ul>`;
}

function checkBlock(check: AuditResult["checks"][number]): string {
  const { shown, more } = findingsView(check, FINDINGS_SHOWN_HTML);
  const heuristic = heuristicFor(check.id);
  const rows = shown
    .map((view, i) => {
      const raw = check.findings[i]; // findingsView keeps the order of the findings it shows
      const page = view.url === null ? e(WHOLE_SITE) : urlCell(raw?.url ?? "", view.url);
      const label = view.severity === null ? "" : `${severityLabel(view.severity)} `;
      const evidence = evidenceList(
        view.evidence.map((shownText, j) => ({ raw: raw?.evidence?.[j] ?? "", shown: shownText })),
      );
      return `<tr><td class="url">${page}</td><td class="detail">${label}${e(view.detail)}</td><td class="url">${evidence}</td></tr>`;
    })
    .join("\n");
  const table = [
    `<table>`,
    `<thead><tr><th scope="col">Page</th><th scope="col">Detail</th><th scope="col">Evidence</th></tr></thead>`,
    `<tbody>\n${rows}\n</tbody>`,
    `</table>`,
  ].join("\n");
  const count = check.findings.length;
  const facts = [
    `<dt>Why</dt><dd>${e(check.why)}</dd>`,
    `<dt>Fix</dt><dd>${e(check.fix)}</dd>`,
    ...(heuristic === null ? [] : [`<dt>Heuristic</dt><dd>${e(heuristic)}</dd>`]),
  ].join("\n");
  return [
    `<details class="check" id="check-${e(check.id)}"${check.severity === "error" ? " open" : ""}>`,
    `<summary>${severityLabel(check.severity)}<span class="title">${e(check.title)}</span><span class="count">${count} ${count === 1 ? "finding" : "findings"}</span></summary>`,
    `<div class="check-body">`,
    `<p class="check-id"><code>${e(check.id)}</code></p>`,
    `<dl class="facts">\n${facts}\n</dl>`,
    tableWrap(`Findings for ${check.title}`, table),
    more > 0 ? `<p class="note">and ${more} more, see the JSON report</p>` : "",
    `</div>`,
    `</details>`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function groupBlock(group: GroupSection): string {
  const body =
    group.failed.length === 0
      ? `<p>${e(NO_FAILED_CHECKS)}</p>`
      : group.failed.map(checkBlock).join("\n");
  return [
    `<section id="group-${group.group}" class="group">`,
    `<h3>${e(group.title)}</h3>`,
    group.notice ? `<p class="notice" role="note">${e(A11Y_NOTICE)}</p>` : "",
    body,
    `</section>`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function findingsBlock(result: AuditResult): string {
  return section("findings", "Findings", groupSections(result).map(groupBlock).join("\n"));
}

function passedBlock(result: AuditResult): string {
  const list = (status: "pass" | "not-applicable", title: string): string => {
    const checks = result.checks.filter((c) => c.status === status);
    if (checks.length === 0) return "";
    const items = checks
      .map((c) => `<li><span class="title">${e(c.title)}</span><code>${e(c.id)}</code></li>`)
      .join("\n");
    return `<details class="passed-list">\n<summary>${e(title)} (${checks.length})</summary>\n<ul>\n${items}\n</ul>\n</details>`;
  };
  const body = [list("pass", "Passed"), list("not-applicable", "Not applicable")]
    .filter((s) => s !== "")
    .join("\n");
  return body === "" ? "" : section("passed", "Passed and not applicable", body);
}

function responseText(ms: number | null): string {
  return ms === null ? NOT_AVAILABLE : `${Math.round(ms)} ms`;
}

function pageRow(page: PageSummary): string {
  const counts = [page.counts.error, page.counts.warning, page.counts.info]
    .map((n) => `<td class="num${n === 0 ? " zero" : ""}">${n}</td>`)
    .join("");
  const status = page.status === null ? "no response" : String(page.status);
  return `<tr><td class="url">${urlCell(page.url, cleanUrl(page.url))}</td><td class="num">${e(status)}</td><td class="num">${e(responseText(page.responseMs))}</td>${counts}</tr>`;
}

function pagesBlock(result: AuditResult): string {
  const table = [
    `<table>`,
    `<thead><tr><th scope="col">Page</th><th scope="col" class="num">Status</th><th scope="col" class="num">Response</th><th scope="col" class="num">Errors</th><th scope="col" class="num">Warnings</th><th scope="col" class="num">Info</th></tr></thead>`,
    `<tbody>\n${result.pages.map(pageRow).join("\n")}\n</tbody>`,
    `</table>`,
  ].join("\n");
  return section("pages", "Pages", tableWrap("Pages crawled", table));
}

function lighthouseBlock(result: AuditResult): string {
  if (result.lighthouse === null) return "";
  const view = lighthouseView(result.lighthouse);
  const first = view.pages[0];
  const parts = [`<p class="note">${e(view.note)}</p>`];
  if (view.version !== null) parts.push(`<p class="note">Version: ${e(view.version)}</p>`);
  if (first !== undefined) {
    const columns = [...first.scores, ...first.metrics].map((c) => c.label);
    const head = ["Page", ...columns]
      .map((c, i) => `<th scope="col"${i === 0 ? "" : ` class="num"`}>${e(c)}</th>`)
      .join("");
    const rows = view.pages
      .map((page, i) => {
        const raw = result.lighthouse?.pages[i]?.url ?? "";
        const values = [...page.scores, ...page.metrics]
          .map((c) => `<td class="num">${e(c.value)}</td>`)
          .join("");
        return `<tr><td class="url">${urlCell(raw, page.url)}</td>${values}</tr>`;
      })
      .join("\n");
    parts.push(
      tableWrap(
        "Lighthouse results",
        `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`,
      ),
    );
  }
  for (const page of view.pages) {
    if (page.error !== null) {
      parts.push(`<p class="notice">Error for ${e(page.url)}: ${e(page.error)}</p>`);
    }
  }
  return section("lighthouse", "Lighthouse", parts.join("\n"));
}

function footerBlock(result: AuditResult): string {
  return `<footer id="footer"><p>${e(`${result.tool.name} ${result.tool.version}`)}</p></footer>`;
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --surface: #f7f8fa;
  --text: #1b1f23;
  --muted: #59626d;
  --border: #e2e5e9;
  --accent: #1d5f8a;
  --error-fg: #a1262c;
  --error-bg: #fcefee;
  --error-line: #e8b9b6;
  --warning-fg: #84500a;
  --warning-bg: #fdf4e1;
  --warning-line: #e8cd98;
  --info-fg: #3b5870;
  --info-bg: #eef3f7;
  --info-line: #c4d3df;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171a;
    --surface: #1b1f23;
    --text: #e6e8eb;
    --muted: #9aa3ad;
    --border: #2c3238;
    --accent: #7db4d8;
    --error-fg: #ff9d98;
    --error-bg: #3a1e1f;
    --error-line: #6d3b3c;
    --warning-fg: #f0bf6e;
    --warning-bg: #38290f;
    --warning-line: #6b5427;
    --info-fg: #a9c5dd;
    --info-bg: #1d2a36;
    --info-line: #38506a;
  }
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 1rem;
  line-height: 1.6;
}

main, header, footer {
  max-width: 62rem;
  margin: 0 auto;
  padding-left: 1rem;
  padding-right: 1rem;
}

header { padding-top: 3rem; padding-bottom: 1rem; }
main { padding-bottom: 2rem; }
footer { padding-top: 2rem; padding-bottom: 3rem; color: var(--muted); font-size: 0.875rem; }
footer p { margin: 0; padding-top: 1rem; border-top: 1px solid var(--border); }

h1, h2, h3 { line-height: 1.25; margin: 0; font-weight: 600; }
h1 { font-size: 1.75rem; overflow-wrap: anywhere; }
h2 { font-size: 1.25rem; margin-bottom: 1rem; }
h3 { font-size: 1.0625rem; margin-bottom: 1rem; }

p { margin: 0 0 0.75rem; }
code { font-family: var(--mono); font-size: 0.8125rem; color: var(--muted); }

a { color: var(--accent); text-underline-offset: 0.15em; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

section { margin-top: 3rem; }
section.group { margin-top: 2rem; }

.eyebrow {
  margin: 0 0 0.5rem;
  color: var(--accent);
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.meta { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; margin: 0.75rem 0 1.5rem; color: var(--muted); font-size: 0.9375rem; }

nav ul { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; margin: 0; padding: 0.75rem 0 0; border-top: 1px solid var(--border); list-style: none; font-size: 0.9375rem; }

.note { color: var(--muted); font-size: 0.9375rem; }

.notice {
  margin: 0 0 1rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  background: var(--surface);
  font-size: 0.9375rem;
}

dl { margin: 0; }
#scope dl > div { display: grid; grid-template-columns: minmax(0, 12rem) minmax(0, 1fr); gap: 0.25rem 1.5rem; padding: 0.5rem 0; border-top: 1px solid var(--border); }
#scope dl > div:last-child { border-bottom: 1px solid var(--border); }
dt { color: var(--muted); font-size: 0.9375rem; }
dd { margin: 0; overflow-wrap: anywhere; }

.table-wrap { overflow-x: auto; max-width: 100%; }
table { width: 100%; border-collapse: collapse; font-size: 0.9375rem; }
th, td { padding: 0.5rem 0.75rem; border-top: 1px solid var(--border); text-align: left; vertical-align: top; }
thead th { border-top: 0; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 0.8125rem; font-weight: 600; white-space: nowrap; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 1px solid var(--border); }
th:first-child, td:first-child { padding-left: 0; }
th:last-child, td:last-child { padding-right: 0; }
tbody th { font-weight: 500; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.zero { color: var(--muted); }
tr.total th, tr.total td { font-weight: 600; }
td.url { min-width: 12rem; }
td.detail { min-width: 14rem; }
td { overflow-wrap: anywhere; }

.sev {
  display: inline-block;
  margin-right: 0.5rem;
  padding: 0 0.5rem;
  border: 1px solid var(--info-line);
  border-radius: 999px;
  background: var(--info-bg);
  color: var(--info-fg);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  line-height: 1.5;
  text-transform: uppercase;
  vertical-align: 0.1em;
}
.sev-error { border-color: var(--error-line); background: var(--error-bg); color: var(--error-fg); }
.sev-warning { border-color: var(--warning-line); background: var(--warning-bg); color: var(--warning-fg); }

.count { color: var(--muted); font-size: 0.875rem; }

ol.fix-first { margin: 0; padding: 0; list-style: none; counter-reset: fix; }
ol.fix-first li { position: relative; margin: 0; padding: 0.75rem 0 0.25rem 2rem; border-top: 1px solid var(--border); counter-increment: fix; }
ol.fix-first li:last-child { border-bottom: 1px solid var(--border); }
ol.fix-first li::before { content: counter(fix); position: absolute; left: 0; top: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.lead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.5rem; margin-bottom: 0.25rem; }
.lead .sev { margin-right: 0; }
.lead strong { font-weight: 600; }

details.check { margin-top: 1rem; border: 1px solid var(--border); border-radius: 6px; }
details.check > summary { padding: 0.75rem 1rem; }
.check-body { padding: 0 1rem 1rem; }
.check-id { margin-bottom: 0.5rem; }
.facts { margin-bottom: 1rem; }
.facts dt { margin-top: 0.5rem; font-size: 0.8125rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.facts dd { margin: 0.125rem 0 0; }
.evidence { margin: 0; padding: 0; list-style: none; }
.evidence li + li { margin-top: 0.25rem; }

summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.5rem; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary::before {
  content: "";
  flex: none;
  align-self: center;
  width: 0;
  height: 0;
  margin-right: 0.25rem;
  border-top: 0.3rem solid transparent;
  border-bottom: 0.3rem solid transparent;
  border-left: 0.45rem solid var(--muted);
}
details[open] > summary::before { border-top: 0.45rem solid var(--muted); border-bottom: 0; border-left: 0.3rem solid transparent; border-right: 0.3rem solid transparent; }
summary .title { font-weight: 600; overflow-wrap: anywhere; }
summary .sev { margin-right: 0; }

details.passed-list { margin-top: 0.75rem; }
details.passed-list > summary { font-weight: 600; }
details.passed-list ul { margin: 0.5rem 0 0; padding: 0; list-style: none; }
details.passed-list li { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; padding: 0.375rem 0; border-top: 1px solid var(--border); }

@media (max-width: 40rem) {
  header { padding-top: 2rem; }
  h1 { font-size: 1.5rem; }
  #scope dl > div { grid-template-columns: minmax(0, 1fr); }
  th, td { padding-left: 0.5rem; padding-right: 0.5rem; }
}

@media print {
  :root {
    --bg: #ffffff;
    --surface: #ffffff;
    --text: #000000;
    --muted: #333333;
    --border: #999999;
    --accent: #000000;
    --error-fg: #000000;
    --error-bg: transparent;
    --error-line: #000000;
    --warning-fg: #000000;
    --warning-bg: transparent;
    --warning-line: #000000;
    --info-fg: #000000;
    --info-bg: transparent;
    --info-line: #000000;
  }
  body { background: none; font-size: 10pt; line-height: 1.45; }
  header, main, footer { max-width: none; padding-left: 0; padding-right: 0; }
  header { padding-top: 0; }
  nav { display: none; }
  a { color: inherit; text-decoration: none; }
  .sev, .notice { background: none; }
  .table-wrap { overflow: visible; }
  details > *:not(summary) { display: block; }
  summary::before { display: none; }
  details.check, tr { break-inside: avoid; }
  h2, h3 { break-after: avoid; }
  section { margin-top: 1.5rem; }
}
`;

/**
 * The HTML report: one self-contained file with inline CSS, no scripts and no external
 * requests. Every string from the audited site is cleaned and then escaped, and a URL becomes
 * a link only when it is http or https.
 */
export function renderHtml(result: AuditResult): string {
  const lighthouse = lighthouseBlock(result);
  const passed = passedBlock(result);
  const nav = [
    { id: "scope", label: "Scope" },
    { id: "summary", label: "Summary" },
    { id: "fix-first", label: "Fix first" },
    { id: "findings", label: "Findings" },
    ...(passed === "" ? [] : [{ id: "passed", label: "Passed checks" }]),
    { id: "pages", label: "Pages" },
    ...(lighthouse === "" ? [] : [{ id: "lighthouse", label: "Lighthouse" }]),
  ];
  const main = [
    scopeBlock(result),
    summaryBlock(result),
    fixFirstBlock(result),
    findingsBlock(result),
    passed,
    pagesBlock(result),
    lighthouse,
  ].filter((s) => s !== "");
  return `${[
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    `<meta name="robots" content="noindex">`,
    `<title>Site audit: ${e(cleanUrl(result.scope.origin))}</title>`,
    `<style>${CSS}</style>`,
    `</head>`,
    `<body>`,
    headerBlock(result, nav),
    `<main>`,
    main.join("\n"),
    `</main>`,
    footerBlock(result),
    `</body>`,
    `</html>`,
  ].join("\n")}\n`;
}
