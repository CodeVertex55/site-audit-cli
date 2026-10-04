import type { Finding, PageRecord, SiteContext } from "../types.js";
import { defineCheck, htmlPages, type CheckSpec } from "./helpers.js";

const MAX_EVIDENCE = 5;

/** External statuses that usually mean a site refuses automated requests, not a dead link. */
const COULD_NOT_VERIFY = new Set([401, 403, 405, 429, 503]);

function health(spec: Parameters<typeof defineCheck>[1]): CheckSpec {
  return defineCheck("health", spec);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** Pages the crawler actually requested. Records skipped by robots.txt never count. */
function requested(ctx: SiteContext): PageRecord[] {
  return ctx.pages.filter((p) => p.failure !== "blocked-by-robots");
}

/** True when at least one page was requested, not only skipped by robots.txt. */
function anyCrawled(ctx: SiteContext): boolean {
  return requested(ctx).length > 0;
}

/** Statuses a site sends when it is limiting requests. */
function isThrottled(status: number | null): boolean {
  return status === 429 || status === 503;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function describeFailure(page: PageRecord): string {
  if (page.failure !== null) return `The request failed (${page.failure}).`;
  return `The URL returns status ${page.status ?? "unknown"}.`;
}

// ---------------------------------------------------------------------------
// security headers

type HeaderRule = {
  id: string;
  severity: "warning" | "info";
  title: string;
  why: string;
  fix: string;
  header: string;
  /** True when the page's headers satisfy the rule. */
  has: (headers: Record<string, string>) => boolean;
  httpsOnly: boolean;
};

function headerOf(headers: Record<string, string>, name: string): string | null {
  const value = headers[name];
  return value === undefined ? null : value;
}

const HEADER_RULES: HeaderRule[] = [
  {
    id: "HEALTH-HDR-050",
    severity: "warning",
    title: "No Strict-Transport-Security header",
    why: "Without this header, browsers may still try plain HTTP first, which leaves a window for downgrade attacks.",
    fix: "Send Strict-Transport-Security with a max-age of at least six months on every HTTPS response.",
    header: "Strict-Transport-Security",
    has: (h) => headerOf(h, "strict-transport-security") !== null,
    httpsOnly: true,
  },
  {
    id: "HEALTH-HDR-051",
    severity: "info",
    title: "No Content-Security-Policy header",
    why: "A content security policy limits where scripts and other resources can load from, which reduces the damage of injected code.",
    fix: "Add a Content-Security-Policy header. Start in report-only mode if the site loads many third-party resources.",
    header: "Content-Security-Policy",
    has: (h) => headerOf(h, "content-security-policy") !== null,
    httpsOnly: false,
  },
  {
    id: "HEALTH-HDR-052",
    severity: "warning",
    title: "No X-Content-Type-Options nosniff header",
    why: "Without nosniff, some browsers guess file types and may run a file as a script when it was not meant to be one.",
    fix: "Send X-Content-Type-Options: nosniff on every response.",
    header: "X-Content-Type-Options: nosniff",
    has: (h) => (headerOf(h, "x-content-type-options") ?? "").toLowerCase().includes("nosniff"),
    httpsOnly: false,
  },
  {
    id: "HEALTH-HDR-053",
    severity: "info",
    title: "No Referrer-Policy header",
    why: "Without a policy, browsers decide how much of the page address is shared with other sites when a visitor clicks a link.",
    fix: "Send a Referrer-Policy header such as strict-origin-when-cross-origin.",
    header: "Referrer-Policy",
    has: (h) => headerOf(h, "referrer-policy") !== null,
    httpsOnly: false,
  },
  {
    id: "HEALTH-HDR-054",
    severity: "info",
    title: "No clickjacking protection",
    why: "Without X-Frame-Options or a frame-ancestors rule, other sites can embed the page in a frame and trick visitors into clicking hidden controls.",
    fix: "Send X-Frame-Options or add a frame-ancestors rule to the Content-Security-Policy.",
    header: "X-Frame-Options or CSP frame-ancestors",
    has: (h) =>
      headerOf(h, "x-frame-options") !== null ||
      (headerOf(h, "content-security-policy") ?? "").toLowerCase().includes("frame-ancestors"),
    httpsOnly: false,
  },
];

/** The start page: the HTML page whose requested or final URL is the audit's start URL. */
function startPage(ctx: SiteContext): PageRecord | undefined {
  const pages = htmlPages(ctx);
  return (
    pages.find((p) => p.url === ctx.startUrl) ?? pages.find((p) => p.finalUrl === ctx.startUrl)
  );
}

function headerCheck(rule: HeaderRule): CheckSpec {
  const isHttps = (ctx: SiteContext): boolean => ctx.origin.startsWith("https://");
  return health({
    id: rule.id,
    severity: rule.severity,
    scope: "site",
    title: rule.title,
    why: rule.why,
    fix: rule.fix,
    heuristic: null,
    applies: (ctx) => startPage(ctx) !== undefined && (!rule.httpsOnly || isHttps(ctx)),
    run: (ctx, emit) => {
      const start = startPage(ctx);
      if (start === undefined || rule.has(start.headers)) return [];
      const others = htmlPages(ctx).filter((p) => p !== start && !rule.has(p.headers)).length;
      return [
        emit(
          null,
          `The start page has no ${rule.header} header. ${others} other ${plural(others, "page also lacks it", "pages also lack it")}.`,
        ),
      ];
    },
  });
}

// ---------------------------------------------------------------------------

export const HEALTH_CHECKS: CheckSpec[] = [
  health({
    id: "HEALTH-LINK-001",
    severity: "error",
    scope: "page",
    title: "Broken internal link",
    why: "Visitors and search engines who follow the link reach an error page instead of content.",
    fix: "Fix the link to point at a working page, or restore the missing page and redirect it if it moved.",
    heuristic:
      "Statuses 429 and 503 are reported as could not verify (info), because the site was limiting requests.",
    applies: anyCrawled,
    run: (ctx, emit) =>
      requested(ctx)
        .filter((p) => p.inlinks.length > 0 && (p.failure !== null || (p.status ?? 0) >= 400))
        .map((p): Finding => {
          if (p.failure === null && isThrottled(p.status)) {
            return {
              ...emit(
                p.url,
                `Could not verify (status ${p.status ?? "unknown"}). The site was limiting requests during the audit.`,
                p.inlinks,
              ),
              severity: "info",
            };
          }
          return emit(p.url, describeFailure(p), p.inlinks);
        }),
  }),
  health({
    id: "HEALTH-LINK-002",
    severity: "warning",
    scope: "page",
    title: "Internal link points at a redirect",
    why: "Each redirect adds a round trip for visitors and crawlers.",
    fix: "Update the link to point straight at the final address.",
    heuristic: null,
    applies: anyCrawled,
    run: (ctx, emit) =>
      requested(ctx)
        .filter(
          (p) =>
            p.inlinks.length > 0 && p.hops.length >= 1 && p.failure === null && p.status === 200,
        )
        .map((p) => emit(p.url, `Redirects to ${p.finalUrl}`, p.inlinks)),
  }),
  health({
    id: "HEALTH-REDIR-010",
    severity: "warning",
    scope: "page",
    title: "Redirect chain has more than one hop",
    why: "Every extra hop slows the page down and gives crawlers another chance to give up.",
    fix: "Redirect the first address straight to the final address.",
    heuristic: null,
    applies: anyCrawled,
    run: (ctx, emit) =>
      requested(ctx)
        .filter((p) => p.hops.length > 1)
        .map((p) =>
          emit(
            p.url,
            `Redirect chain of ${p.hops.length} hops ending at ${p.finalUrl}.`,
            p.hops.map((h) => h.url),
          ),
        ),
  }),
  health({
    id: "HEALTH-REDIR-011",
    severity: "error",
    scope: "page",
    title: "Redirect loop or too many redirects",
    why: "Browsers and crawlers give up on a loop, so the page cannot be reached at all.",
    fix: "Remove the redirect that points back at an earlier address in the chain.",
    heuristic:
      "Fails on a loop, or on a chain of more than 10 hops, which the crawler stops following.",
    applies: anyCrawled,
    run: (ctx, emit) =>
      requested(ctx)
        .filter((p) => p.failure === "redirect-loop" || p.failure === "too-many-redirects")
        .map((p) =>
          emit(
            p.url,
            p.failure === "redirect-loop"
              ? "The redirects form a loop."
              : "The redirect chain is longer than 10 hops.",
            p.hops.map((h) => h.url),
          ),
        ),
  }),
  health({
    id: "HEALTH-HTTPS-020",
    severity: "error",
    scope: "site",
    title: "HTTP is not upgraded to HTTPS",
    why: "Plain HTTP traffic can be read and changed on the way, and browsers label such sites as not secure.",
    fix: "Install a certificate, serve the site over HTTPS, and redirect every HTTP address to its HTTPS version.",
    heuristic: null,
    // On an HTTPS origin the check needs the http probe's answer; without one it cannot judge.
    applies: (ctx) => ctx.origin.startsWith("http://") || ctx.probes.httpRedirectsToHttps !== null,
    run: (ctx, emit) => {
      if (ctx.origin.startsWith("http://")) {
        return [emit(null, "The site is served over plain HTTP.")];
      }
      if (ctx.probes.httpRedirectsToHttps === false) {
        const host = hostnameOf(ctx.origin) ?? ctx.origin;
        return [emit(null, `http://${host}/ answers without redirecting to HTTPS.`)];
      }
      return [];
    },
  }),
  health({
    id: "HEALTH-HTTPS-021",
    severity: "error",
    scope: "page",
    title: "Mixed content on an HTTPS page",
    why: "Browsers block or warn about resources loaded over HTTP on a secure page, so the page can look broken.",
    fix: "Change the resource addresses to HTTPS, or remove them.",
    heuristic: null,
    run: (ctx, emit) =>
      htmlPages(ctx).flatMap((p) => {
        const mixed = p.doc?.mixedContent ?? [];
        if (mixed.length === 0) return [];
        return [
          emit(
            p.url,
            `${mixed.length} ${plural(mixed.length, "resource loads", "resources load")} over HTTP.`,
            mixed.slice(0, MAX_EVIDENCE),
          ),
        ];
      }),
  }),
  health({
    id: "HEALTH-HTTPS-022",
    severity: "warning",
    scope: "page",
    title: "HTTPS page links to an internal page over HTTP",
    why: "Visitors who follow the link leave the secure version of the site and may hit an extra redirect.",
    fix: "Change the link to use https://.",
    heuristic: null,
    run: (ctx, emit) => {
      const host = hostnameOf(ctx.origin);
      return htmlPages(ctx).flatMap((p) => {
        if (!p.finalUrl.startsWith("https://")) return [];
        const urls = (p.doc?.links ?? []).flatMap((l) =>
          l.url !== null && l.url.startsWith("http://") && hostnameOf(l.url) === host
            ? [l.url]
            : [],
        );
        if (urls.length === 0) return [];
        return [
          emit(
            p.url,
            `${urls.length} internal ${plural(urls.length, "link uses", "links use")} http://.`,
            urls,
          ),
        ];
      });
    },
  }),
  health({
    id: "HEALTH-HOST-023",
    severity: "warning",
    scope: "site",
    title: "www and apex hosts both answer without a redirect",
    why: "Two hosts serving the same site can split links and ranking signals between them, and create duplicate pages.",
    fix: "Pick one host as the main one and redirect the other to it.",
    heuristic: null,
    applies: (ctx) => ctx.probes.siblingHost !== null && ctx.probes.siblingHostRedirects !== null,
    run: (ctx, emit) => {
      if (ctx.probes.siblingHostRedirects !== false) return [];
      const sibling = ctx.probes.siblingHost ?? "the other host";
      const host = hostnameOf(ctx.origin) ?? ctx.origin;
      return [
        emit(null, `Both ${host} and ${sibling} answer without one redirecting to the other.`),
      ];
    },
  }),
  health({
    id: "HEALTH-404-030",
    severity: "warning",
    scope: "site",
    title: "Missing pages return 200 (soft 404)",
    why: "Search engines may index error pages as real content, and broken links are harder to find.",
    fix: "Make the server return status 404 for addresses that do not exist.",
    heuristic: null,
    applies: (ctx) => ctx.probes.soft404 !== null,
    run: (ctx, emit) =>
      ctx.probes.soft404 === true
        ? [emit(null, "A request for a path that does not exist returned status 200.")]
        : [],
  }),
  health({
    id: "HEALTH-FAV-040",
    severity: "info",
    scope: "site",
    title: "No favicon",
    why: "Browsers ask for a favicon to show in tabs and bookmarks. Without one they show a generic icon, and the requests end in 404 errors.",
    fix: "Add a favicon link to the page head, or serve a file at /favicon.ico.",
    heuristic: null,
    applies: (ctx) => ctx.probes.favicon !== null,
    run: (ctx, emit) =>
      ctx.probes.favicon === false
        ? [emit(null, "No favicon link in the pages and no /favicon.ico file.")]
        : [],
  }),
  ...HEADER_RULES.map(headerCheck),
  health({
    id: "HEALTH-EXT-060",
    severity: "warning",
    scope: "site",
    title: "Broken external link",
    why: "Links that lead nowhere frustrate visitors and make the site look neglected.",
    fix: "Update or remove the link.",
    heuristic:
      "Statuses 401, 403, 405, 429 and 503, and any status outside 100 to 599, are reported as could not verify (info), because many sites refuse automated requests.",
    applies: (ctx) => ctx.external !== null,
    run: (ctx, emit) =>
      (ctx.external ?? []).flatMap((e): Finding[] => {
        if (e.failure !== null) {
          return [emit(e.url, `The request failed (${e.failure}).`, e.usedBy)];
        }
        const status = e.status;
        if (status === null) return [];
        const nonStandard = status < 100 || status > 599;
        if (!nonStandard && status < 400) return [];
        if (nonStandard || COULD_NOT_VERIFY.has(status)) {
          return [
            {
              ...emit(
                e.url,
                `Could not verify (status ${status}). Many sites refuse automated requests.`,
                e.usedBy,
              ),
              severity: "info",
            },
          ];
        }
        return [emit(e.url, `The link returns status ${status}.`, e.usedBy)];
      }),
  }),
  health({
    id: "HEALTH-FETCH-070",
    severity: "warning",
    scope: "page",
    title: "Page timed out or was cut short",
    why: "The audit only saw part of the page, and slow pages are also slow for visitors and crawlers.",
    fix: "Check the server for slow responses, and reduce the page size if it hit the size cap.",
    heuristic: null,
    applies: anyCrawled,
    run: (ctx, emit) =>
      requested(ctx)
        .filter((p) => p.failure === "timeout" || p.truncated)
        .map((p) =>
          emit(
            p.url,
            p.failure === "timeout"
              ? "The page timed out before it finished loading."
              : "The page body was truncated, so only part of it was audited.",
          ),
        ),
  }),
];
