import { htmlPages } from "./checks/helpers.js";
import { runChecks, type CheckOutcome } from "./checks/registry.js";
import { summarise } from "./checks/summary.js";
import { crawlSite, type CrawlDeps } from "./crawl/crawler.js";
import {
  GROUPS,
  type AuditOptions,
  type AuditResult,
  type LighthouseSection,
  type PageSummary,
  type Scope,
  type Severity,
  type SiteContext,
} from "./types.js";
import { VERSION } from "./version.js";

/** What every report says the audit does not see. */
export const NOT_SEEN: readonly string[] = [
  "Content rendered by JavaScript.",
  "Pages behind a login.",
  "Real-user performance.",
  "Anything beyond the page limit.",
];

export type AuditDeps = CrawlDeps & {
  lighthouse?: (urls: string[]) => Promise<LighthouseSection>;
};

/** The scope block every report opens with, taken from the crawl and the options. */
export function buildScope(ctx: SiteContext): Scope {
  return {
    startUrl: ctx.options.startUrl,
    origin: ctx.origin,
    originNote: ctx.originNote,
    pagesCrawled: ctx.limits.pagesCrawled,
    maxPages: ctx.limits.maxPages,
    maxDepth: ctx.limits.maxDepth,
    uncrawled: ctx.limits.uncrawled,
    blockedByRobots: [...ctx.limits.blockedByRobots],
    ignoreRobots: ctx.options.ignoreRobots,
    checkExternal: ctx.options.checkExternal,
    assetsNotMeasured: ctx.limits.assetsNotMeasured,
    delayRaised: ctx.limits.delayRaised,
    crawlDelayMs: ctx.options.ignoreRobots ? null : ctx.robots.crawlDelay,
    groups: [...(ctx.options.only ?? GROUPS)],
    notSeen: [...NOT_SEEN],
  };
}

/** One row per crawled page, counting the findings that name that page. */
function pageSummaries(ctx: SiteContext, checks: CheckOutcome[]): PageSummary[] {
  const counts = new Map<string, Record<Severity, number>>();
  for (const check of checks) {
    for (const f of check.findings) {
      if (f.url === null) continue;
      const row = counts.get(f.url) ?? { error: 0, warning: 0, info: 0 };
      row[f.severity] += 1;
      counts.set(f.url, row);
    }
  }
  return ctx.pages.map((p) => ({
    url: p.url,
    status: p.status,
    responseMs: p.responseMs,
    counts: counts.get(p.url) ?? { error: 0, warning: 0, info: 0 },
  }));
}

/** The start URL, then the next crawled HTML pages that loaded, up to `limit` in all. */
function lighthouseUrls(ctx: SiteContext, limit: number): string[] {
  const urls = [ctx.startUrl];
  for (const page of htmlPages(ctx)) {
    if (urls.length >= limit) break;
    if (!urls.includes(page.finalUrl)) urls.push(page.finalUrl);
  }
  return urls.slice(0, Math.max(1, limit));
}

/** Crawls the site, runs the checks of the chosen groups and returns the result to report on. */
export async function audit(options: AuditOptions, deps: AuditDeps = {}): Promise<AuditResult> {
  const startedAt = new Date().toISOString();
  const ctx = await crawlSite(options, deps);
  const checks = runChecks(ctx, options.only ?? GROUPS);
  const lighthouse =
    options.lighthouse && deps.lighthouse !== undefined
      ? await deps.lighthouse(lighthouseUrls(ctx, options.lighthousePages))
      : null;
  return {
    schemaVersion: 1,
    tool: { name: "site-audit-cli", version: VERSION },
    startedAt,
    finishedAt: new Date().toISOString(),
    scope: buildScope(ctx),
    summary: summarise(checks),
    checks,
    pages: pageSummaries(ctx, checks),
    lighthouse,
  };
}
