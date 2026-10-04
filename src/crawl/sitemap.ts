import { Parser } from "htmlparser2";
import { normaliseUrl } from "./url.js";

export type ParsedSitemap = { kind: "urlset" | "index" | "invalid"; urls: string[] };

const DEFAULT_CAP = 5000;
/** A sitemap needs three levels (root, entry, loc). Deeper nesting stops the read. */
const MAX_DEPTH = 16;

const INVALID: ParsedSitemap = { kind: "invalid", urls: [] };

/**
 * Parse a sitemap or sitemap index. `urls` holds the trimmed, normalised,
 * de-duplicated `<loc>` values, at most `cap` of them. The document is read as a stream of
 * tags without building a tree: only the root name and the text of `loc` elements directly
 * inside `url` (or `sitemap` in an index) are kept. The read stops at a nesting depth of 16 or
 * at the cap, and the URLs read so far are returned. Input the parser cannot handle is invalid.
 */
export function parseSitemap(xml: string, cap: number = DEFAULT_CAP): ParsedSitemap {
  try {
    return readSitemap(xml, cap);
  } catch {
    return INVALID;
  }
}

function readSitemap(xml: string, cap: number): ParsedSitemap {
  let kind: ParsedSitemap["kind"] | null = null;
  let entry = "";
  const open: string[] = [];
  // The text of the loc being read and the depth it opened at, or null outside a loc.
  let loc: { text: string; depth: number } | null = null;
  const seen = new Set<string>();
  const urls: string[] = [];
  let parser: Parser | null = null;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    parser?.pause();
  };

  parser = new Parser(
    {
      onopentag: (name) => {
        if (stopped) return;
        if (kind === null) {
          const root = name.toLowerCase();
          kind = root === "urlset" ? "urlset" : root === "sitemapindex" ? "index" : "invalid";
          entry = kind === "urlset" ? "url" : "sitemap";
          if (kind === "invalid") {
            stop();
            return;
          }
        }
        if (open.length >= MAX_DEPTH) {
          stop();
          return;
        }
        if (name === "loc" && loc === null && open[open.length - 1] === entry) {
          loc = { text: "", depth: open.length };
        }
        open.push(name);
      },
      ontext: (data) => {
        if (!stopped && loc !== null) loc.text += data;
      },
      onclosetag: () => {
        if (stopped) return;
        open.pop();
        if (loc === null || open.length !== loc.depth) return;
        const normalised = normaliseUrl(loc.text);
        loc = null;
        if (normalised === null || seen.has(normalised)) return;
        seen.add(normalised);
        urls.push(normalised);
        if (urls.length >= cap) stop();
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.end(xml);

  if (kind === null || kind === "invalid") return INVALID;
  return { kind, urls };
}
