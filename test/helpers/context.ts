import {
  DEFAULT_OPTIONS,
  type AssetRecord,
  type PageRecord,
  type ParsedDocument,
  type SiteContext,
} from "../../src/types.js";

const ORIGIN = "https://site.example";

/**
 * A clean document: nothing in it should make any check fail. Override single fields to
 * build the nearest failing case.
 */
export function makeDoc(over: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    title: "Example site home page for tests",
    titleCount: 1,
    metaDescription:
      "A fixture description for the example site home page, written to sit comfortably inside the usual length range for search.",
    metaRobots: [],
    canonicals: [`${ORIGIN}/`],
    lang: "en",
    hasViewport: true,
    headings: [{ level: 1, text: "Welcome" }],
    openGraph: {
      "og:title": "Example site home page for tests",
      "og:description": "A fixture description for the example site home page.",
      "og:image": `${ORIGIN}/share.png`,
    },
    jsonLd: [],
    links: [],
    images: [],
    scripts: [],
    stylesheets: [],
    iconLink: true,
    formControls: [],
    buttons: [],
    iframes: [],
    wordCount: 400,
    mixedContent: [],
    ...over,
  };
}

/**
 * A clean 200 HTML page at https://site.example/. Pass `doc: null` for a page with no parsed
 * document, or a partial document to override single fields of the clean one.
 */
export function makePage(
  over: Omit<Partial<PageRecord>, "doc"> & { doc?: Partial<ParsedDocument> | null } = {},
): PageRecord {
  const { doc, ...rest } = over;
  return {
    url: `${ORIGIN}/`,
    finalUrl: `${ORIGIN}/`,
    hops: [],
    status: 200,
    failure: null,
    depth: 0,
    inSitemap: false,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-encoding": "gzip",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
    responseMs: 120,
    totalMs: 150,
    bytes: 30000,
    transferBytes: 8000,
    truncated: false,
    isHtml: true,
    doc: doc === null ? null : makeDoc(doc),
    inlinks: [],
    ...rest,
  };
}

/** A clean, measured, same-origin stylesheet that is compressed and cached for a year. */
export function makeAsset(over: Partial<AssetRecord> = {}): AssetRecord {
  return {
    url: `${ORIGIN}/app.css`,
    kind: "stylesheet",
    thirdParty: false,
    status: 200,
    bytes: 20000,
    contentType: "text/css",
    contentEncoding: "gzip",
    cacheControl: "public, max-age=31536000",
    measured: true,
    usedBy: [`${ORIGIN}/`],
    ...over,
  };
}

/**
 * A fully clean context: HTTPS origin, one clean page, robots.txt present and listing a
 * sitemap, sitemap found, healthy probes, no external checks, no assets, nothing uncrawled.
 * With no overrides every check passes. Overrides replace whole top-level fields; the
 * crawled-page count in `limits` follows `pages` unless `limits` is given.
 */
export function makeContext(
  over: Partial<SiteContext> & { pages?: PageRecord[] } = {},
): SiteContext {
  const pages = over.pages ?? [makePage()];
  const startUrl = over.startUrl ?? `${ORIGIN}/`;
  return {
    startUrl,
    origin: ORIGIN,
    originNote: null,
    robots: {
      status: 200,
      present: true,
      disallowAll: false,
      sitemaps: [`${ORIGIN}/sitemap.xml`],
      crawlDelay: null,
      ignored: false,
    },
    sitemap: {
      found: true,
      urls: [],
      files: [{ url: `${ORIGIN}/sitemap.xml`, status: 200, ok: true, note: null }],
    },
    probes: {
      httpRedirectsToHttps: true,
      siblingHostRedirects: true,
      siblingHost: "www.site.example",
      soft404: false,
      favicon: true,
    },
    external: null,
    assets: [],
    limits: {
      maxPages: DEFAULT_OPTIONS.maxPages,
      maxDepth: DEFAULT_OPTIONS.maxDepth,
      pagesCrawled: pages.length,
      uncrawled: 0,
      blockedByRobots: [],
      assetsNotMeasured: 0,
      delayRaised: false,
    },
    options: { ...DEFAULT_OPTIONS, startUrl },
    ...over,
    pages,
  };
}
