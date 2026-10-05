import { VERSION } from "./version.js";

export type Severity = "error" | "warning" | "info";
export type Group = "seo" | "health" | "performance" | "accessibility";

export const GROUPS: readonly Group[] = ["seo", "health", "performance", "accessibility"];

/** The token used to match robots.txt user-agent groups. */
export const ROBOTS_TOKEN = "site-audit-cli";

export type AuditOptions = {
  startUrl: string; // normalised absolute URL
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  delayMs: number;
  timeoutMs: number;
  maxAssets: number;
  exclude: string[];
  checkExternal: boolean;
  ignoreRobots: boolean;
  userAgent: string;
  only: Group[] | null;
  lighthouse: boolean;
  lighthousePages: number;
  lighthousePath: string | null;
};

export const DEFAULT_OPTIONS: Omit<AuditOptions, "startUrl"> = {
  maxPages: 50,
  maxDepth: 3,
  concurrency: 2,
  delayMs: 1000,
  timeoutMs: 15000,
  maxAssets: 300,
  exclude: [],
  checkExternal: false,
  ignoreRobots: false,
  userAgent: `${ROBOTS_TOKEN}/${VERSION} (+https://github.com/CodeVertex55/site-audit-cli)`,
  only: null,
  lighthouse: false,
  lighthousePages: 1,
  lighthousePath: null,
};

export type Hop = { url: string; status: number; location: string | null };

export type FetchFailure =
  | "timeout"
  | "dns"
  | "connection"
  | "tls"
  | "too-many-redirects"
  | "redirect-loop"
  | "blocked-by-robots"
  | "other";

export type PageRecord = {
  url: string; // normalised requested URL
  finalUrl: string; // after redirects
  hops: Hop[]; // empty when no redirect
  status: number | null; // null when the fetch failed
  failure: FetchFailure | null;
  depth: number | "sitemap";
  inSitemap: boolean;
  headers: Record<string, string>; // lower-cased names, final response
  responseMs: number | null;
  totalMs: number | null;
  bytes: number | null; // decoded body bytes
  transferBytes: number | null; // Content-Length when present
  truncated: boolean;
  isHtml: boolean;
  doc: ParsedDocument | null; // extracted facts, not the DOM
  inlinks: string[]; // crawled pages that link here
};

export type ParsedDocument = {
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaRobots: string[]; // lower-cased directives from meta robots and X-Robots-Tag
  canonicals: string[]; // absolute URLs, in document order
  lang: string | null;
  hasViewport: boolean;
  headings: { level: number; text: string }[];
  openGraph: Record<string, string>;
  jsonLd: { ok: boolean; types: string[]; error: string | null }[];
  links: {
    href: string;
    url: string | null;
    text: string;
    internal: boolean;
    rel: string[];
    hasAccessibleName: boolean;
  }[];
  images: {
    src: string | null;
    url: string | null;
    hasAlt: boolean;
    alt: string | null;
    width: boolean;
    height: boolean;
    loading: string | null;
    index: number;
    decorative: boolean;
  }[];
  scripts: {
    url: string | null;
    inHead: boolean;
    async: boolean;
    defer: boolean;
    module: boolean;
    inline: boolean;
  }[];
  stylesheets: { url: string; inHead: boolean; media: string | null }[];
  iconLink: boolean;
  formControls: { tag: string; type: string | null; labelled: boolean; describe: string }[];
  buttons: { hasName: boolean; describe: string }[];
  iframes: { hasTitle: boolean; src: string | null }[];
  wordCount: number; // visible text words, scripts and styles excluded
  mixedContent: string[]; // http: subresource URLs on an https: page
};

export type AssetRecord = {
  url: string;
  kind: "image" | "script" | "stylesheet" | "font" | "other";
  thirdParty: boolean;
  status: number | null;
  bytes: number | null;
  contentType: string | null;
  contentEncoding: string | null;
  cacheControl: string | null;
  measured: boolean;
  usedBy: string[];
};

export type SiteContext = {
  startUrl: string;
  origin: string;
  originNote: string | null;
  robots: {
    status: number | null;
    present: boolean;
    disallowAll: boolean;
    sitemaps: string[];
    crawlDelay: number | null;
    ignored: boolean;
  };
  sitemap: {
    found: boolean;
    urls: string[];
    files: { url: string; status: number | null; ok: boolean; note: string | null }[];
  };
  probes: {
    httpRedirectsToHttps: boolean | null;
    siblingHostRedirects: boolean | null;
    siblingHost: string | null;
    soft404: boolean | null;
    favicon: boolean | null;
  };
  external:
    | {
        url: string;
        status: number | null;
        failure: FetchFailure | null;
        usedBy: string[];
      }[]
    | null; // null when --check-external is off
  pages: PageRecord[];
  assets: AssetRecord[];
  limits: {
    maxPages: number;
    maxDepth: number;
    pagesCrawled: number;
    uncrawled: number;
    blockedByRobots: string[];
    assetsNotMeasured: number;
    delayRaised: boolean;
  };
  options: AuditOptions;
};

export type CheckDef = {
  id: string; // e.g. "SEO-TITLE-001"
  group: Group;
  severity: Severity;
  title: string; // short, shown in reports
  why: string; // one or two sentences: why it matters
  fix: string; // plain instruction
  heuristic: string | null; // the threshold and its reason, when the check uses one
  scope: "page" | "site";
  applies?: (ctx: SiteContext) => boolean; // false means not-applicable; default: at least one HTML page loaded
  run: (ctx: SiteContext) => Finding[];
};

export type Finding = {
  checkId: string;
  severity: Severity;
  group: Group;
  url: string | null; // affected page, or null for site-level
  detail: string; // specific, sanitised, at most 200 characters
  evidence?: string[]; // up to 5 extra items (source pages, asset URLs), each capped
};

export type Scope = {
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
  crawlDelayMs: number | null; // the robots.txt Crawl-delay that was applied, null when none
  groups: Group[];
  notSeen: string[];
};

export type FixFirstItem = {
  checkId: string;
  title: string;
  severity: Severity;
  affected: number;
  fix: string;
};

export type PageSummary = {
  url: string;
  status: number | null;
  responseMs: number | null;
  counts: Record<Severity, number>;
};

export type LighthousePage = {
  url: string;
  scores: {
    performance: number | null;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
  }; // 0 to 100
  metrics: {
    fcpMs: number | null;
    lcpMs: number | null;
    tbtMs: number | null;
    cls: number | null;
    speedIndexMs: number | null;
  };
  error: string | null;
};

export type LighthouseSection = {
  status: "ok" | "not-found" | "failed";
  version: string | null;
  note: string;
  pages: LighthousePage[];
};

export type AuditResult = {
  schemaVersion: 1;
  tool: { name: "site-audit-cli"; version: string };
  startedAt: string;
  finishedAt: string;
  scope: Scope; // what was audited and what was not
  summary: {
    byGroup: Record<Group, Record<Severity, number>>;
    checksRun: number;
    checksPassed: number;
    fixFirst: FixFirstItem[];
  };
  checks: {
    id: string;
    group: Group;
    severity: Severity;
    title: string;
    why: string;
    fix: string;
    status: "pass" | "fail" | "not-applicable";
    findings: Finding[];
  }[];
  pages: PageSummary[]; // url, status, responseMs, findings count by severity
  lighthouse: LighthouseSection | null;
};
