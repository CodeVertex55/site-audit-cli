import { randomBytes } from "node:crypto";
import { UnreachableError } from "../errors.js";
import {
  ROBOTS_TOKEN,
  type AssetRecord,
  type AuditOptions,
  type FetchFailure,
  type Hop,
  type PageRecord,
  type SiteContext,
} from "../types.js";
import { extractWithStatus } from "./extract.js";
import { Fetcher, type FetchResult } from "./fetcher.js";
import { HostGate, type Clock } from "./ratelimit.js";
import {
  crawlDelayMs,
  disallowsEverything,
  isAllowed,
  parseRobots,
  type RobotsFile,
} from "./robots.js";
import { parseSitemap } from "./sitemap.js";
import {
  isExcluded,
  normaliseUrl,
  originOf,
  pathWithQuery,
  sameOrigin,
  siblingHost,
} from "./url.js";

export type CrawlDeps = {
  fetchImpl?: typeof fetch;
  clock?: Clock;
  onProgress?: (event: {
    kind: "page" | "asset" | "external" | "note";
    url?: string;
    done: number;
    message?: string;
  }) => void;
};

type Say = NonNullable<CrawlDeps["onProgress"]>;

const MAX_SITEMAP_FILES = 5;
const MAX_SITEMAP_URLS = 5000;
const MAX_ROBOTS_CHARS = 512 * 1024;
const BLOCKED_CODE = "SITE_AUDIT_BLOCKED";

type BlockReason = "origin" | "shift" | "excluded" | "robots";

type RobotsState = {
  file: RobotsFile | null;
  summary: SiteContext["robots"];
  /** The Crawl-delay for this tool in milliseconds, already clamped; null when none. */
  delayMs: number | null;
  clamped: boolean;
  /** Set when robots.txt could not be read: a network failure or a 5xx answer. */
  unreadable: string | null;
};

type Opened = {
  requested: string;
  origin: string;
  originNote: string | null;
  robots: RobotsState;
  start: FetchResult;
};

type Fetchers = {
  /** Audit host, no guards. Only for the http variant probe, which follows no redirect. */
  main: Fetcher;
  /** Audit origin, never leaves the origin or enters robots-disallowed or excluded paths. */
  crawl: Fetcher;
  /** Every other host: one request at a time per host. */
  other: Fetcher;
};

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function isHtmlType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function isThrottled(status: number | null): boolean {
  return status === 429 || status === 503;
}

function mediaTypeOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const mediaType = (value.split(";")[0] ?? "").trim().toLowerCase();
  return mediaType === "" ? null : mediaType;
}

type Verdict = BlockReason | null | Promise<BlockReason | null>;

/** A fetch that refuses, before touching the network, any URL the verdict function blocks. */
function guardedFetch(
  base: typeof fetch,
  reasonFor: (url: string) => Verdict,
  blockedAt: Map<string, BlockReason>,
): typeof fetch {
  return async (input, init) => {
    const url = urlOf(input);
    const reason = await reasonFor(url);
    if (reason === null) return base(input, init);
    blockedAt.set(url, reason);
    throw Object.assign(new Error(`Request not sent: ${reason}`), { code: BLOCKED_CODE });
  };
}

/** How fetchers are made: the shared fetch and gates, plus a way to add a guard. */
type Net = {
  baseFetch: typeof fetch;
  gate: HostGate;
  otherGate: HostGate;
  make: (fetchImpl: typeof fetch, gate: HostGate) => Fetcher;
};

/**
 * Sends the audit host through the audit gate and every other host through the one-at-a-time
 * gate, so a redirect to a sibling host is paced like any other host.
 */
class RoutedGate extends HostGate {
  private readonly primary: HostGate;
  private readonly secondary: HostGate;
  private readonly primaryHost: string;

  constructor(primary: HostGate, secondary: HostGate, primaryHost: string) {
    super({ delayMs: 0, concurrency: 1 });
    this.primary = primary;
    this.secondary = secondary;
    this.primaryHost = primaryHost;
  }

  private pick(host: string): HostGate {
    return host === this.primaryHost ? this.primary : this.secondary;
  }

  override acquire(host: string): Promise<() => void> {
    return this.pick(host).acquire(host);
  }

  override setMinDelay(host: string, ms: number): void {
    this.pick(host).setMinDelay(host, ms);
  }

  override doubleDelay(host: string): boolean {
    return this.pick(host).doubleDelay(host);
  }

  override delayFor(host: string): number {
    return this.pick(host).delayFor(host);
  }
}

/**
 * Same site as the origin: the same hostname, or its www or apex sibling, on the same port or
 * the scheme's default port. So http to https and www to apex count, another host does not.
 */
function sameSite(url: string, origin: string): boolean {
  try {
    const target = new URL(url);
    const base = new URL(origin);
    const host =
      target.hostname === base.hostname || target.hostname === siblingHost(base.hostname);
    return host && (target.port === "" || target.port === base.port);
  } catch {
    return false;
  }
}

/** A fetcher that follows redirects only while they stay on the origin's site. */
function siteOnly(net: Net, origin: string): Fetcher {
  const gate = new RoutedGate(net.gate, net.otherGate, new URL(origin).host);
  const reasonFor = (url: string): BlockReason | null => (sameSite(url, origin) ? null : "origin");
  return net.make(guardedFetch(net.baseFetch, reasonFor, new Map()), gate);
}

/** True when a fetch failed because a redirect led to a different site and was not followed. */
function leftSite(r: FetchResult, origin: string): boolean {
  return r.failure === "other" && r.hops.length > 0 && !sameSite(r.finalUrl, origin);
}

function lastHopStatus(r: FetchResult): number | null {
  return r.hops[r.hops.length - 1]?.status ?? null;
}

/** Runs `fn` over the items with at most `limit` in flight, starting them in order. */
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = items[next];
      next += 1;
      if (item === undefined) return;
      await fn(item);
    }
  };
  const count = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: count }, worker));
}

// ---------------------------------------------------------------------------
// robots.txt and opening the site

function robotsSummary(
  status: number | null,
  present: boolean,
  ignored: boolean,
): SiteContext["robots"] {
  return {
    status,
    present,
    disallowAll: false,
    sitemaps: [],
    crawlDelay: null,
    ignored,
  };
}

/** Fetches and parses `<origin>/robots.txt`. A 4xx answer means there is no file. */
async function loadRobots(
  fetcher: Fetcher,
  origin: string,
  options: AuditOptions,
): Promise<RobotsState> {
  const r = await fetcher.get(`${origin}/robots.txt`);
  const ignored = options.ignoreRobots;
  const movedAway = leftSite(r, origin);
  const none = (unreadable: string | null): RobotsState => ({
    file: null,
    summary: robotsSummary(movedAway ? lastHopStatus(r) : r.status, false, ignored),
    delayMs: null,
    clamped: false,
    unreadable,
  });
  if (movedAway) return none("it redirected to a different site");
  if (r.status === null) return none(r.failure ?? "other");
  if (r.status >= 500) return none(`status ${r.status}`);
  if (r.status < 200 || r.status >= 300) return none(null);

  const file = parseRobots((r.body ?? "").slice(0, MAX_ROBOTS_CHARS));
  const delay = crawlDelayMs(file, ROBOTS_TOKEN);
  return {
    file,
    summary: {
      status: r.status,
      present: true,
      disallowAll: disallowsEverything(file),
      sitemaps: file.sitemaps
        .map((entry) => normaliseUrl(entry, origin))
        .filter((entry): entry is string => entry !== null),
      crawlDelay: delay.ms,
      ignored,
    },
    delayMs: delay.ms,
    clamped: delay.clamped,
    unreadable: null,
  };
}

function robotsAllows(robots: RobotsState, url: string): boolean {
  return robots.file === null || isAllowed(robots.file, ROBOTS_TOKEN, pathWithQuery(url));
}

/** Throws when robots.txt is unreadable or disallows the URL, unless robots are ignored. */
function enforceRobots(
  robots: RobotsState,
  origin: string,
  url: string | null,
  options: AuditOptions,
): void {
  if (options.ignoreRobots) return;
  if (robots.unreadable !== null) {
    if (robots.summary.status === null) {
      throw new UnreachableError(`Could not reach ${origin} (${robots.unreadable}).`);
    }
    throw new UnreachableError(
      `robots.txt could not be read at ${origin} (${robots.unreadable}). The site is treated as disallowed. Use --ignore-robots only for a site you own.`,
    );
  }
  if (url !== null && !robotsAllows(robots, url)) {
    throw new UnreachableError(
      `robots.txt disallows ${url}. Use --ignore-robots only for a site you own.`,
    );
  }
}

function applyCrawlDelay(
  gate: HostGate,
  origin: string,
  robots: RobotsState,
  options: AuditOptions,
  say: Say,
): void {
  if (options.ignoreRobots || robots.delayMs === null) return;
  gate.setMinDelay(new URL(origin).host, robots.delayMs);
  if (robots.clamped) {
    say({
      kind: "note",
      done: 0,
      message: "robots.txt asks for a Crawl-delay above 30 seconds. It was clamped to 30 seconds.",
    });
  }
}

/** Throws the right UnreachableError for a start fetch that failed. */
function failStart(
  start: FetchResult,
  blockedAt: Map<string, BlockReason>,
  robotsFor: (origin: string) => RobotsState | undefined,
  options: AuditOptions,
): never {
  const reason = start.failure === "other" ? blockedAt.get(start.finalUrl) : undefined;
  const blockedOrigin = originOf(start.finalUrl);
  if (reason === "robots") {
    const state = robotsFor(blockedOrigin);
    if (state !== undefined) enforceRobots(state, blockedOrigin, start.finalUrl, options);
  }
  if (reason === "excluded") {
    throw new UnreachableError(
      `The start URL redirects to ${start.finalUrl}, which matches an --exclude pattern.`,
    );
  }
  if (reason === "origin") {
    throw new UnreachableError(
      `The start URL redirects across several hosts. It was not followed to ${start.finalUrl}.`,
    );
  }
  throw new UnreachableError(`Could not reach ${start.url} (${start.failure ?? "other"}).`);
}

/**
 * Reads robots.txt, fetches the start URL and works out the audit origin. robots.txt comes
 * first, so a Crawl-delay applies from the first page request and a disallowed start URL is
 * never requested. Every hop of the start URL's redirect chain is checked before it is sent:
 * it must not match --exclude or be disallowed by robots.txt. A hop to another origin is allowed
 * once, as the move of the audit origin, and only after that origin's robots.txt has been read.
 * That read happens between two fetches, never inside a request that holds a gate slot.
 */
async function openSite(
  options: AuditOptions,
  net: Net,
  gate: HostGate,
  say: Say,
): Promise<Opened> {
  const requested = normaliseUrl(options.startUrl) ?? options.startUrl;
  const requestedOrigin = originOf(requested);
  const robotsByOrigin = new Map<string, RobotsState>();
  const blockedAt = new Map<string, BlockReason>();

  const requestedRobots = await loadRobots(
    siteOnly(net, requestedOrigin),
    requestedOrigin,
    options,
  );
  robotsByOrigin.set(requestedOrigin, requestedRobots);
  enforceRobots(requestedRobots, requestedOrigin, requested, options);
  applyCrawlDelay(gate, requestedOrigin, requestedRobots, options, say);

  let currentOrigin = requestedOrigin;
  const verdict = (url: string): BlockReason | null => {
    if (url === requested) return null;
    if (originOf(url) !== currentOrigin)
      return currentOrigin === requestedOrigin ? "shift" : "origin";
    if (isExcluded(url, options.exclude)) return "excluded";
    const state = robotsByOrigin.get(currentOrigin);
    if (!options.ignoreRobots && state !== undefined) {
      if (state.unreadable !== null || !robotsAllows(state, url)) return "robots";
    }
    return null;
  };
  const startFetcher = net.make(guardedFetch(net.baseFetch, verdict, blockedAt), net.gate);

  const hops: Hop[] = [];
  let start = await startFetcher.get(requested);
  hops.push(...start.hops);
  if (start.failure === "other" && blockedAt.get(start.finalUrl) === "shift") {
    // The move happens once: the entry is cleared, and a later hop to a third origin is refused.
    const shifted = start.finalUrl;
    blockedAt.delete(shifted);
    const next = originOf(shifted);
    robotsByOrigin.set(next, await loadRobots(siteOnly(net, next), next, options));
    currentOrigin = next;
    start = await startFetcher.get(shifted);
    hops.push(...start.hops);
  }
  start = { ...start, url: requested, hops };
  if (start.status === null) failStart(start, blockedAt, (o) => robotsByOrigin.get(o), options);
  const origin = originOf(start.finalUrl);
  const robots = robotsByOrigin.get(origin) ?? requestedRobots;
  if (origin !== requestedOrigin) applyCrawlDelay(gate, origin, robots, options, say);
  if (start.status >= 400) {
    throw new UnreachableError(`The start URL answered with status ${start.status}.`);
  }
  if (!isHtmlType(start.contentType)) {
    throw new UnreachableError(
      `The start URL did not return an HTML page (content type ${start.contentType ?? "unknown"}).`,
    );
  }

  const originNote = origin === requestedOrigin ? null : `Start URL redirected to ${origin}/`;
  if (originNote !== null) say({ kind: "note", done: 0, message: originNote });
  return { requested, origin, originNote, robots, start };
}

// ---------------------------------------------------------------------------
// sitemaps

type SitemapFile = SiteContext["sitemap"]["files"][number];

/** Reads sitemaps from robots.txt, else `/sitemap.xml`. An index is followed one level. */
async function loadSitemaps(
  fetcher: Fetcher,
  origin: string,
  named: string[],
  say: Say,
): Promise<SiteContext["sitemap"]> {
  const candidates = named.length > 0 ? named : [`${origin}/sitemap.xml`];
  const pending = [...new Set(candidates)].map((url) => ({ url, level: 0 }));
  const files: SitemapFile[] = [];
  const urls: string[] = [];
  const known = new Set<string>();

  const record = (url: string, status: number | null, ok: boolean, note: string | null): void => {
    files.push({ url, status, ok, note });
  };

  while (pending.length > 0 && files.length < MAX_SITEMAP_FILES) {
    const item = pending.shift();
    if (item === undefined) break;
    if (!sameSite(item.url, origin)) {
      record(item.url, null, false, "on a different site, not read");
      continue;
    }
    if (new URL(item.url).pathname.toLowerCase().endsWith(".gz")) {
      record(item.url, null, false, "gzip sitemaps are skipped");
      say({ kind: "note", url: item.url, done: 0, message: "Skipped a gzip sitemap." });
      continue;
    }
    const r = await fetcher.get(item.url);
    if (r.status === null) {
      if (leftSite(r, origin)) {
        record(item.url, lastHopStatus(r), false, "redirected to a different site, not read");
      } else {
        record(item.url, null, false, r.failure ?? "other");
      }
      continue;
    }
    if (r.status !== 200) {
      record(item.url, r.status, false, `status ${r.status}`);
      continue;
    }
    const parsed =
      r.body === null
        ? { kind: "invalid" as const, urls: [] }
        : parseSitemap(r.body, Math.max(1, MAX_SITEMAP_URLS - urls.length));
    if (parsed.kind === "invalid") {
      record(item.url, r.status, false, "invalid");
    } else if (parsed.kind === "index") {
      if (item.level === 0) {
        record(item.url, r.status, true, null);
        for (const child of parsed.urls) pending.push({ url: child, level: 1 });
      } else {
        record(item.url, r.status, false, "nested sitemap index not followed");
      }
    } else {
      record(item.url, r.status, true, null);
      for (const url of parsed.urls) {
        if (urls.length >= MAX_SITEMAP_URLS) break;
        if (!sameOrigin(url, origin) || known.has(url)) continue;
        known.add(url);
        urls.push(url);
      }
    }
  }
  return { found: files.some((file) => file.ok), urls, files };
}

// ---------------------------------------------------------------------------
// pages

type QueueItem = { url: string; depth: number | "sitemap"; seq: number };

type CrawlArgs = {
  options: AuditOptions;
  origin: string;
  fetcher: Fetcher;
  start: FetchResult;
  startUrl: string;
  sitemapUrls: string[];
  sitemapSet: Set<string>;
  robotsBlocks: (url: string) => boolean;
  blockedAt: Map<string, BlockReason>;
  say: Say;
};

type CrawlOutcome = {
  pages: PageRecord[];
  blockedByRobots: string[];
  pagesCrawled: number;
  uncrawled: number;
};

function newRecord(
  url: string,
  depth: number | "sitemap",
  inSitemap: boolean,
  r: FetchResult,
): PageRecord {
  return {
    url,
    finalUrl: r.finalUrl,
    hops: r.hops,
    status: r.status,
    failure: r.failure,
    depth,
    inSitemap,
    headers: r.headers,
    responseMs: r.responseMs,
    totalMs: r.totalMs,
    bytes: r.bytes,
    transferBytes: r.transferBytes,
    truncated: r.truncated,
    isHtml: r.status !== null && isHtmlType(r.contentType),
    doc: null,
    inlinks: [],
  };
}

/** Parses the body of a successful HTML response and flags a page cut short by the nesting guard or the text-read budget. */
function attachDocument(record: PageRecord, r: FetchResult): void {
  const status = r.status;
  if (status === null || status < 200 || status >= 300) return;
  if (r.body === null || !isHtmlType(r.contentType)) return;
  const extracted = extractWithStatus(r.body, record.finalUrl, r.headers);
  record.doc = extracted.doc;
  if (extracted.truncated) record.truncated = true;
}

/**
 * Breadth-first crawl with a worker pool. Linked pages come first, then sitemap URLs that no
 * link reached. A redirecting URL keeps its own record, and when its target is new the target
 * becomes a record of its own from the same response, so nothing is requested twice.
 */
async function crawlPages(a: CrawlArgs): Promise<CrawlOutcome> {
  const { options, say } = a;
  const seen = new Set<string>([a.startUrl]);
  const queue: QueueItem[] = [];
  const found: { record: PageRecord; order: number }[] = [];
  const blocked: string[] = [];
  const blockedSet = new Set<string>();
  let seq = 1;
  let counted = 0;

  const block = (url: string): void => {
    if (blockedSet.has(url)) return;
    blockedSet.add(url);
    blocked.push(url);
  };

  const enqueue = (url: string, depth: number | "sitemap"): void => {
    if (seen.has(url) || !sameOrigin(url, a.origin)) return;
    if (typeof depth === "number" && depth > options.maxDepth) return;
    seen.add(url);
    if (isExcluded(url, options.exclude)) return;
    if (a.robotsBlocks(url)) {
      block(url);
      return;
    }
    queue.push({ url, depth, seq });
    seq += 1;
  };

  const follow = (record: PageRecord, depth: number | "sitemap"): void => {
    if (record.doc === null || typeof depth !== "number") return;
    for (const link of record.doc.links) {
      if (link.url !== null && link.internal) enqueue(link.url, depth + 1);
    }
  };

  const addTarget = (item: QueueItem, r: FetchResult): void => {
    const target = r.finalUrl;
    if (seen.has(target) || !sameOrigin(target, a.origin)) return;
    seen.add(target);
    const record = newRecord(target, item.depth, a.sitemapSet.has(target), { ...r, hops: [] });
    attachDocument(record, r);
    found.push({ record, order: item.seq + 0.5 });
    follow(record, item.depth);
  };

  const handle = (item: QueueItem, r: FetchResult): void => {
    const record = newRecord(item.url, item.depth, a.sitemapSet.has(item.url), r);
    const reason = r.failure === "other" ? a.blockedAt.get(r.finalUrl) : undefined;
    if (reason !== undefined) {
      record.status = r.hops[r.hops.length - 1]?.status ?? null;
      record.failure = reason === "robots" ? "blocked-by-robots" : null;
      if (reason === "robots") block(r.finalUrl);
    } else if (r.hops.length === 0) {
      attachDocument(record, r);
      follow(record, item.depth);
    } else {
      addTarget(item, r);
    }
    found.push({ record, order: item.seq });
    const isResource = reason === undefined && r.status !== null && !record.isHtml;
    if (!isResource) counted += 1;
    say({ kind: "page", url: item.url, done: counted });
  };

  const runPool = async (): Promise<void> => {
    const active = new Set<Promise<void>>();
    for (;;) {
      while (
        active.size < options.concurrency &&
        queue.length > 0 &&
        counted + active.size < options.maxPages
      ) {
        const item = queue.shift();
        if (item === undefined) break;
        const task: Promise<void> = a.fetcher
          .get(item.url)
          .then((r) => handle(item, r))
          .finally(() => {
            active.delete(task);
          });
        active.add(task);
      }
      if (active.size === 0) return;
      await Promise.race(active);
    }
  };

  handle({ url: a.startUrl, depth: 0, seq: 0 }, a.start);
  await runPool();
  for (const url of a.sitemapUrls) enqueue(url, "sitemap");
  await runPool();

  found.sort((x, y) => x.order - y.order);
  return {
    pages: found.map((entry) => entry.record),
    blockedByRobots: blocked,
    pagesCrawled: counted,
    uncrawled: queue.length,
  };
}

/** For each page, the crawled pages whose links point at it. Links are matched on normalised URL. */
function computeInlinks(pages: PageRecord[]): void {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const sources = new Map<PageRecord, Set<string>>();
  for (const page of pages) {
    if (page.doc === null) continue;
    for (const link of page.doc.links) {
      if (link.url === null) continue;
      const target = byUrl.get(link.url);
      if (target === undefined || target.url === page.url) continue;
      const set = sources.get(target) ?? new Set<string>();
      set.add(page.url);
      sources.set(target, set);
    }
  }
  for (const [target, set] of sources) target.inlinks = [...set];
}

// ---------------------------------------------------------------------------
// assets

/** Unique image, script and stylesheet URLs across the crawled documents, in first-seen order. */
function collectAssets(pages: PageRecord[], origin: string): AssetRecord[] {
  const byUrl = new Map<string, AssetRecord>();
  const used = new Map<string, Set<string>>();
  const add = (url: string | null, kind: AssetRecord["kind"], pageUrl: string): void => {
    if (url === null) return;
    let asset = byUrl.get(url);
    if (asset === undefined) {
      asset = {
        url,
        kind,
        thirdParty: !sameOrigin(url, origin),
        status: null,
        bytes: null,
        contentType: null,
        contentEncoding: null,
        cacheControl: null,
        measured: false,
        usedBy: [],
      };
      byUrl.set(url, asset);
      used.set(url, new Set());
    }
    used.get(url)?.add(pageUrl);
  };
  for (const page of pages) {
    const doc = page.doc;
    if (doc === null) continue;
    for (const image of doc.images) add(image.url, "image", page.url);
    for (const script of doc.scripts) if (!script.inline) add(script.url, "script", page.url);
    for (const sheet of doc.stylesheets) add(sheet.url, "stylesheet", page.url);
  }
  for (const [url, asset] of byUrl) asset.usedBy = [...(used.get(url) ?? [])];
  return [...byUrl.values()];
}

function cacheControlOf(headers: Record<string, string>): string | null {
  const value = (headers["cache-control"] ?? "").trim();
  if (value !== "") return value;
  return headers.expires === undefined ? null : "expires";
}

async function probeAsset(fetcher: Fetcher, asset: AssetRecord): Promise<void> {
  const p = await fetcher.probe(asset.url);
  if (isThrottled(p.status)) return;
  asset.status = p.status;
  if (!p.measured) return;
  asset.measured = true;
  asset.bytes = p.bytes;
  asset.contentType = mediaTypeOf(p.headers["content-type"]);
  asset.contentEncoding = p.headers["content-encoding"] ?? null;
  asset.cacheControl = cacheControlOf(p.headers);
}

type AssetArgs = {
  options: AuditOptions;
  origin: string;
  fetchers: Fetchers;
  assets: AssetRecord[];
  robotsBlocks: (url: string) => boolean;
  block: (url: string) => void;
  say: Say;
};

/**
 * Probes same-origin assets that robots.txt allows, and third-party assets with checkExternal,
 * in first-seen order up to maxAssets. Everything else stays unmeasured.
 */
async function probeAssets(a: AssetArgs): Promise<void> {
  const { options } = a;
  const eligible: AssetRecord[] = [];
  for (const asset of a.assets) {
    if (asset.thirdParty) {
      if (options.checkExternal) eligible.push(asset);
    } else if (a.robotsBlocks(asset.url)) {
      a.block(asset.url);
    } else if (!isExcluded(asset.url, options.exclude)) {
      eligible.push(asset);
    }
  }
  const chosen = eligible.slice(0, options.maxAssets);
  let done = 0;
  await mapPool(chosen, options.concurrency, async (asset) => {
    await probeAsset(asset.thirdParty ? a.fetchers.other : a.fetchers.crawl, asset);
    done += 1;
    a.say({ kind: "asset", url: asset.url, done });
  });
}

// ---------------------------------------------------------------------------
// origin probes

async function probeHttpVariant(fetcher: Fetcher, origin: string): Promise<boolean | null> {
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:") return null;
  const r = await fetcher.single(`http://${parsed.hostname}/`);
  if (r.status === null || isThrottled(r.status)) return null;
  const redirected = r.status >= 300 && r.status < 400;
  return redirected && r.location !== null && r.location.startsWith("https:");
}

/** True when the sibling answers a redirect to the audit host, false on 200, null otherwise. */
async function probeSibling(
  fetcher: Fetcher,
  origin: string,
  sibling: string,
): Promise<boolean | null> {
  const parsed = new URL(origin);
  const r = await fetcher.single(
    `${parsed.protocol}//${sibling}${parsed.port === "" ? "" : `:${parsed.port}`}/`,
  );
  if (r.status === 200) return false;
  if (r.status === null || r.status < 300 || r.status >= 400 || r.location === null) return null;
  try {
    return new URL(r.location).host === parsed.host ? true : null;
  } catch {
    return null;
  }
}

async function probeSoft404(fetcher: Fetcher, origin: string): Promise<boolean | null> {
  const r = await fetcher.get(`${origin}/site-audit-cli-probe-${randomBytes(8).toString("hex")}`);
  if (r.status === null || isThrottled(r.status)) return null;
  return r.status === 200;
}

async function probeFavicon(
  fetcher: Fetcher,
  origin: string,
  pages: PageRecord[],
  robotsBlocks: (url: string) => boolean,
): Promise<boolean | null> {
  if (pages.some((p) => p.doc?.iconLink === true)) return true;
  const url = `${origin}/favicon.ico`;
  if (robotsBlocks(url)) return null;
  const r = await fetcher.probe(url);
  if (r.status === null || isThrottled(r.status)) return null;
  return r.status === 200;
}

async function probeOrigin(
  origin: string,
  fetchers: Fetchers,
  pages: PageRecord[],
  robotsBlocks: (url: string) => boolean,
): Promise<SiteContext["probes"]> {
  const sibling = siblingHost(new URL(origin).hostname);
  const httpRedirectsToHttps = await probeHttpVariant(fetchers.main, origin);
  const siblingHostRedirects =
    sibling === null ? null : await probeSibling(fetchers.other, origin, sibling);
  const soft404 = await probeSoft404(fetchers.crawl, origin);
  const favicon = await probeFavicon(fetchers.crawl, origin, pages, robotsBlocks);
  return { httpRedirectsToHttps, siblingHostRedirects, siblingHost: sibling, soft404, favicon };
}

// ---------------------------------------------------------------------------
// external links

type ExternalLink = NonNullable<SiteContext["external"]>[number];

/** HEAD first, then GET (headers only) when the server refuses HEAD. Redirects are not followed. */
async function probeLink(
  fetcher: Fetcher,
  url: string,
): Promise<{ status: number | null; failure: FetchFailure | null }> {
  const head = await fetcher.single(url, "HEAD");
  if (head.status !== 405 && head.status !== 501) return head;
  return fetcher.single(url, "GET");
}

async function probeExternal(
  options: AuditOptions,
  pages: PageRecord[],
  fetcher: Fetcher,
  say: Say,
): Promise<ExternalLink[]> {
  const byUrl = new Map<string, ExternalLink>();
  for (const page of pages) {
    if (page.doc === null) continue;
    for (const link of page.doc.links) {
      if (link.url === null || link.internal) continue;
      const entry = byUrl.get(link.url) ?? {
        url: link.url,
        status: null,
        failure: null,
        usedBy: [],
      };
      if (!entry.usedBy.includes(page.url)) entry.usedBy.push(page.url);
      byUrl.set(link.url, entry);
    }
  }
  const entries = [...byUrl.values()];
  let done = 0;
  await mapPool(entries, options.concurrency, async (entry) => {
    const result = await probeLink(fetcher, entry.url);
    entry.status = result.status;
    entry.failure = result.failure;
    done += 1;
    say({ kind: "external", url: entry.url, done });
  });
  return entries;
}

// ---------------------------------------------------------------------------

/**
 * Crawls a site politely and returns the facts every check reads. Throws UnreachableError
 * when the start URL cannot be audited.
 */
export async function crawlSite(options: AuditOptions, deps: CrawlDeps = {}): Promise<SiteContext> {
  const say: Say = deps.onProgress ?? (() => undefined);
  const baseFetch: typeof fetch =
    deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  let delayRaised = false;
  const onThrottle = (host: string): void => {
    delayRaised = true;
    say({
      kind: "note",
      done: 0,
      message: `${host} kept answering 429 or 503. The delay to it was doubled.`,
    });
  };

  const gate = new HostGate({
    delayMs: options.delayMs,
    concurrency: options.concurrency,
    clock: deps.clock,
  });
  const otherGate = new HostGate({ delayMs: options.delayMs, concurrency: 1, clock: deps.clock });
  const build = (hostGate: HostGate, fetchImpl: typeof fetch): Fetcher =>
    new Fetcher({
      userAgent: options.userAgent,
      timeoutMs: options.timeoutMs,
      gate: hostGate,
      clock: deps.clock,
      fetchImpl,
      onThrottle,
    });
  const main = build(gate, baseFetch);
  const net: Net = {
    baseFetch,
    gate,
    otherGate,
    make: (fetchImpl, hostGate) => build(hostGate, fetchImpl),
  };

  const opened = await openSite(options, net, gate, say);
  const { origin, robots } = opened;
  const robotsBlocks = (url: string): boolean =>
    !options.ignoreRobots && !robotsAllows(robots, url);

  const blockedAt = new Map<string, BlockReason>();
  const reasonFor = (url: string): BlockReason | null => {
    if (!sameOrigin(url, origin)) return "origin";
    if (isExcluded(url, options.exclude)) return "excluded";
    return robotsBlocks(url) ? "robots" : null;
  };
  const fetchers: Fetchers = {
    main,
    crawl: build(gate, guardedFetch(baseFetch, reasonFor, blockedAt)),
    other: build(otherGate, baseFetch),
  };

  const sitemap = await loadSitemaps(siteOnly(net, origin), origin, robots.summary.sitemaps, say);
  const crawl = await crawlPages({
    options,
    origin,
    fetcher: fetchers.crawl,
    start: opened.start,
    startUrl: opened.requested,
    sitemapUrls: sitemap.urls,
    sitemapSet: new Set(sitemap.urls),
    robotsBlocks,
    blockedAt,
    say,
  });
  computeInlinks(crawl.pages);

  const blockedByRobots = crawl.blockedByRobots;
  const assets = collectAssets(crawl.pages, origin);
  await probeAssets({
    options,
    origin,
    fetchers,
    assets,
    robotsBlocks,
    block: (url) => {
      if (!blockedByRobots.includes(url)) blockedByRobots.push(url);
    },
    say,
  });
  const probes = await probeOrigin(origin, fetchers, crawl.pages, robotsBlocks);
  const external = options.checkExternal
    ? await probeExternal(options, crawl.pages, fetchers.other, say)
    : null;

  return {
    startUrl: opened.start.finalUrl,
    origin,
    originNote: opened.originNote,
    robots: robots.summary,
    sitemap,
    probes,
    external,
    pages: crawl.pages,
    assets,
    limits: {
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
      pagesCrawled: crawl.pagesCrawled,
      uncrawled: crawl.uncrawled,
      blockedByRobots,
      assetsNotMeasured: assets.filter((asset) => !asset.measured).length,
      delayRaised,
    },
    options,
  };
}
