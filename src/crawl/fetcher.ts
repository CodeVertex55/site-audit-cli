import type { FetchFailure, Hop } from "../types.js";
import { normaliseUrl } from "./url.js";
import { parseRetryAfter, realClock, type Clock, type HostGate } from "./ratelimit.js";

export type FetchResult = {
  url: string;
  finalUrl: string;
  hops: Hop[];
  status: number | null;
  failure: FetchFailure | null;
  headers: Record<string, string>;
  responseMs: number | null;
  totalMs: number | null;
  /** Decoded text when the final response is HTML, XML or text; null otherwise. */
  body: string | null;
  bytes: number | null;
  transferBytes: number | null;
  truncated: boolean;
  contentType: string | null;
};

export type ProbeResult = {
  status: number | null;
  failure: FetchFailure | null;
  bytes: number | null;
  headers: Record<string, string>;
  measured: boolean;
  finalUrl: string;
};

export type FetcherOptions = {
  userAgent: string;
  timeoutMs: number;
  gate: HostGate;
  clock?: Clock;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  onThrottle?: (host: string) => void;
};

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_HOPS = 10;
const MAX_RETRIES = 2;
const ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";
const META_SCAN_BYTES = 2048;

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isRetryStatus(status: number): boolean {
  return status === 429 || status === 503;
}

type Raw = {
  status: number;
  headers: Record<string, string>;
  location: string | null;
  responseMs: number;
  totalMs: number;
  /** Null when the body was not read. */
  body: Uint8Array | null;
  truncated: boolean;
};

type Outcome = { ok: true; raw: Raw } | { ok: false; failure: FetchFailure };

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const key = name.toLowerCase();
    const existing = out[key];
    out[key] = existing === undefined ? value : `${existing}, ${value}`;
  }
  return out;
}

type ErrorFacts = { names: string[]; codes: string[] };

function collectErrorFacts(error: unknown, facts: ErrorFacts, depth: number): void {
  if (depth > 6 || typeof error !== "object" || error === null) return;
  const candidate = error as { name?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof candidate.name === "string") facts.names.push(candidate.name);
  if (typeof candidate.code === "string") facts.codes.push(candidate.code);
  collectErrorFacts(candidate.cause, facts, depth + 1);
  if (Array.isArray(candidate.errors)) {
    for (const inner of candidate.errors as unknown[]) collectErrorFacts(inner, facts, depth + 1);
  }
}

function failureForCode(code: string): FetchFailure | null {
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") {
    return "connection";
  }
  if (
    code.startsWith("CERT_") ||
    code.startsWith("ERR_TLS") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) {
    return "tls";
  }
  return null;
}

function classifyError(error: unknown): FetchFailure {
  const facts: ErrorFacts = { names: [], codes: [] };
  collectErrorFacts(error, facts, 0);
  if (facts.names.some((name) => name === "AbortError" || name === "TimeoutError")) {
    return "timeout";
  }
  for (const code of facts.codes) {
    const failure = failureForCode(code);
    if (failure !== null) return failure;
  }
  return "other";
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is being thrown away, so a failure to cancel it does not matter.
  }
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { bytes: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

function isTextual(contentType: string): boolean {
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return (
    mediaType.startsWith("text/") ||
    mediaType.includes("html") ||
    mediaType.endsWith("/xml") ||
    mediaType.endsWith("+xml")
  );
}

function stripQuotes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value.charAt(start) === '"' || value.charAt(start) === "'")) start += 1;
  while (end > start && (value.charAt(end - 1) === '"' || value.charAt(end - 1) === "'")) end -= 1;
  return value.slice(start, end);
}

function charsetFromContentType(contentType: string): string | null {
  const parts = contentType.split(";");
  for (let i = 1; i < parts.length; i += 1) {
    const part = (parts[i] ?? "").trim();
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== "charset") continue;
    const label = stripQuotes(part.slice(eq + 1).trim());
    return label === "" ? null : label;
  }
  return null;
}

function isLabelChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "-" ||
    ch === "_" ||
    ch === "." ||
    ch === ":"
  );
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/** Reads `charset=label` out of one lower-cased `<meta ...` tag. */
function charsetInTag(tag: string): string | null {
  const at = tag.indexOf("charset");
  if (at < 0) return null;
  let i = at + "charset".length;
  while (i < tag.length && isSpace(tag.charAt(i))) i += 1;
  if (tag.charAt(i) !== "=") return null;
  i += 1;
  while (
    i < tag.length &&
    (isSpace(tag.charAt(i)) || tag.charAt(i) === '"' || tag.charAt(i) === "'")
  ) {
    i += 1;
  }
  const start = i;
  while (i < tag.length && isLabelChar(tag.charAt(i))) i += 1;
  return i > start ? tag.slice(start, i) : null;
}

function charsetFromMeta(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, META_SCAN_BYTES)).toString("latin1").toLowerCase();
  let position = 0;
  for (;;) {
    const open = head.indexOf("<meta", position);
    if (open < 0) return null;
    const close = head.indexOf(">", open);
    const tag = head.slice(open, close < 0 ? head.length : close);
    const label = charsetInTag(tag);
    if (label !== null) return label;
    if (close < 0) return null;
    position = close + 1;
  }
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const label =
    (contentType === null ? null : charsetFromContentType(contentType)) ??
    charsetFromMeta(bytes) ??
    "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

function parseContentLength(headers: Record<string, string>): number | null {
  const raw = headers["content-length"];
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "" || !/^\d+$/.test(text)) return null;
  return Number(text);
}

function elapsed(clock: Clock, since: number): number {
  return Math.max(0, Math.round(clock.now() - since));
}

export class Fetcher {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly gate: HostGate;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly onThrottle: ((host: string) => void) | undefined;
  private requests = 0;

  constructor(opts: FetcherOptions) {
    this.userAgent = opts.userAgent;
    this.timeoutMs = opts.timeoutMs;
    this.gate = opts.gate;
    this.clock = opts.clock ?? realClock;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.onThrottle = opts.onThrottle;
  }

  get requestCount(): number {
    return this.requests;
  }

  /**
   * One network request. The body is read (up to maxBytes) only when `readBody`
   * is set and the response is neither a followed redirect nor a response that
   * will be retried.
   */
  private async attempt(
    url: string,
    method: "GET" | "HEAD",
    readBody: boolean,
    retriesLeft: number,
  ): Promise<Outcome> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return { ok: false, failure: "other" };
    }
    const release = await this.gate.acquire(host);
    try {
      this.requests += 1;
      const startedAt = this.clock.now();
      const response = await this.fetchImpl(url, {
        method,
        redirect: "manual",
        headers: { "user-agent": this.userAgent, accept: ACCEPT },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const responseMs = elapsed(this.clock, startedAt);
      const status = response.status;
      const location = response.headers.get("location");
      const skipBody =
        !readBody ||
        method === "HEAD" ||
        (isRedirectStatus(status) && location !== null) ||
        (isRetryStatus(status) && retriesLeft > 0);
      let body: Uint8Array | null = null;
      let truncated = false;
      if (skipBody) {
        await discardBody(response);
      } else {
        const read = await readCapped(response, this.maxBytes);
        body = read.bytes;
        truncated = read.truncated;
      }
      return {
        ok: true,
        raw: {
          status,
          headers: headersToRecord(response.headers),
          location,
          responseMs,
          totalMs: elapsed(this.clock, startedAt),
          body,
          truncated,
        },
      };
    } catch (error) {
      return { ok: false, failure: classifyError(error) };
    } finally {
      release();
    }
  }

  /** GET with up to two retries after 429 or 503. */
  private async getWithRetry(url: string): Promise<Outcome> {
    for (let retriesLeft = MAX_RETRIES; ; retriesLeft -= 1) {
      const outcome = await this.attempt(url, "GET", true, retriesLeft);
      if (!outcome.ok || !isRetryStatus(outcome.raw.status)) return outcome;
      if (retriesLeft === 0) {
        const host = new URL(url).host;
        this.gate.doubleDelay(host);
        this.onThrottle?.(host);
        return outcome;
      }
      await this.clock.sleep(
        parseRetryAfter(outcome.raw.headers["retry-after"] ?? null, Date.now()),
      );
    }
  }

  /** GET with manual redirect following (max 10 hops), body capped at maxBytes (default 5 MB). */
  async get(url: string): Promise<FetchResult> {
    const hops: Hop[] = [];
    const seen = new Set<string>([normaliseUrl(url) ?? url]);
    let current = url;

    const failed = (failure: FetchFailure): FetchResult => ({
      url,
      finalUrl: current,
      hops,
      status: null,
      failure,
      headers: {},
      responseMs: null,
      totalMs: null,
      body: null,
      bytes: null,
      transferBytes: null,
      truncated: false,
      contentType: null,
    });

    for (;;) {
      const outcome = await this.getWithRetry(current);
      if (!outcome.ok) return failed(outcome.failure);
      const raw = outcome.raw;

      if (isRedirectStatus(raw.status) && raw.location !== null) {
        if (hops.length >= MAX_HOPS) return failed("too-many-redirects");
        const next = normaliseUrl(raw.location, current);
        if (next === null) return failed("other");
        hops.push({ url: current, status: raw.status, location: next });
        if (seen.has(next)) return failed("redirect-loop");
        seen.add(next);
        current = next;
        continue;
      }

      const contentType = raw.headers["content-type"] ?? null;
      const textual = contentType !== null && isTextual(contentType);
      return {
        url,
        finalUrl: current,
        hops,
        status: raw.status,
        failure: null,
        headers: raw.headers,
        responseMs: raw.responseMs,
        totalMs: raw.totalMs,
        body: raw.body !== null && textual ? decodeBody(raw.body, contentType) : null,
        bytes: raw.body === null ? null : raw.body.length,
        transferBytes: parseContentLength(raw.headers),
        truncated: raw.truncated,
        contentType,
      };
    }
  }

  /**
   * Size and header probe for an asset or external link: HEAD first, GET with
   * byte counting when HEAD is refused (405, 501) or has no Content-Length.
   * Follows redirects. Responses with status 400 or above report no size.
   */
  async probe(url: string): Promise<ProbeResult> {
    let method: "GET" | "HEAD" = "HEAD";
    let current = url;
    let followed = 0;
    const seen = new Set<string>([normaliseUrl(url) ?? url]);

    const failed = (failure: FetchFailure): ProbeResult => ({
      status: null,
      failure,
      bytes: null,
      headers: {},
      measured: false,
      finalUrl: current,
    });

    for (;;) {
      const outcome = await this.attempt(current, method, method === "GET", 0);
      if (!outcome.ok) return failed(outcome.failure);
      const raw = outcome.raw;

      if (isRedirectStatus(raw.status) && raw.location !== null) {
        if (followed >= MAX_HOPS) return failed("too-many-redirects");
        const next = normaliseUrl(raw.location, current);
        if (next === null) return failed("other");
        if (seen.has(next)) return failed("redirect-loop");
        seen.add(next);
        followed += 1;
        current = next;
        continue;
      }

      const done = (bytes: number | null): ProbeResult => ({
        status: raw.status,
        failure: null,
        bytes,
        headers: raw.headers,
        measured: bytes !== null,
        finalUrl: current,
      });

      if (method === "HEAD") {
        if (raw.status === 405 || raw.status === 501) {
          method = "GET";
          continue;
        }
        if (raw.status >= 400) return done(null);
        const length = parseContentLength(raw.headers);
        if (length === null) {
          method = "GET";
          continue;
        }
        return done(length);
      }

      if (raw.status >= 400) return done(null);
      return done(raw.body === null ? null : raw.body.length);
    }
  }

  /** One request, no redirect following, no retries. The Location is resolved against the URL. */
  async single(
    url: string,
    method: "GET" | "HEAD" = "GET",
  ): Promise<{ status: number | null; location: string | null; failure: FetchFailure | null }> {
    const outcome = await this.attempt(url, method, false, 0);
    if (!outcome.ok) return { status: null, location: null, failure: outcome.failure };
    const raw = outcome.raw;
    const location =
      raw.location === null ? null : (normaliseUrl(raw.location, url) ?? raw.location);
    return { status: raw.status, location, failure: null };
  }
}
