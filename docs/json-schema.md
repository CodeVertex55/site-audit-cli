# JSON report shape

`--format json` writes one `AuditResult` object. The same object is what `audit()` resolves to when you use the package from code. The JSON is complete: every finding is present and no list is cut short. Characters that are invisible or that a terminal could act on are written as `\u` escapes, so the file parses back to the same values.

## schemaVersion

`schemaVersion` identifies the shape of the file. It is `1` in every 1.x release of the tool. It is raised when a field is removed, renamed or changes meaning. Adding a new field does not raise it, so read the fields you need and ignore the rest.

## Shape

```ts
type Severity = "error" | "warning" | "info";
type Group = "seo" | "health" | "performance" | "accessibility";

type AuditResult = {
  schemaVersion: 1;
  tool: { name: "site-audit-cli"; version: string };
  startedAt: string;
  finishedAt: string;
  scope: Scope;
  summary: {
    byGroup: Record<Group, Record<Severity, number>>;
    checksRun: number;
    checksPassed: number;
    fixFirst: FixFirstItem[];
  };
  checks: CheckResult[];
  pages: PageSummary[];
  lighthouse: LighthouseSection | null;
};

type Scope = {
  startUrl: string;
  origin: string;
  originNote: string | null;
  pagesCrawled: number;
  maxPages: number;
  maxDepth: number;
  uncrawled: number;
  blockedByRobots: string[];
  ignoreRobots: boolean;
  checkExternal: boolean;
  assetsNotMeasured: number;
  delayRaised: boolean;
  groups: Group[];
  notSeen: string[];
};

type FixFirstItem = {
  checkId: string;
  title: string;
  severity: Severity;
  affected: number;
  fix: string;
};

type CheckResult = {
  id: string;
  group: Group;
  severity: Severity;
  title: string;
  why: string;
  fix: string;
  status: "pass" | "fail" | "not-applicable";
  findings: Finding[];
};

type Finding = {
  checkId: string;
  severity: Severity;
  group: Group;
  url: string | null;
  detail: string;
  evidence?: string[];
};

type PageSummary = {
  url: string;
  status: number | null;
  responseMs: number | null;
  counts: Record<Severity, number>;
};

type LighthouseSection = {
  status: "ok" | "not-found" | "failed";
  version: string | null;
  note: string;
  pages: LighthousePage[];
};

type LighthousePage = {
  url: string;
  scores: {
    performance: number | null;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
  };
  metrics: {
    fcpMs: number | null;
    lcpMs: number | null;
    tbtMs: number | null;
    cls: number | null;
    speedIndexMs: number | null;
  };
  error: string | null;
};
```

## Fields

### AuditResult

- `schemaVersion`: the version of this shape. See above.
- `tool`: the name and version of the tool that wrote the report.
- `startedAt`, `finishedAt`: when the audit began and ended, as ISO 8601 timestamps in UTC.
- `scope`: what was audited and what was not.
- `summary`: totals and the list of what to fix first.
- `checks`: one entry for every check that was selected, in the order SEO, health, performance, accessibility.
- `pages`: one entry for every page the crawl recorded.
- `lighthouse`: the optional Lighthouse section, or `null` when `--lighthouse` was not used.

### scope

- `startUrl`: the start URL you gave, normalised.
- `origin`: the origin that was audited. It differs from the origin you typed when the start URL redirected to another origin once.
- `originNote`: a sentence saying so when the origin moved, otherwise `null`.
- `pagesCrawled`: the number of pages crawled, counted against `maxPages`. Responses that are not HTML are recorded but not counted.
- `maxPages`, `maxDepth`: the limits in force.
- `uncrawled`: how many discovered URLs were left in the queue when the limit was reached.
- `blockedByRobots`: URLs that were not fetched because robots.txt disallows them.
- `ignoreRobots`: true when `--ignore-robots` was used.
- `checkExternal`: true when `--check-external` was used.
- `assetsNotMeasured`: how many assets have no measured size, because they are third party without `--check-external`, over the `--max-assets` cap, blocked by robots.txt or `--exclude`, or did not answer with a size.
- `delayRaised`: true when a host kept answering 429 or 503 and its delay was doubled.
- `groups`: the check groups that ran.
- `notSeen`: the fixed list of what a static HTTP audit cannot see.

### summary

- `byGroup`: the number of findings for each group and severity. A finding counts under its own severity, which can be lower than the default severity of its check.
- `checksRun`: the number of checks that were applicable.
- `checksPassed`: the number of checks that found nothing.
- `fixFirst`: up to five failed checks, errors before warnings and then by the number of affected URLs. Info findings are not counted, and a check whose findings are all info is left out.

### fixFirst items

- `checkId`, `title`, `severity`: the check and its default severity.
- `affected`: the number of distinct URLs named by its findings that are not info. All site-level findings count as one.
- `fix`: the plain instruction for the check.

### checks

- `id`: the check id, for example `SEO-TITLE-001`. The ids are listed in [checks.md](checks.md).
- `group`, `severity`, `title`, `why`, `fix`: the same values as in the check reference.
- `status`: `pass` when the check found nothing, `fail` when it has findings, `not-applicable` when it could not run, for example a sitemap check on a site where no HTML page loaded.
- `findings`: what the check found. Empty unless the status is `fail`.

### findings

- `checkId`, `group`: the check the finding belongs to.
- `severity`: the severity of this finding. It can be lower than the default severity of the check.
- `url`: the affected page, or `null` for a finding about the whole site.
- `detail`: one sentence about this finding. Text taken from the audited site is cleaned and the sentence is at most 200 characters.
- `evidence`: up to five extra items, such as pages that link to a broken URL or the assets on a heavy page. Absent when there are none.

### pages

- `url`: the normalised URL the crawler requested.
- `status`: the HTTP status of the final response, or `null` when the fetch failed or was blocked.
- `responseMs`: milliseconds from sending the request to receiving the response headers. It is one measurement from the machine that ran the audit.
- `counts`: how many findings of each severity name this page.

### lighthouse

- `status`: `ok` when at least one page returned scores, `not-found` when Lighthouse could not be located, `failed` when it ran and returned nothing usable.
- `version`: the Lighthouse version, or `null`.
- `note`: a sentence that says the data is one lab run on the machine that ran the audit and varies between runs.
- `pages`: one entry per page that was run.
- `scores`: Lighthouse category scores from 0 to 100, or `null` when a category is missing.
- `metrics`: First Contentful Paint, Largest Contentful Paint, Total Blocking Time and Speed Index in milliseconds, and Cumulative Layout Shift as a unitless number. `null` when missing.
- `error`: why the page failed, or `null`.

Lighthouse values are reported as they are. They do not change any finding, count or exit code.
