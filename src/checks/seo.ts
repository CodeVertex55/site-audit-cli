import { normaliseUrl, sameOrigin } from "../crawl/url.js";
import type { Finding, PageRecord, SiteContext } from "../types.js";
import {
  defineCheck,
  findPage,
  htmlPages,
  indexablePages,
  isNoindex,
  type CheckSpec,
  type Emit,
} from "./helpers.js";

const MAX_OTHERS = 5;

/** The crawler's note for a sitemap index nested below the first level. Not a parse failure. */
const NESTED_INDEX_NOTE = "nested sitemap index not followed";

function seo(spec: Parameters<typeof defineCheck>[1]): CheckSpec {
  return defineCheck("seo", spec);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function chars(text: string): number {
  return Array.from(text.trim()).length;
}

/** True when the page names another member of `set` as its canonical. */
function canonicalisedElsewhere(page: PageRecord, set: PageRecord[]): boolean {
  const own = new Set([page.url, page.finalUrl]);
  const others = new Set(set.filter((p) => p !== page).flatMap((p) => [p.url, p.finalUrl]));
  return (page.doc?.canonicals ?? []).some((c) => {
    const target = normaliseUrl(c) ?? c;
    return !own.has(target) && others.has(target);
  });
}

type DuplicateEntry = { page: PageRecord; others: string[] };

/**
 * Pages that share a trimmed, case-insensitive value. A page whose canonical points at
 * another page in the same set is a variant of it, not a duplicate.
 */
function duplicateSets(
  ctx: SiteContext,
  valueOf: (page: PageRecord) => string | null | undefined,
): DuplicateEntry[] {
  const groups = new Map<string, PageRecord[]>();
  for (const page of indexablePages(ctx)) {
    const value = valueOf(page)?.trim().toLowerCase();
    if (value === undefined || value === "") continue;
    const list = groups.get(value);
    if (list === undefined) groups.set(value, [page]);
    else list.push(page);
  }
  const out: DuplicateEntry[] = [];
  for (const set of groups.values()) {
    const kept = set.filter((p) => !canonicalisedElsewhere(p, set));
    if (kept.length < 2) continue;
    for (const page of kept) {
      out.push({ page, others: kept.filter((p) => p !== page).map((p) => p.url) });
    }
  }
  return out;
}

function reportDuplicates(entries: DuplicateEntry[], emit: Emit, what: string): Finding[] {
  return entries.map(({ page, others }) =>
    emit(
      page.url,
      `${what} is shared with ${others.length} other indexable ${plural(others.length, "page", "pages")}.`,
      others.slice(0, MAX_OTHERS),
    ),
  );
}

function isStartPage(ctx: SiteContext, page: PageRecord): boolean {
  return page.url === ctx.startUrl || page.finalUrl === ctx.startUrl;
}

/** True when the crawler tried at least one sitemap file. */
function hasSitemapFiles(ctx: SiteContext): boolean {
  return ctx.sitemap.files.length > 0;
}

/** Statuses a site sends when it is limiting requests; such a target was not judged. */
function isThrottled(status: number | null): boolean {
  return status === 429 || status === 503;
}

/** Why SEO-MAP-090 fired, from what robots.txt named and what the crawler recorded. */
function missingSitemapDetail(ctx: SiteContext): string {
  if (ctx.robots.sitemaps.length === 0) {
    return "No sitemap was named in robots.txt and none was found at /sitemap.xml.";
  }
  const named = new Set(ctx.robots.sitemaps);
  const unread = ctx.sitemap.files.find((f) => named.has(f.url) && !f.ok);
  const reason =
    unread?.note ??
    (unread?.status === null || unread === undefined ? null : `status ${unread.status}`);
  return reason === null
    ? "robots.txt names a sitemap, but it could not be read."
    : `robots.txt names a sitemap, but it could not be read: ${reason}.`;
}

function originOfUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export const SEO_CHECKS: CheckSpec[] = [
  seo({
    id: "SEO-TITLE-001",
    severity: "error",
    scope: "page",
    title: "Page has no title",
    why: "The title is the main heading shown in search results and browser tabs. Without one, search engines pick their own text.",
    fix: "Add a unique <title> that describes the page in about 50 to 60 characters.",
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx)
        .filter((p) => (p.doc?.title ?? "").trim() === "")
        .map((p) => emit(p.url, "No <title> element, or it is empty.")),
  }),
  seo({
    id: "SEO-TITLE-002",
    severity: "info",
    scope: "page",
    title: "Title is very short or very long",
    why: "Very short titles say little about the page. Search results cut long titles off, so the end may never be seen.",
    fix: "Aim for a title between 10 and 60 characters that puts the main words first.",
    heuristic:
      "Fails below 10 or above 60 characters. Search results truncate by pixel width, so 60 characters is a rule of thumb.",
    run: (ctx, emit) =>
      indexablePages(ctx).flatMap((p) => {
        const title = p.doc?.title ?? "";
        if (title.trim() === "") return [];
        const length = chars(title);
        if (length >= 10 && length <= 60) return [];
        return [emit(p.url, `Title is ${length} characters long. A typical range is 10 to 60.`)];
      }),
  }),
  seo({
    id: "SEO-TITLE-003",
    severity: "warning",
    scope: "page",
    title: "Title is shared with other pages",
    why: "Pages with the same title are hard to tell apart in search results and in browser tabs.",
    fix: "Give each page its own title that describes what is unique about it.",
    heuristic: null,
    run: (ctx, emit) =>
      reportDuplicates(
        duplicateSets(ctx, (p) => p.doc?.title),
        emit,
        "Title",
      ),
  }),
  seo({
    id: "SEO-TITLE-004",
    severity: "warning",
    scope: "page",
    title: "Page has more than one title",
    why: "Browsers and search engines have to choose between the titles, and they may choose the wrong one.",
    fix: "Keep a single <title> element in the document head and remove the rest.",
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx)
        .filter((p) => (p.doc?.titleCount ?? 0) > 1)
        .map((p) => emit(p.url, `The page has ${p.doc?.titleCount ?? 0} <title> elements.`)),
  }),
  seo({
    id: "SEO-DESC-010",
    severity: "warning",
    scope: "page",
    title: "Page has no meta description",
    why: "Search engines often use the meta description as the snippet under the title. Without one they choose text from the page.",
    fix: 'Add a <meta name="description"> that summarises the page in one or two sentences.',
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx)
        .filter((p) => (p.doc?.metaDescription ?? "").trim() === "")
        .map((p) => emit(p.url, "No meta description, or it is empty.")),
  }),
  seo({
    id: "SEO-DESC-011",
    severity: "info",
    scope: "page",
    title: "Meta description is very short or very long",
    why: "A very short description gives searchers little reason to click. Search results cut long descriptions off.",
    fix: "Write a description between 50 and 160 characters that says what the page offers.",
    heuristic:
      "Fails below 50 or above 160 characters. Snippet length varies by device and query, so 160 characters is a rule of thumb.",
    run: (ctx, emit) =>
      indexablePages(ctx).flatMap((p) => {
        const text = p.doc?.metaDescription ?? "";
        if (text.trim() === "") return [];
        const length = chars(text);
        if (length >= 50 && length <= 160) return [];
        return [
          emit(
            p.url,
            `Meta description is ${length} characters long. A typical range is 50 to 160.`,
          ),
        ];
      }),
  }),
  seo({
    id: "SEO-DESC-012",
    severity: "warning",
    scope: "page",
    title: "Meta description is shared with other pages",
    why: "Identical descriptions make different pages look the same in search results.",
    fix: "Write a description for each page that reflects its own content.",
    heuristic: null,
    run: (ctx, emit) =>
      reportDuplicates(
        duplicateSets(ctx, (p) => p.doc?.metaDescription),
        emit,
        "Meta description",
      ),
  }),
  seo({
    id: "SEO-H1-020",
    severity: "warning",
    scope: "page",
    title: "Page has no h1 heading",
    why: "The h1 tells readers and search engines what the page is about.",
    fix: "Add one <h1> that states the topic of the page.",
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx)
        .filter((p) => !(p.doc?.headings ?? []).some((h) => h.level === 1))
        .map((p) => emit(p.url, "No <h1> heading found.")),
  }),
  seo({
    id: "SEO-H1-021",
    severity: "info",
    scope: "page",
    title: "Page has more than one h1 heading",
    why: "HTML allows more than one h1, but a single one keeps the page outline clear for readers and search engines.",
    fix: "Use one <h1> for the page topic and <h2> or lower for sections.",
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx).flatMap((p) => {
        const count = (p.doc?.headings ?? []).filter((h) => h.level === 1).length;
        return count > 1 ? [emit(p.url, `The page has ${count} <h1> headings.`)] : [];
      }),
  }),
  seo({
    id: "SEO-CANON-030",
    severity: "warning",
    scope: "page",
    title: "Page has no canonical link",
    why: "A canonical link tells search engines which URL to index when the same content is reachable at several addresses.",
    fix: 'Add <link rel="canonical"> pointing at the preferred URL of the page, usually the page itself.',
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx)
        .filter((p) => (p.doc?.canonicals ?? []).length === 0)
        .map((p) => emit(p.url, "No canonical link found.")),
  }),
  seo({
    id: "SEO-CANON-031",
    severity: "error",
    scope: "page",
    title: "Page has conflicting canonical links",
    why: "When the canonical links disagree, search engines may ignore them and choose for themselves.",
    fix: "Keep one canonical link per page. Check whether a plugin or theme adds a second one.",
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx).flatMap((p) => {
        const targets = [...new Set(p.doc?.canonicals ?? [])];
        return targets.length > 1
          ? [emit(p.url, `The page names ${targets.length} different canonical URLs.`, targets)]
          : [];
      }),
  }),
  seo({
    id: "SEO-CANON-032",
    severity: "error",
    scope: "page",
    title: "Canonical points to a broken or redirecting URL",
    why: "A canonical that does not return a normal page sends search engines to a dead end, so the page may drop out of the index.",
    fix: "Point the canonical at the final URL of a page that returns status 200.",
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx).flatMap((p) => {
        const out: Finding[] = [];
        for (const canonical of new Set(p.doc?.canonicals ?? [])) {
          const target = findPage(ctx, canonical);
          if (target === undefined || target === p) continue;
          if (target.failure === "blocked-by-robots" || isThrottled(target.status)) continue;
          if (target.hops.length > 0) {
            out.push(emit(p.url, "The canonical URL redirects to another address.", [canonical]));
          } else if (target.status !== 200) {
            const got =
              target.status === null ? "failed to load" : `returned status ${target.status}`;
            out.push(emit(p.url, `The canonical URL ${got}.`, [canonical]));
          }
        }
        return out;
      }),
  }),
  seo({
    id: "SEO-CANON-033",
    severity: "warning",
    scope: "page",
    title: "Canonical points to a different origin",
    why: "A canonical on another host or scheme asks search engines to index that other site instead of this page.",
    fix: "Use a canonical on the same scheme and host as the page, unless the move is intended.",
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx).flatMap((p) => {
        const away = [...new Set(p.doc?.canonicals ?? [])].filter((c) => {
          const origin = originOfUrl(c);
          return origin !== null && origin !== ctx.origin;
        });
        return away.length > 0
          ? [emit(p.url, "The canonical URL is on a different origin.", away)]
          : [];
      }),
  }),
  seo({
    id: "SEO-INDEX-040",
    severity: "info",
    scope: "page",
    title: "Page is set to noindex",
    why: "Search engines will not list a noindex page. This is listed so you can confirm it is intended.",
    fix: "If the page should appear in search, remove the noindex directive from the meta robots tag and the X-Robots-Tag header.",
    heuristic: null,
    run: (ctx, emit) =>
      htmlPages(ctx)
        .filter(isNoindex)
        .map((p) => emit(p.url, "The page carries a noindex directive.")),
  }),
  seo({
    id: "SEO-INDEX-041",
    severity: "error",
    scope: "page",
    title: "A noindex page is listed in the sitemap",
    why: "The sitemap says the page should be indexed while the page says it should not, so the two signals contradict each other.",
    fix: "Remove the page from the sitemap, or remove the noindex directive.",
    heuristic: null,
    run: (ctx, emit) =>
      htmlPages(ctx)
        .filter((p) => isNoindex(p) && p.inSitemap)
        .map((p) => emit(p.url, "The page is noindex but is listed in the sitemap.")),
  }),
  seo({
    id: "SEO-INDEX-042",
    severity: "error",
    scope: "site",
    title: "A sitemap URL is blocked by robots.txt",
    why: "The sitemap offers a URL that robots.txt forbids crawlers to fetch. Search engines cannot read a page they may not crawl.",
    fix: "Remove the URL from the sitemap, or change the robots.txt rule that blocks it.",
    heuristic: null,
    // With robots.txt ignored the crawler never records blocked URLs, so nothing was evaluated.
    applies: (ctx) => !ctx.robots.ignored && ctx.sitemap.urls.length > 0,
    run: (ctx, emit) => {
      const blocked = new Set(ctx.limits.blockedByRobots);
      return ctx.sitemap.urls
        .filter((url) => blocked.has(url))
        .map((url) => emit(url, "The URL is in the sitemap and disallowed by robots.txt."));
    },
  }),
  seo({
    id: "SEO-INDEX-043",
    severity: "error",
    scope: "page",
    title: "The start page is set to noindex",
    why: "A noindex start page keeps the home of the site out of search results.",
    fix: "Remove the noindex directive from the start page meta robots tag and X-Robots-Tag header.",
    heuristic: null,
    run: (ctx, emit) =>
      ctx.pages
        .filter((p) => isStartPage(ctx, p) && isNoindex(p))
        .slice(0, 1)
        .map((p) => emit(p.url, "The start page carries a noindex directive.")),
  }),
  seo({
    id: "SEO-LANG-050",
    severity: "warning",
    scope: "page",
    title: "Page has no lang attribute",
    why: "The lang attribute tells browsers, search engines and screen readers which language the page is in.",
    fix: 'Add a lang attribute to the <html> element, for example <html lang="en">.',
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx)
        .filter((p) => (p.doc?.lang ?? "").trim() === "")
        .map((p) => emit(p.url, "The <html> element has no lang attribute.")),
  }),
  seo({
    id: "SEO-VIEW-051",
    severity: "error",
    scope: "page",
    title: "Page has no viewport meta tag",
    why: "Without a viewport tag, phones show the page zoomed out as a desktop layout, which is hard to read and use.",
    fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head.',
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx)
        .filter((p) => p.doc?.hasViewport === false)
        .map((p) => emit(p.url, "No viewport meta tag found.")),
  }),
  seo({
    id: "SEO-OG-060",
    severity: "info",
    scope: "page",
    title: "Open Graph tags are missing",
    why: "Open Graph tags control the title, text and image shown when the page is shared on social networks and in chat apps.",
    fix: "Add og:title, og:description and og:image meta tags to the head.",
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx).flatMap((p) => {
        const graph = p.doc?.openGraph ?? {};
        const missing = ["og:title", "og:description", "og:image"].filter(
          (key) => (graph[key] ?? "").trim() === "",
        );
        return missing.length > 0 ? [emit(p.url, `Missing ${missing.join(", ")}.`)] : [];
      }),
  }),
  seo({
    id: "SEO-LD-070",
    severity: "warning",
    scope: "page",
    title: "Structured data is not valid JSON",
    why: "Search engines skip a JSON-LD block they cannot parse, so the page loses any rich results it was meant to earn.",
    fix: "Fix the syntax of the JSON-LD block. A JSON validator will point at the error.",
    heuristic: null,
    run: (ctx, emit) =>
      indexablePages(ctx).flatMap((p) => {
        const blocks = p.doc?.jsonLd ?? [];
        if (blocks.every((b) => b.ok)) return [];
        return [emit(p.url, "A JSON-LD block is not valid JSON.")];
      }),
  }),
  seo({
    id: "SEO-ROBOTS-080",
    severity: "warning",
    scope: "site",
    title: "No robots.txt file",
    why: "Crawlers look for robots.txt first. Without one they assume everything may be crawled and they cannot find the sitemap from it.",
    fix: "Publish a robots.txt at the root of the site, even a short one that links to the sitemap.",
    heuristic: null,
    applies: () => true,
    run: (ctx, emit) => {
      const status = ctx.robots.status;
      return status !== null && status >= 400 && status < 500
        ? [emit(null, `robots.txt returned status ${status}.`)]
        : [];
    },
  }),
  seo({
    id: "SEO-ROBOTS-081",
    severity: "error",
    scope: "site",
    title: "robots.txt blocks the whole site",
    why: "It tells search engine crawlers not to fetch any page of the site.",
    fix: "Remove the Disallow: / rule for the all-crawlers group, unless the site is meant to stay private.",
    heuristic: null,
    applies: () => true,
    run: (ctx, emit) =>
      ctx.robots.disallowAll
        ? [emit(null, "robots.txt disallows every URL for all crawlers.")]
        : [],
  }),
  seo({
    id: "SEO-ROBOTS-082",
    severity: "error",
    scope: "site",
    title: "robots.txt returns a server error",
    why: "When robots.txt answers with a server error, search engines may stop crawling the site until it recovers.",
    fix: "Make robots.txt answer with status 200, or status 404 if you have none. Check the server logs for the error.",
    heuristic: null,
    applies: () => true,
    run: (ctx, emit) => {
      const status = ctx.robots.status;
      return status !== null && status >= 500
        ? [emit(null, `robots.txt returned status ${status}.`)]
        : [];
    },
  }),
  seo({
    id: "SEO-MAP-090",
    severity: "warning",
    scope: "site",
    title: "No sitemap found",
    why: "A sitemap helps search engines find every page, especially new pages and pages with few links to them.",
    fix: "Publish a sitemap.xml and list it in robots.txt.",
    heuristic: null,
    applies: () => true,
    // A sitemap that answered 200 but was invalid is reported by SEO-MAP-093, not here.
    run: (ctx, emit) =>
      ctx.sitemap.found || ctx.sitemap.files.some((f) => f.status === 200)
        ? []
        : [emit(null, missingSitemapDetail(ctx))],
  }),
  seo({
    id: "SEO-MAP-091",
    severity: "info",
    scope: "site",
    title: "robots.txt does not reference the sitemap",
    why: "A Sitemap line in robots.txt lets every crawler find the sitemap without being told about it.",
    fix: "Add a line such as Sitemap: https://example.com/sitemap.xml to robots.txt.",
    heuristic: null,
    applies: hasSitemapFiles,
    run: (ctx, emit) =>
      ctx.sitemap.found && ctx.robots.sitemaps.length === 0
        ? [emit(null, "A sitemap exists but robots.txt has no Sitemap line.")]
        : [],
  }),
  seo({
    id: "SEO-MAP-092",
    severity: "error",
    scope: "site",
    title: "A sitemap URL does not return status 200",
    why: "The sitemap should list only live pages. Broken or redirecting entries waste crawl effort.",
    fix: "Remove the URL from the sitemap, or list its final address.",
    heuristic: null,
    applies: hasSitemapFiles,
    run: (ctx, emit) =>
      ctx.pages.flatMap((p) => {
        if (!p.inSitemap || p.failure === "blocked-by-robots" || isThrottled(p.status)) return [];
        if (p.status !== 200) {
          const got = p.status === null ? "the fetch failed" : `it returned status ${p.status}`;
          return [emit(p.url, `The URL is in the sitemap but ${got}.`)];
        }
        if (p.hops.length > 0) {
          const hops = `${p.hops.length} ${plural(p.hops.length, "hop", "hops")}`;
          return [emit(p.url, `The URL is in the sitemap but redirects (${hops}).`, [p.finalUrl])];
        }
        return [];
      }),
  }),
  seo({
    id: "SEO-MAP-093",
    severity: "error",
    scope: "site",
    title: "A sitemap file could not be parsed",
    why: "Search engines ignore a sitemap they cannot read, so none of its URLs are submitted.",
    fix: "Check that the file is valid sitemap XML and is served with status 200.",
    heuristic: null,
    applies: hasSitemapFiles,
    run: (ctx, emit) =>
      ctx.sitemap.files
        .filter((f) => !f.ok && f.status === 200 && f.note !== null && f.note !== NESTED_INDEX_NOTE)
        .map((f) => emit(f.url, `The sitemap file could not be parsed (${f.note ?? "unknown"}).`)),
  }),
  seo({
    id: "SEO-MAP-094",
    severity: "info",
    scope: "page",
    title: "A sitemap URL is not linked from any crawled page",
    why: "A page that nothing links to is hard for visitors and crawlers to reach. It may be an orphan.",
    fix: "Link the page from a relevant page or the navigation, or remove it from the sitemap if it is retired.",
    heuristic:
      "Only evaluated when the crawl was not cut short, because an uncrawled page might hold the missing link.",
    applies: (ctx) => ctx.limits.uncrawled === 0 && htmlPages(ctx).length > 0,
    run: (ctx, emit) => {
      // A page reached only through a redirect is linked on the record of the redirecting URL.
      const linkedAddresses = new Set(
        ctx.pages.filter((p) => p.inlinks.length > 0).map((p) => p.finalUrl),
      );
      return htmlPages(ctx)
        .filter(
          (p) =>
            p.inSitemap &&
            p.inlinks.length === 0 &&
            !isStartPage(ctx, p) &&
            !linkedAddresses.has(p.url) &&
            sameOrigin(p.url, ctx.origin),
        )
        .map((p) => emit(p.url, "Listed in the sitemap, but no crawled page links to it."));
    },
  }),
  seo({
    id: "SEO-THIN-100",
    severity: "info",
    scope: "page",
    title: "Page has little text",
    why: "Pages with very little text give search engines little to rank. Some pages, such as contact or gallery pages, are fine this way.",
    fix: "If the page should rank, add useful text that answers what visitors come for.",
    heuristic:
      "Fails below 150 words of visible text. This is a rule of thumb and may be fine for contact or gallery pages.",
    run: (ctx, emit) =>
      indexablePages(ctx).flatMap((p) => {
        const words = p.doc?.wordCount ?? 0;
        return words < 150 ? [emit(p.url, `The page has ${words} words of visible text.`)] : [];
      }),
  }),
];
