import { parseStartUrl } from "./crawl/url.js";
import { UsageError } from "./errors.js";
import { DEFAULT_OPTIONS, GROUPS, type AuditOptions, type Group } from "./types.js";

export type Format = "text" | "json" | "markdown" | "html";

export type CliOptions = {
  format: Format;
  output: string | null;
  failOn: "error" | "warning" | "never";
  /** `false` when `--no-color` was given, otherwise `null` (decided from the terminal). */
  color: boolean | null;
  quiet: boolean;
};

export type CliCommand =
  | { kind: "audit"; options: AuditOptions; cli: CliOptions }
  | { kind: "checks"; format: "text" | "markdown" }
  | { kind: "help" }
  | { kind: "version" };

export const HELP_TEXT = `Usage:
  site-audit <url> [options]
  site-audit checks [--format text|markdown]
  site-audit --version | --help

Options:
  --format text|json|markdown|html  Report format. Default: text.
  --output FILE                     Write the report to a file instead of stdout. The format
                                    is inferred from .json, .md, .markdown, .html or .htm
                                    when --format is absent.
  --max-pages N                     Stop after N HTML pages, 1 to 2000. Default: ${DEFAULT_OPTIONS.maxPages}.
  --max-depth N                     Link depth from the start URL, 0 to 20. Default: ${DEFAULT_OPTIONS.maxDepth}.
  --concurrency N                   Parallel requests per host, 1 to 8. Default: ${DEFAULT_OPTIONS.concurrency}.
  --delay MS                        Minimum gap between request starts to one host, 0 to 60000.
                                    A larger robots.txt Crawl-delay wins. Default: ${DEFAULT_OPTIONS.delayMs}.
  --timeout MS                      Time limit per request, 1000 to 120000. Default: ${DEFAULT_OPTIONS.timeoutMs}.
  --max-assets N                    Cap on unique asset size probes, 0 to 5000. Default: ${DEFAULT_OPTIONS.maxAssets}.
  --exclude PATTERN                 Skip URLs whose path matches the glob (* and ** only).
                                    Can be repeated.
  --check-external                  Allow requests to other hosts: external link checks and
                                    third-party asset sizes.
  --ignore-robots                   Do not apply robots.txt. For sites you own or have
                                    permission to audit. The report shows a notice.
  --user-agent STRING               Request header. robots.txt matching uses the token
                                    site-audit-cli. Default: ${DEFAULT_OPTIONS.userAgent}
  --only GROUP[,GROUP]              Limit to groups: seo, health, performance, accessibility.
                                    Default: all groups.
  --lighthouse                      Add Lighthouse lab results for the start URL.
  --lighthouse-pages N              Lighthouse pages, 1 to 5. Default: ${DEFAULT_OPTIONS.lighthousePages}.
  --lighthouse-path PATH            Path to an installed lighthouse package folder.
  --fail-on error|warning|never     Which severity makes the exit code 1. Default: error.
  --no-color                        Disable colour. Colour is also off when stdout is not a
                                    terminal, when NO_COLOR is set and not empty, and when
                                    --output is used.
  --quiet                           No progress on stderr.
  --version                         Print the version.
  --help                            Print this help.

The URL must use http or https. A bare host such as example.com is read as
https://example.com/.

Exit codes:
  0  No findings at or above the --fail-on severity.
  1  Findings at or above the --fail-on severity.
  2  Usage error, or an output file that cannot be written.
  3  The start URL could not be audited.
`;

const INTEGER_FLAGS = {
  "--max-pages": { key: "maxPages", min: 1, max: 2000 },
  "--max-depth": { key: "maxDepth", min: 0, max: 20 },
  "--concurrency": { key: "concurrency", min: 1, max: 8 },
  "--delay": { key: "delayMs", min: 0, max: 60000 },
  "--timeout": { key: "timeoutMs", min: 1000, max: 120000 },
  "--max-assets": { key: "maxAssets", min: 0, max: 5000 },
  "--lighthouse-pages": { key: "lighthousePages", min: 1, max: 5 },
} as const;

type IntegerFlag = keyof typeof INTEGER_FLAGS;

const STRING_FLAGS = new Set([
  "--format",
  "--output",
  "--exclude",
  "--user-agent",
  "--only",
  "--lighthouse-path",
  "--fail-on",
]);

const SWITCH_FLAGS = new Set([
  "--check-external",
  "--ignore-robots",
  "--lighthouse",
  "--no-color",
  "--quiet",
]);

const FORMATS: readonly Format[] = ["text", "json", "markdown", "html"];
const FAIL_ON: readonly CliOptions["failOn"][] = ["error", "warning", "never"];

const EXTENSION_FORMATS: Record<string, Format> = {
  ".json": "json",
  ".md": "markdown",
  ".markdown": "markdown",
  ".html": "html",
  ".htm": "html",
};

function isIntegerFlag(flag: string): flag is IntegerFlag {
  return Object.hasOwn(INTEGER_FLAGS, flag);
}

const INTEGER_FLAG_NAMES = Object.keys(INTEGER_FLAGS).filter(isIntegerFlag);

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new UsageError(`${flag} must be one of: ${allowed.join(", ")}.`);
  }
  return found;
}

function parseInteger(flag: IntegerFlag, value: string): number {
  const { min, max } = INTEGER_FLAGS[flag];
  const n = /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`${flag} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function parseOnly(value: string): Group[] {
  const wanted = new Set<string>();
  for (const part of value.split(",")) {
    const name = part.trim();
    if (!GROUPS.some((group) => group === name)) {
      throw new UsageError(`--only must list groups from: ${GROUPS.join(", ")}.`);
    }
    wanted.add(name);
  }
  return GROUPS.filter((group) => wanted.has(group));
}

function formatFromOutput(output: string): Format {
  const dot = output.lastIndexOf(".");
  if (dot === -1) return "text";
  return EXTENSION_FORMATS[output.slice(dot).toLowerCase()] ?? "text";
}

type Parsed = {
  positionals: string[];
  strings: Map<string, string[]>;
  switches: Set<string>;
};

/** Splits the arguments into positionals, value flags and switches. Throws on anything unknown. */
function scan(argv: string[]): Parsed {
  const parsed: Parsed = { positionals: [], strings: new Map(), switches: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("-")) {
      parsed.positionals.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) throw new UsageError(`Unknown option: ${arg}`);
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (SWITCH_FLAGS.has(flag)) {
      if (eq !== -1) throw new UsageError(`${flag} does not take a value.`);
      parsed.switches.add(flag);
      continue;
    }
    if (!STRING_FLAGS.has(flag) && !isIntegerFlag(flag)) {
      throw new UsageError(`Unknown option: ${flag}`);
    }
    let value: string;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${flag} needs a value.`);
      }
      value = next;
      i += 1;
    }
    const seen = parsed.strings.get(flag) ?? [];
    seen.push(value);
    parsed.strings.set(flag, seen);
  }
  return parsed;
}

/** The last value given for a flag, or undefined. */
function last(parsed: Parsed, flag: string): string | undefined {
  return parsed.strings.get(flag)?.at(-1);
}

function parseChecks(parsed: Parsed): CliCommand {
  const extra = [...parsed.strings.keys(), ...parsed.switches].filter((f) => f !== "--format");
  if (extra.length > 0 || parsed.positionals.length > 1) {
    throw new UsageError("The checks command only accepts --format text|markdown.");
  }
  const format = last(parsed, "--format");
  if (format === undefined) return { kind: "checks", format: "text" };
  return { kind: "checks", format: oneOf("--format", format, ["text", "markdown"] as const) };
}

/**
 * Reads the command line. `--help` and `--version` win over everything else, including
 * errors elsewhere in the arguments. Throws UsageError with a one-line message.
 */
export function parseCli(argv: string[]): CliCommand {
  if (argv.includes("--help")) return { kind: "help" };
  if (argv.includes("--version")) return { kind: "version" };

  const parsed = scan(argv);
  if (parsed.positionals[0] === "checks") return parseChecks(parsed);

  const [url, ...rest] = parsed.positionals;
  if (url === undefined) throw new UsageError("Missing the URL to audit.");
  if (rest.length > 0) throw new UsageError("Only one URL can be audited at a time.");

  const options: AuditOptions = {
    ...DEFAULT_OPTIONS,
    exclude: [...(parsed.strings.get("--exclude") ?? [])],
    startUrl: "",
  };
  for (const flag of INTEGER_FLAG_NAMES) {
    const value = last(parsed, flag);
    if (value !== undefined) options[INTEGER_FLAGS[flag].key] = parseInteger(flag, value);
  }

  const only = last(parsed, "--only");
  if (only !== undefined) options.only = parseOnly(only);
  const userAgent = last(parsed, "--user-agent");
  if (userAgent !== undefined) options.userAgent = userAgent;
  const lighthousePath = last(parsed, "--lighthouse-path");
  if (lighthousePath !== undefined) options.lighthousePath = lighthousePath;
  options.checkExternal = parsed.switches.has("--check-external");
  options.ignoreRobots = parsed.switches.has("--ignore-robots");
  options.lighthouse = parsed.switches.has("--lighthouse");
  options.startUrl = parseStartUrl(url);

  const output = last(parsed, "--output") ?? null;
  const format = last(parsed, "--format");
  const failOn = last(parsed, "--fail-on");
  return {
    kind: "audit",
    options,
    cli: {
      format:
        format !== undefined
          ? oneOf("--format", format, FORMATS)
          : output !== null
            ? formatFromOutput(output)
            : "text",
      output,
      failOn: failOn === undefined ? "error" : oneOf("--fail-on", failOn, FAIL_ON),
      color: parsed.switches.has("--no-color") ? false : null,
      quiet: parsed.switches.has("--quiet"),
    },
  };
}
