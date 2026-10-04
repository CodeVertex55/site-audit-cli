import { UsageError } from "../errors.js";

function isHttp(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * Parse the start URL given on the command line. A bare host such as
 * `example.com` becomes `https://example.com/`. Throws UsageError for anything
 * that is not an http(s) URL or that carries credentials.
 */
export function parseStartUrl(input: string): string {
  const raw = input.trim();
  if (raw === "") throw new UsageError("The start URL is empty.");

  let candidate = raw;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  const looksLikeHostPort = /^[^/?#:]+:\d+(?:[/?#]|$)/.test(raw);
  if (!hasScheme || (!raw.includes("://") && looksLikeHostPort)) {
    candidate = `https://${raw}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new UsageError(`Not a valid URL: ${input}`);
  }
  if (!isHttp(url)) {
    throw new UsageError(`The start URL must use http or https: ${input}`);
  }
  if (url.hostname === "") throw new UsageError(`The start URL has no host: ${input}`);
  if (url.username !== "" || url.password !== "") {
    throw new UsageError("Credentials in the start URL are not supported.");
  }
  url.hash = "";
  return url.href;
}

/**
 * Resolve `href` against `base` and normalise it: fragment removed, default
 * port removed, host lower-cased, dot segments resolved, query kept.
 * Returns null when it cannot be parsed or is not http(s).
 */
export function normaliseUrl(href: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (!isHttp(url)) return null;
  url.hash = "";
  return url.href;
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return originOf(a) === originOf(b);
  } catch {
    return false;
  }
}

/** Path plus query, for example "/a/b?x=1". */
export function pathWithQuery(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

type GlobToken = { kind: "literal"; ch: string } | { kind: "star" } | { kind: "globstar" };

function tokeniseGlob(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === "*") {
      let run = 0;
      while (pattern.charAt(i) === "*") {
        run += 1;
        i += 1;
      }
      tokens.push(run >= 2 ? { kind: "globstar" } : { kind: "star" });
    } else {
      tokens.push({ kind: "literal", ch });
      i += 1;
    }
  }
  return tokens;
}

/**
 * Whole-string glob match. `*` matches any run of characters except "/",
 * `**` matches any run of characters. Dynamic programming over the tokens, so
 * the cost is bounded by pattern length times path length.
 */
function globMatches(pattern: string, path: string): boolean {
  const tokens = tokeniseGlob(pattern);
  const n = path.length;
  let current: boolean[] = new Array<boolean>(n + 1).fill(false);
  current[0] = true;
  for (const token of tokens) {
    const next: boolean[] = new Array<boolean>(n + 1).fill(false);
    if (token.kind === "literal") {
      for (let j = 0; j < n; j += 1) {
        if (current[j] && path.charAt(j) === token.ch) next[j + 1] = true;
      }
    } else {
      for (let j = 0; j <= n; j += 1) {
        const extendsRun =
          j > 0 &&
          next[j - 1] === true &&
          (token.kind === "globstar" || path.charAt(j - 1) !== "/");
        next[j] = current[j] === true || extendsRun;
      }
    }
    current = next;
  }
  return current[n] === true;
}

/** True when the URL path matches any of the glob patterns. */
export function isExcluded(url: string, patterns: string[]): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return patterns.some((pattern) => globMatches(pattern, pathname));
}

/**
 * The www or apex counterpart of a host. Null for IP addresses, localhost,
 * single-label hosts and any other subdomain.
 */
export function siblingHost(hostname: string): string | null {
  const host = hostname.trim().toLowerCase();
  if (host === "" || host === "localhost") return null;
  if (host.includes(":") || host.startsWith("[")) return null;
  if (/^\d+(?:\.\d+){3}$/.test(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => label === "")) return null;
  if (labels[0] === "www") {
    return labels.length >= 3 ? labels.slice(1).join(".") : null;
  }
  return labels.length === 2 ? `www.${host}` : null;
}
