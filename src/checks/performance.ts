import type { AssetRecord, Finding, PageRecord, SiteContext } from "../types.js";
import { defineCheck, htmlPages, type CheckSpec, type Emit } from "./helpers.js";

const MAX_EVIDENCE = 5;

const RESPONSE_SLOW_MS = 800;
const HTML_LARGE_BYTES = 500_000;
const COMPRESSION_MIN_BYTES = 1024;
const CACHE_MIN_SECONDS = 3600;
const WEIGHT_WARN_BYTES = 2_000_000;
const WEIGHT_ERROR_BYTES = 5_000_000;
const REQUEST_LIMIT = 80;
const IMAGE_WARN_BYTES = 300_000;
const IMAGE_ERROR_BYTES = 1_000_000;
const IMAGE_MODERN_BYTES = 100_000;
const IMAGES_BEFORE_LAZY = 3;
const HEAD_STYLESHEET_LIMIT = 4;

const COMPRESSION_CODINGS = new Set(["gzip", "br", "deflate", "zstd"]);
const LEGACY_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

function perf(spec: Parameters<typeof defineCheck>[1]): CheckSpec {
  return defineCheck("performance", spec);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function isCompressed(encoding: string | null | undefined): boolean {
  if (encoding === null || encoding === undefined) return false;
  return encoding.split(",").some((token) => COMPRESSION_CODINGS.has(token.trim().toLowerCase()));
}

/** Assets the crawler measured: asset checks only ever look at these. */
function measuredAssets(ctx: SiteContext): AssetRecord[] {
  return ctx.assets.filter((a) => a.measured && a.bytes !== null);
}

function hasMeasuredAssets(ctx: SiteContext): boolean {
  return measuredAssets(ctx).length > 0;
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

function mimeType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Bytes counted for a page: the transfer size when known, else the decoded size. */
function documentBytes(page: PageRecord): number {
  return page.transferBytes ?? page.bytes ?? 0;
}

type Weight = { total: number; notMeasured: number };

function pageWeight(ctx: SiteContext, page: PageRecord): Weight {
  let total = documentBytes(page);
  let notMeasured = 0;
  for (const asset of ctx.assets) {
    if (!asset.usedBy.includes(page.url)) continue;
    if (asset.measured && asset.bytes !== null) total += asset.bytes;
    else notMeasured += 1;
  }
  return { total, notMeasured };
}

function weightFindings(
  ctx: SiteContext,
  emit: Emit,
  inBand: (total: number) => boolean,
): Finding[] {
  return htmlPages(ctx).flatMap((page) => {
    const { total, notMeasured } = pageWeight(ctx, page);
    if (!inBand(total)) return [];
    return [
      emit(
        page.url,
        `Measured page weight is ${megabytes(total)} MB. ${notMeasured} ${plural(notMeasured, "asset", "assets")} not measured.`,
      ),
    ];
  });
}

type Img = NonNullable<PageRecord["doc"]>["images"][number];

function imageUrls(images: Img[]): string[] {
  return images.flatMap((i) => (i.url !== null ? [i.url] : []));
}

/** One finding per page for a set of images picked by `pick`. */
function perPageImages(
  ctx: SiteContext,
  emit: Emit,
  pick: (image: Img) => boolean,
  describe: (count: number) => string,
): Finding[] {
  return htmlPages(ctx).flatMap((page) => {
    const picked = (page.doc?.images ?? []).filter(pick);
    if (picked.length === 0) return [];
    return [emit(page.url, describe(picked.length), imageUrls(picked).slice(0, MAX_EVIDENCE))];
  });
}

function assetFindings(
  ctx: SiteContext,
  emit: Emit,
  pick: (asset: AssetRecord) => string | null,
): Finding[] {
  return measuredAssets(ctx).flatMap((asset) => {
    const detail = pick(asset);
    return detail === null ? [] : [emit(asset.url, detail, asset.usedBy.slice(0, MAX_EVIDENCE))];
  });
}

/** Why an asset's cache headers fall short, or null when they are fine. */
function cacheProblem(asset: AssetRecord): string | null {
  const raw = asset.cacheControl;
  if (raw === null) return "No Cache-Control or Expires header.";
  if (raw === "expires") return null;
  const value = raw.toLowerCase();
  const directives = value.split(",").map((d) => d.trim());
  if (directives.includes("no-store")) return "Cache-Control says no-store.";
  const maxAge = directives
    .map((d) => /^max-age\s*=\s*"?(\d+)"?$/.exec(d)?.[1])
    .find((n) => n !== undefined);
  if (maxAge !== undefined) {
    const seconds = Number(maxAge);
    return seconds < CACHE_MIN_SECONDS
      ? `Cache lifetime is ${seconds} seconds, under one hour (${CACHE_MIN_SECONDS}).`
      : null;
  }
  if (directives.includes("immutable")) return null;
  return "Cache-Control has no max-age and there is no Expires header.";
}

function imageSize(asset: AssetRecord): string {
  return `${asset.bytes ?? 0} bytes`;
}

export const PERFORMANCE_CHECKS: CheckSpec[] = [
  perf({
    id: "PERF-RESP-001",
    severity: "warning",
    scope: "page",
    title: "Slow server response",
    why: "A slow first response delays everything that follows, and visitors notice.",
    fix: "Look at server work before the HTML is sent: slow queries, missing page caching, or an underpowered host.",
    heuristic:
      "Fails above 800 ms. This is one measurement from the auditing machine, so treat it as a guide and not a benchmark.",
    run: (ctx, emit) =>
      htmlPages(ctx)
        .filter((p) => p.responseMs !== null && p.responseMs > RESPONSE_SLOW_MS)
        .map((p) =>
          emit(p.url, `Response took ${p.responseMs} ms (single measurement from this machine).`),
        ),
  }),
  perf({
    id: "PERF-HTML-010",
    severity: "warning",
    scope: "page",
    title: "HTML document is very large",
    why: "Large documents take longer to download and parse, especially on slow mobile connections.",
    fix: "Remove inline data and repeated markup, and load long lists in parts.",
    heuristic:
      "Fails above 500 KB (500000 bytes) of decoded HTML. A rule of thumb, not a hard limit.",
    run: (ctx, emit) =>
      htmlPages(ctx)
        .filter((p) => p.bytes !== null && p.bytes > HTML_LARGE_BYTES)
        .map((p) => emit(p.url, `The HTML document is ${p.bytes} bytes decoded.`)),
  }),
  perf({
    id: "PERF-COMP-020",
    severity: "error",
    scope: "page",
    title: "HTML is served without compression",
    why: "Compression usually cuts the size of HTML by a large share, so pages load faster for every visitor.",
    fix: "Turn on gzip or Brotli compression for HTML responses in the web server or CDN.",
    heuristic:
      "Only documents over 1 KB (1024 bytes) are checked, because compressing tiny files gains little.",
    run: (ctx, emit) =>
      htmlPages(ctx)
        .filter(
          (p) =>
            p.bytes !== null &&
            p.bytes > COMPRESSION_MIN_BYTES &&
            !isCompressed(p.headers["content-encoding"]),
        )
        .map((p) =>
          emit(
            p.url,
            `The ${p.bytes} byte HTML response has no gzip, br, deflate or zstd encoding.`,
          ),
        ),
  }),
  perf({
    id: "PERF-COMP-021",
    severity: "warning",
    scope: "site",
    title: "Script or stylesheet served without compression",
    why: "Text assets compress well. Sending them as they are wastes bandwidth and slows rendering.",
    fix: "Turn on gzip or Brotli compression for JavaScript and CSS files.",
    heuristic: "Only files over 1 KB (1024 bytes) are checked.",
    applies: hasMeasuredAssets,
    run: (ctx, emit) =>
      assetFindings(ctx, emit, (a) =>
        (a.kind === "script" || a.kind === "stylesheet") &&
        (a.bytes ?? 0) > COMPRESSION_MIN_BYTES &&
        !isCompressed(a.contentEncoding)
          ? `The ${a.bytes} byte ${a.kind} has no compression.`
          : null,
      ),
  }),
  perf({
    id: "PERF-CACHE-030",
    severity: "warning",
    scope: "site",
    title: "Static asset is not cached for long",
    why: "Without a cache lifetime, returning visitors download the same files again on every visit.",
    fix: "Send Cache-Control with a max-age of at least one hour, and a year for files whose names change when they change.",
    heuristic:
      "Fails when there is no max-age and no Expires, when max-age is under 3600 seconds, or on no-store. Only measured assets on the audited origin are checked.",
    applies: hasMeasuredAssets,
    run: (ctx, emit) => assetFindings(ctx, emit, (a) => (a.thirdParty ? null : cacheProblem(a))),
  }),
  perf({
    id: "PERF-WEIGHT-040",
    severity: "warning",
    scope: "page",
    title: "Page is heavy",
    why: "Heavy pages load slowly on mobile connections and use up visitors' data.",
    fix: "Compress and resize images first, then remove scripts and fonts the page does not need.",
    heuristic:
      "Fails above 2 MB (2000000 bytes) and up to 5 MB, counting the HTML and the assets that were measured. Assets that were not measured are not counted, and the finding says how many.",
    run: (ctx, emit) =>
      weightFindings(ctx, emit, (t) => t > WEIGHT_WARN_BYTES && t <= WEIGHT_ERROR_BYTES),
  }),
  perf({
    id: "PERF-WEIGHT-041",
    severity: "error",
    scope: "page",
    title: "Page is very heavy",
    why: "Pages this large are slow on most connections and often fail to load on poor ones.",
    fix: "Compress and resize images first, then remove scripts and fonts the page does not need.",
    heuristic:
      "Fails above 5 MB (5000000 bytes), counting the HTML and the assets that were measured. This replaces the 2 MB warning for the same page.",
    run: (ctx, emit) => weightFindings(ctx, emit, (t) => t > WEIGHT_ERROR_BYTES),
  }),
  perf({
    id: "PERF-REQ-042",
    severity: "info",
    scope: "page",
    title: "Page references many resources",
    why: "Each script, stylesheet and image is another request, which adds delay on slow connections.",
    fix: "Combine small files, drop unused ones, and lazy load images below the fold.",
    heuristic: "Fails above 80 unique scripts, stylesheets and images. A rule of thumb.",
    run: (ctx, emit) =>
      htmlPages(ctx).flatMap((page) => {
        const doc = page.doc;
        if (doc === null) return [];
        const urls = new Set<string>();
        for (const s of doc.scripts) if (!s.inline && s.url !== null) urls.add(s.url);
        for (const s of doc.stylesheets) urls.add(s.url);
        for (const i of doc.images) if (i.url !== null) urls.add(i.url);
        if (urls.size <= REQUEST_LIMIT) return [];
        return [
          emit(
            page.url,
            `The page references ${urls.size} unique scripts, stylesheets and images.`,
          ),
        ];
      }),
  }),
  perf({
    id: "PERF-IMG-050",
    severity: "warning",
    scope: "site",
    title: "Large image",
    why: "Large images are the most common reason a page is slow to load.",
    fix: "Resize the image to the size it is shown at and compress it, or use a modern format such as WebP or AVIF.",
    heuristic: "Fails above 300 KB (300000 bytes) and up to 1 MB. A rule of thumb.",
    applies: hasMeasuredAssets,
    run: (ctx, emit) =>
      assetFindings(ctx, emit, (a) =>
        a.kind === "image" &&
        (a.bytes ?? 0) > IMAGE_WARN_BYTES &&
        (a.bytes ?? 0) <= IMAGE_ERROR_BYTES
          ? `The image is ${imageSize(a)}.`
          : null,
      ),
  }),
  perf({
    id: "PERF-IMG-051",
    severity: "error",
    scope: "site",
    title: "Very large image",
    why: "An image this large can take seconds to load and uses a lot of mobile data.",
    fix: "Resize the image to the size it is shown at and compress it, or use a modern format such as WebP or AVIF.",
    heuristic:
      "Fails above 1 MB (1000000 bytes). This replaces the 300 KB warning for the same image.",
    applies: hasMeasuredAssets,
    run: (ctx, emit) =>
      assetFindings(ctx, emit, (a) =>
        a.kind === "image" && (a.bytes ?? 0) > IMAGE_ERROR_BYTES
          ? `The image is ${imageSize(a)}.`
          : null,
      ),
  }),
  perf({
    id: "PERF-IMG-052",
    severity: "warning",
    scope: "page",
    title: "Images without width and height",
    why: "Without both attributes the browser cannot reserve space, so the page jumps as images load.",
    fix: "Add width and height attributes that match the image's own size, and let CSS scale it.",
    heuristic: "Decorative images are counted too, because layout shift applies to them as well.",
    run: (ctx, emit) =>
      perPageImages(
        ctx,
        emit,
        (i) => i.url !== null && (!i.width || !i.height),
        (n) => `${n} ${plural(n, "image lacks", "images lack")} a width or height attribute.`,
      ),
  }),
  perf({
    id: "PERF-IMG-053",
    severity: "info",
    scope: "page",
    title: "Images below the fold are not lazy loaded",
    why: "Images far down the page compete with the content visitors see first.",
    fix: 'Add loading="lazy" to images that start below the first screen.',
    heuristic:
      "Counts images after the third in the document. Position in the document is a proxy for being below the fold.",
    run: (ctx, emit) =>
      perPageImages(
        ctx,
        emit,
        (i) => i.index >= IMAGES_BEFORE_LAZY && i.loading !== "lazy",
        (n) =>
          `${n} ${plural(n, "image after the third is", "images after the third are")} not lazy loaded.`,
      ),
  }),
  perf({
    id: "PERF-IMG-054",
    severity: "info",
    scope: "site",
    title: "Large JPEG or PNG",
    why: "Modern formats such as WebP and AVIF are often smaller at the same quality.",
    fix: "Convert the image to WebP or AVIF, and keep the old format as a fallback only if needed.",
    heuristic:
      "Fails for JPEG and PNG files over 100 KB (100000 bytes). A modern format may be smaller, but not always.",
    applies: hasMeasuredAssets,
    run: (ctx, emit) =>
      assetFindings(ctx, emit, (a) =>
        a.kind === "image" &&
        (a.bytes ?? 0) > IMAGE_MODERN_BYTES &&
        LEGACY_IMAGE_TYPES.has(mimeType(a.contentType))
          ? `The ${mimeType(a.contentType)} image is ${imageSize(a)}.`
          : null,
      ),
  }),
  perf({
    id: "PERF-BLOCK-060",
    severity: "warning",
    scope: "page",
    title: "Render-blocking script in the head",
    why: "A script in the head without async or defer stops the browser from showing the page until it has loaded and run.",
    fix: "Add defer, or async for independent scripts, or move the script to the end of the body.",
    heuristic: null,
    run: (ctx, emit) =>
      htmlPages(ctx).flatMap((page) => {
        const blocking = (page.doc?.scripts ?? []).filter(
          (s) => s.inHead && !s.inline && !s.async && !s.defer && !s.module,
        );
        if (blocking.length === 0) return [];
        const urls = blocking.flatMap((s) => (s.url !== null ? [s.url] : []));
        return [
          emit(
            page.url,
            `${blocking.length} ${plural(blocking.length, "script in the head blocks", "scripts in the head block")} rendering.`,
            urls.slice(0, MAX_EVIDENCE),
          ),
        ];
      }),
  }),
  perf({
    id: "PERF-BLOCK-061",
    severity: "info",
    scope: "page",
    title: "Many stylesheets in the head",
    why: "The browser waits for every stylesheet in the head before it draws the page.",
    fix: "Combine stylesheets, or inline the critical rules and load the rest later.",
    heuristic: "Fails above 4 stylesheets in the head. A rule of thumb.",
    run: (ctx, emit) =>
      htmlPages(ctx).flatMap((page) => {
        const sheets = (page.doc?.stylesheets ?? []).filter((s) => s.inHead);
        if (sheets.length <= HEAD_STYLESHEET_LIMIT) return [];
        return [
          emit(
            page.url,
            `The head has ${sheets.length} stylesheets.`,
            sheets.map((s) => s.url).slice(0, MAX_EVIDENCE),
          ),
        ];
      }),
  }),
];
