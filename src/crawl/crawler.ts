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
  selectGroup,
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
const MAX_ROBOTS_BYTES = 512 * 1024;
/** Origin moves a start redirect may make while it stays on the requested site. */
const MAX_SAME_SITE_SHIFTS = 3;
const BLOCKED_CODE = "SITE_AUDIT_BLOCKED";
/** The note on a guessed /sitemap.xml that robots.txt disallows. SEO-MAP-090 reads it. */
const ROBOTS_SKIPPED_NOTE = "disallowed by robots.txt, not requested";

type BlockReason = "origin" | "shift" | "excluded" | "robots";

type RobotsState = {
  file: RobotsFile | null;
  summary: SiteContext["robots"];
  /** The Crawl-delay for this tool in milliseconds, already clamped; null when none. */
  delayMs: number | null;
  clamped: boolean;
  /** The Crawl-delay robots.txt asks for, in milliseconds, before the clamp; null when none. */
  requestedMs: number | null;
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
  /**
   * The audit host through the audit gate and other hosts one at a time, no guards. Only for the
   * http variant probe, which checks every redirect target is on the site before requesting it.
   */
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

/** The hostname part of a `host` or `host:port` value. */
function hostnameOfHost(host: string): string {
  try {
    return bareHostname(new URL(`http://${host}`).hostname);
  } catch {
    return bareHostname(host);
  }
}

/** A hostname without its one trailing dot: `example.com.` names the same host as `example.com`. */
function bareHostname(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/**
 * Sends the audit host through the audit gate and every other host through the one-at-a-time
 * gate, so a redirect to a sibling host is paced like any other host. With `byHostname`, any
 * scheme or port of the audit hostname shares the audit host's slot in the audit gate.
 */
class RoutedGate extends HostGate {
  private readonly primary: HostGate;
  private readonly secondary: HostGate;
  private readonly primaryHost: string;
  private readonly byHostname: boolean;

  constructor(primary: HostGate, secondary: HostGate, primaryHost: string, byHostname = false) {
    super({ delayMs: 0, concurrency: 1 });
    this.primary = primary;
    this.secondary = secondary;
    this.primaryHost = primaryHost;
    this.byHostname = byHostname;
  }

  private route(host: string): { gate: HostGate; key: string } {
    if (host === this.primaryHost) return { gate: this.primary, key: host };
    if (this.byHostname && hostnameOfHost(host) === hostnameOfHost(this.primaryHost)) {
      return { gate: this.primary, key: this.primaryHost };
    }
    return { gate: this.secondary, key: host };
  }

  override acquire(host: string): Promise<() => void> {
    const { gate, key } = this.route(host);
    return gate.acquire(key);
  }

  override setMinDelay(host: string, ms: number): void {
    const { gate, key } = this.route(host);
    gate.setMinDelay(key, ms);
  }

  override doubleDelay(host: string): boolean {
    const { gate, key } = this.route(host);
    return gate.doubleDelay(key);
  }

  override delayFor(host: string): number {
    const { gate, key } = this.route(host);
    return gate.delayFor(key);
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
    const targetName = bareHostname(target.hostname);
    const baseName = bareHostname(base.hostname);
    const host = targetName === baseName || targetName === siblingHost(baseName);
    return host && (target.port === "" || target.port === base.port);
  } catch {
    return false;
  }
}

/** True for an HTML body: the Content-Type says so, or the body opens with a doctype or html tag. */
function looksLikeHtml(r: FetchResult): boolean {
  if (isHtmlType(r.contentType)) return true;
  const start = (r.body ?? "").slice(0, 64).trimStart().toLowerCase();
  return start.startsWith("<!doctype html") || start.startsWith("<html");
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

/**
 * Fetches and parses `<origin>/robots.txt`. A 4xx answer means there is no file. The body is
 * read as text whatever its Content-Type, up to 512 KB; rules after that are ignored.
 */
async function loadRobots(
  fetcher: Fetcher,
  origin: string,
  options: AuditOptions,
  say: Say,
): Promise<RobotsState> {
  const r = await fetcher.get(`${origin}/robots.txt`, {
    anyType: true,
    maxBytes: MAX_ROBOTS_BYTES,
  });
  const ignored = options.ignoreRobots;
  const movedAway = leftSite(r, origin);
  const none = (unreadable: string | null): RobotsState => ({
    file: null,
    summary: robotsSummary(movedAway ? lastHopStatus(r) : r.status, false, ignored),
    delayMs: null,
    clamped: false,
    requestedMs: null,
    unreadable,
  });
  if (movedAway) return none("it redirected to a different site");
  if (r.status === null) return none(r.failure ?? "other");
  if (r.status >= 500) return none(`status ${r.status}`);
  if (r.status < 200 || r.status >= 300) return none(null);

  if (r.truncated) {
    say({
      kind: "note",
      done: 0,
      message: `robots.txt at ${origin} is larger than 512 KB. Rules after the first 512 KB were ignored.`,
    });
  }
  let text = r.body ?? "";
  if (r.truncated) {
    // The cut can fall inside a rule, and a shortened rule can mean something else, such as
    // "Disallow: /private" read as "Disallow: /". The final partial line is dropped.
    const lineEnd = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
    text = text.slice(0, lineEnd + 1);
  }
  const file = parseRobots(text);
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
    requestedMs: requestedDelayMs(file),
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

function requestedDelayMs(file: RobotsFile): number | null {
  const seconds = selectGroup(file, ROBOTS_TOKEN)?.crawlDelay ?? null;
  return seconds === null ? null : Math.round(seconds * 1000);
}

function secondsText(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/**
 * Applies the robots.txt Crawl-delay to the host's gate. When it is larger than --delay, so it
 * sets the pace, a note says so, and another when it was clamped.
 */
function applyCrawlDelay(
  gate: HostGate,
  origin: string,
  robots: RobotsState,
  options: AuditOptions,
  say: Say,
): void {
  if (options.ignoreRobots || robots.delayMs === null) return;
  gate.setMinDelay(new URL(origin).host, robots.delayMs);
  // The notes are only printed when the robots.txt delay sets the pace.
  if (robots.delayMs <= options.delayMs) return;
  say({
    kind: "note",
    done: 0,
    message: `robots.txt asks for ${secondsText(robots.requestedMs ?? robots.delayMs)} between requests, so this run will take longer.`,
  });
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
 * it must not match --exclude or be disallowed by robots.txt. A hop to another origin moves the
 * audit origin, and only after that origin's robots.txt has been read and its Crawl-delay
 * applied. Up to three moves are allowed while each new origin is on the requested site (the
 * same hostname or its www or apex sibling), and one move to a different site. The robots.txt
 * read happens between two fetches, never inside a request that holds a gate slot.
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
    say,
  );
  robotsByOrigin.set(requestedOrigin, requestedRobots);
  enforceRobots(requestedRobots, requestedOrigin, requested, options);
  applyCrawlDelay(gate, requestedOrigin, requestedRobots, options, say);

  let currentOrigin = requestedOrigin;
  let sameSiteShifts = 0;
  let movedToOtherSite = false;
  const verdict = (url: string): BlockReason | null => {
    if (url === requested) return null;
    if (originOf(url) !== currentOrigin) {
      if (sameSite(url, requestedOrigin)) {
        return sameSiteShifts < MAX_SAME_SITE_SHIFTS ? "shift" : "origin";
      }
      return movedToOtherSite ? "origin" : "shift";
    }
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
  while (start.failure === "other" && blockedAt.get(start.finalUrl) === "shift") {
    // Each move is counted before the next request, so the verdict refuses a move past the limit.
    const shifted = start.finalUrl;
    blockedAt.delete(shifted);
    if (sameSite(shifted, requestedOrigin)) sameSiteShifts += 1;
    else movedToOtherSite = true;
    const next = originOf(shifted);
    let nextRobots = robotsByOrigin.get(next);
    if (nextRobots === undefined) {
      nextRobots = await loadRobots(siteOnly(net, next), next, options, say);
      robotsByOrigin.set(next, nextRobots);
      applyCrawlDelay(gate, next, nextRobots, options, say);
    }
    currentOrigin = next;
    start = await startFetcher.get(shifted);
    hops.push(...start.hops);
  }
  start = { ...start, url: requested, hops };
  if (start.status === null) failStart(start, blockedAt, (o) => robotsByOrigin.get(o), options);
  const origin = originOf(start.finalUrl);
  const robots = robotsByOrigin.get(origin) ?? requestedRobots;
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

/**
 * Reads sitemaps from robots.txt, else `/sitemap.xml`. An index is followed one level. A guessed
 * `/sitemap.xml` that answers with an HTML page and does not parse as a sitemap is not recorded,
 * since many sites answer every path with a page. A guessed `/sitemap.xml` that robots.txt
 * disallows is not requested; it is recorded with a note and counted as skipped by robots.txt.
 * A sitemap that robots.txt names is read whatever its path.
 */
async function loadSitemaps(
  fetcher: Fetcher,
  origin: string,
  named: string[],
  robotsBlocks: (url: string) => boolean,
  block: (url: string) => void,
  say: Say,
): Promise<SiteContext["sitemap"]> {
  const guessed = named.length === 0;
  const guess = `${origin}/sitemap.xml`;
  const guessBlocked = guessed && robotsBlocks(guess);
  const candidates = guessed ? (guessBlocked ? [] : [guess]) : named;
  const pending = [...new Set(candidates)].map((url) => ({ url, level: 0 }));
  const files: SitemapFile[] = [];
  const urls: string[] = [];
  const known = new Set<string>();

  const record = (url: string, status: number | null, ok: boolean, note: string | null): void => {
    files.push({ url, status, ok, note });
  };
  if (guessBlocked) {
    record(guess, null, false, ROBOTS_SKIPPED_NOTE);
    block(guess);
  }

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
      if (guessed && item.level === 0 && looksLikeHtml(r)) continue;
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

/**
 * Parses the body of a successful HTML response and flags a page cut short by the nesting guard
 * or the text-read budget. A page whose extraction throws keeps no document and is flagged
 * truncated, so one page cannot end the crawl.
 */
function attachDocument(record: PageRecord, r: FetchResult): void {
  const status = r.status;
  if (status === null || status < 200 || status >= 300) return;
  if (r.body === null || !isHtmlType(r.contentType)) return;
  try {
    const extracted = extractWithStatus(r.body, record.finalUrl, r.headers);
    record.doc = extracted.doc;
    if (extracted.truncated) record.truncated = true;
  } catch {
    record.doc = null;
    record.truncated = true;
  }
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
  // Linked files that are not HTML have a cap of their own, the same as the page cap.
  let resources = 0;

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
    if (isResource) resources += 1;
    else counted += 1;
    say({ kind: "page", url: item.url, done: counted });
  };

  const runPool = async (): Promise<void> => {
    const active = new Set<Promise<void>>();
    for (;;) {
      while (
        active.size < options.concurrency &&
        queue.length > 0 &&
        counted + active.size < options.maxPages &&
        resources + active.size < options.maxPages
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

/**
 * A third-party asset is never followed through a redirect to a different host. Scripts and
 * stylesheets get the extra compression check.
 */
async function probeAsset(fetcher: Fetcher, asset: AssetRecord): Promise<void> {
  const p = await fetcher.probe(asset.url, {
    sameHostOnly: asset.thirdParty,
    checkEncoding: asset.kind === "script" || asset.kind === "stylesheet",
  });
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
  /**
   * For a URL on the audited hostname under another scheme or port: "robots" or "excluded"
   * when it must not be requested, else null.
   */
  auditHostReason: (url: string) => "robots" | "excluded" | null;
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
      if (!options.checkExternal) continue;
      // The audited host under another scheme or port follows the audited site's robots.txt
      // and --exclude.
      const reason = a.auditHostReason(asset.url);
      if (reason === "robots") a.block(asset.url);
      else if (reason === null) eligible.push(asset);
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

const MAX_VARIANT_REQUESTS = 3;

/**
 * Whether plain HTTP is upgraded on an HTTPS origin. Requests `http://host/` and follows
 * redirects that stay on the site, at most three requests in all. True when a redirect points
 * at https on the same site, false when the chain ends in a 2xx answer over http, and null
 * otherwise: a failure, a 4xx or 5xx answer, a redirect off the site or a longer chain. An
 * origin on a port other than 443 is not probed, since its plain-HTTP port is unknown.
 */
async function probeHttpVariant(
  fetcher: Fetcher,
  origin: string,
  blocks: (url: string) => boolean,
): Promise<boolean | null> {
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" || parsed.port !== "") return null;
  let url = `http://${parsed.hostname}/`;
  for (let i = 0; i < MAX_VARIANT_REQUESTS; i += 1) {
    // A URL on the audited hostname that its robots.txt disallows is not requested.
    if (blocks(url)) return null;
    const r = await fetcher.single(url);
    if (r.status === null) return null;
    if (r.status >= 200 && r.status < 300) return false;
    if (r.status < 300 || r.status >= 400 || r.location === null) return null;
    if (!sameSite(r.location, origin)) return null;
    if (r.location.startsWith("https:")) return true;
    url = r.location;
  }
  return null;
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
  onAuditHost: (url: string) => boolean,
): Promise<SiteContext["probes"]> {
  const sibling = siblingHost(new URL(origin).hostname);
  const httpRedirectsToHttps = await probeHttpVariant(
    fetchers.main,
    origin,
    (url) => onAuditHost(url) && robotsBlocks(url),
  );
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

/**
 * Checks each unique external link once. A link that `skip` refuses (the audited hostname under
 * another scheme or port that the audited site's robots.txt disallows or --exclude matches) is
 * not requested. A robots.txt case is recorded with the failure `blocked-by-robots`; an excluded
 * one keeps no status and no failure.
 */
async function probeExternal(
  options: AuditOptions,
  pages: PageRecord[],
  fetcher: Fetcher,
  skip: (url: string) => "robots" | "excluded" | null,
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
    const reason = skip(entry.url);
    if (reason !== null) {
      if (reason === "robots") entry.failure = "blocked-by-robots";
      return;
    }
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
  // Other hosts, and the audited hostname under another scheme or port. The latter shares the
  // audit gate and is held to the audited site's robots.txt before the first request and before
  // any redirect is followed.
  const auditHostname = bareHostname(new URL(origin).hostname);
  const onAuditHost = (url: string): boolean => {
    try {
      return bareHostname(new URL(url).hostname) === auditHostname;
    } catch {
      return false;
    }
  };
  // Why a URL on the audited hostname under another scheme or port is not requested, if it is not.
  const auditHostReason = (url: string): "robots" | "excluded" | null => {
    if (!onAuditHost(url)) return null;
    if (robotsBlocks(url)) return "robots";
    return isExcluded(url, options.exclude) ? "excluded" : null;
  };
  const otherReason = (url: string): BlockReason | null => auditHostReason(url);
  const fetchers: Fetchers = {
    main: build(new RoutedGate(gate, otherGate, new URL(origin).host), baseFetch),
    crawl: build(gate, guardedFetch(baseFetch, reasonFor, blockedAt)),
    other: build(
      new RoutedGate(gate, otherGate, new URL(origin).host, true),
      guardedFetch(baseFetch, otherReason, new Map()),
    ),
  };

  const skippedSitemaps: string[] = [];
  const sitemap = await loadSitemaps(
    siteOnly(net, origin),
    origin,
    robots.summary.sitemaps,
    robotsBlocks,
    (url) => skippedSitemaps.push(url),
    say,
  );
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
  const block = (url: string): void => {
    if (!blockedByRobots.includes(url)) blockedByRobots.push(url);
  };
  for (const url of skippedSitemaps) block(url);
  const assets = collectAssets(crawl.pages, origin);
  await probeAssets({
    options,
    origin,
    fetchers,
    assets,
    robotsBlocks,
    auditHostReason,
    block,
    say,
  });
  const probes = await probeOrigin(origin, fetchers, crawl.pages, robotsBlocks, onAuditHost);
  const external = options.checkExternal
    ? await probeExternal(
        options,
        crawl.pages,
        fetchers.other,
        (url) => {
          const reason = auditHostReason(url);
          if (reason === "robots") block(url);
          return reason;
        },
        say,
      )
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
