import * as cheerio from "cheerio";
import { normaliseUrl } from "./url.js";

export type ParsedSitemap = { kind: "urlset" | "index" | "invalid"; urls: string[] };

const DEFAULT_CAP = 5000;

/**
 * Parse a sitemap or sitemap index. `urls` holds the trimmed, normalised,
 * de-duplicated `<loc>` values, at most `cap` of them.
 */
export function parseSitemap(xml: string, cap: number = DEFAULT_CAP): ParsedSitemap {
  const $ = cheerio.load(xml, { xml: true });
  const root = $.root().children().first();
  const rootName = (root.prop("tagName") ?? "").toString().toLowerCase();

  let kind: ParsedSitemap["kind"];
  let entry: string;
  if (rootName === "sitemapindex") {
    kind = "index";
    entry = "sitemap";
  } else if (rootName === "urlset") {
    kind = "urlset";
    entry = "url";
  } else {
    return { kind: "invalid", urls: [] };
  }

  const seen = new Set<string>();
  const urls: string[] = [];
  for (const element of $(`${entry} > loc`).toArray()) {
    if (urls.length >= cap) break;
    const normalised = normaliseUrl($(element).text());
    if (normalised === null || seen.has(normalised)) continue;
    seen.add(normalised);
    urls.push(normalised);
  }
  return { kind, urls };
}
