import { audit, type AuditDeps } from "./audit.js";
import { HELP_TEXT, parseCli, type CliOptions, type Format } from "./args.js";
import { A11Y_NOTICE } from "./checks/accessibility.js";
import { CHECKS } from "./checks/registry.js";
import { UnreachableError, UsageError } from "./errors.js";
import { renderHtml } from "./report/html.js";
import { renderJson } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import { clean, cleanUrl, escapeMarkdownInline } from "./report/sanitise.js";
import { GROUP_TITLES } from "./report/scope.js";
import { renderText } from "./report/text.js";
import { GROUPS, type AuditResult, type CheckDef, type Severity } from "./types.js";
import { VERSION } from "./version.js";

export type Io = {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  writeFile: (path: string, data: string) => Promise<void>;
  isTTY: boolean;
  env: Record<string, string | undefined>;
};

const SEVERITY_RANK: Record<Severity, number> = { error: 2, warning: 1, info: 0 };
const FAIL_RANK: Record<CliOptions["failOn"], number> = { error: 2, warning: 1, never: 3 };

/** 1 when any finding is at or above the `--fail-on` severity, judged by the finding's own severity. */
export function exitCodeFor(result: AuditResult, failOn: CliOptions["failOn"]): 0 | 1 {
  const threshold = FAIL_RANK[failOn];
  const failed = result.checks.some((check) =>
    check.findings.some((finding) => SEVERITY_RANK[finding.severity] >= threshold),
  );
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// check reference

const REFERENCE_INTRO =
  "Every check, grouped by area. The severity shown is the default for the check, and a finding can carry a lower one. A rule of thumb is a practical guide for a threshold, not a standard.";

function checksOf(group: (typeof GROUPS)[number]): readonly CheckDef[] {
  return CHECKS.filter((check) => check.group === group);
}

/** One table cell: a single line, with the characters Markdown reads as syntax escaped. */
function cell(value: string): string {
  return escapeMarkdownInline(value.replace(/\s+/g, " ").trim());
}

function textReference(): string {
  const lines = ["Check reference", ""];
  for (const group of GROUPS) {
    lines.push(GROUP_TITLES[group], "");
    if (group === "accessibility") lines.push(A11Y_NOTICE, "");
    for (const check of checksOf(group)) {
      lines.push(`${check.id} (${check.severity}) ${check.title}`);
      lines.push(`  Why it matters: ${check.why}`);
      lines.push(`  How to fix: ${check.fix}`);
      if (check.heuristic !== null) lines.push(`  Rule of thumb: ${check.heuristic}`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function markdownReference(): string {
  const blocks = ["# Check reference", REFERENCE_INTRO];
  for (const group of GROUPS) {
    blocks.push(`## ${GROUP_TITLES[group]}`);
    if (group === "accessibility") blocks.push(A11Y_NOTICE);
    blocks.push(
      [
        "| Id | Severity | Check | Why it matters | How to fix | Rule of thumb |",
        "| --- | --- | --- | --- | --- | --- |",
        ...checksOf(group).map(
          (check) =>
            `| \`${check.id}\` | ${check.severity} | ${cell(check.title)} | ${cell(check.why)} | ${cell(check.fix)} | ${check.heuristic === null ? "None" : cell(check.heuristic)} |`,
        ),
      ].join("\n"),
    );
  }
  return `${blocks.join("\n\n")}\n`;
}

/** The check reference built from the registry, for `site-audit checks` and docs/checks.md. */
export function renderChecksReference(format: "text" | "markdown"): string {
  return format === "markdown" ? markdownReference() : textReference();
}

// ---------------------------------------------------------------------------
// audit command

const MESSAGE_MAX = 400;

function colourWanted(io: Io, cli: CliOptions): boolean {
  const noColor = io.env.NO_COLOR;
  return (
    io.isTTY &&
    (noColor === undefined || noColor === "") &&
    cli.color !== false &&
    cli.output === null
  );
}

function render(result: AuditResult, format: Format, color: boolean): string {
  switch (format) {
    case "json":
      return renderJson(result);
    case "markdown":
      return renderMarkdown(result);
    case "html":
      return renderHtml(result);
    case "text":
      return renderText(result, { color });
  }
}

/**
 * Runs the command line and returns the exit code: 0 and 1 from the findings, 2 for a usage
 * error, 3 when the start URL could not be audited. Anything unexpected is thrown.
 */
export async function main(argv: string[], io: Io, deps: AuditDeps = {}): Promise<number> {
  let command;
  try {
    command = parseCli(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`site-audit: ${error.message}\nRun site-audit --help for usage.\n`);
    return 2;
  }

  switch (command.kind) {
    case "help":
      io.stdout(HELP_TEXT);
      return 0;
    case "version":
      io.stdout(`${VERSION}\n`);
      return 0;
    case "checks":
      io.stdout(renderChecksReference(command.format));
      return 0;
    case "audit":
      break;
  }

  const { options, cli } = command;
  const progress: AuditDeps["onProgress"] = cli.quiet
    ? deps.onProgress
    : (event) => {
        deps.onProgress?.(event);
        if (event.kind === "page" && event.url !== undefined) {
          io.stderr(`[${event.done}/${options.maxPages}] ${cleanUrl(event.url)}\n`);
        }
      };

  let result: AuditResult;
  try {
    result = await audit(options, { ...deps, onProgress: progress });
  } catch (error) {
    if (!(error instanceof UnreachableError)) throw error;
    io.stderr(`site-audit: ${clean(error.message, MESSAGE_MAX)}\n`);
    return 3;
  }

  const report = render(result, cli.format, colourWanted(io, cli));
  if (cli.output === null) {
    io.stdout(report);
  } else {
    await io.writeFile(cli.output, report);
    io.stderr(`Report written to ${cli.output}\n`);
  }
  return exitCodeFor(result, cli.failOn);
}
