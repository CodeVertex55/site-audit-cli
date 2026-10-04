import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { ParsedDocument } from "../types.js";
import { normaliseUrl, sameOrigin } from "./url.js";

// The element type cheerio hands out for a tag selector, without importing domhandler directly.
type Selection = ReturnType<Cheerio<never>["find"]>;
type El = Selection extends Cheerio<infer E> ? E : never;

const MAX_ERROR_LENGTH = 120;
const MAX_DESCRIBE_VALUE = 40;
const NON_LABELLED_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset"]);
const SKIPPED_TEXT_ELEMENTS = "script, style, noscript, template, svg";

/** Collapse every run of whitespace to one space and trim. Linear in the input length. */
function collapse(text: string): string {
  return text
    .split(/\s+/)
    .filter((part) => part !== "")
    .join(" ");
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function attrOf(el: El, name: string): string | undefined {
  return el.attribs[name];
}

function hasText(el: El, name: string): boolean {
  return (attrOf(el, name) ?? "").trim() !== "";
}

function lowerAttr(el: El, name: string): string | null {
  const value = (attrOf(el, name) ?? "").trim().toLowerCase();
  return value === "" ? null : value;
}

function relTokens(el: El): string[] {
  return (attrOf(el, "rel") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== "");
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function splitDirectives(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
}

/**
 * Directives from an X-Robots-Tag value that apply to every crawler. A part with a
 * "bot: " prefix is for one crawler and is ignored, and so are the plain directives after it.
 */
function headerDirectives(value: string): string[] {
  const out: string[] = [];
  let scoped = false;
  for (const part of splitDirectives(value)) {
    if (part.includes(":")) {
      scoped = true;
    } else if (!scoped) {
      out.push(part);
    }
  }
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function typesOf(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>)["@type"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  return [];
}

function jsonLdTypes(parsed: unknown): string[] {
  const types: string[] = [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    types.push(...typesOf(item));
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const graph = (item as Record<string, unknown>)["@graph"];
      if (Array.isArray(graph)) {
        for (const node of graph) types.push(...typesOf(node));
      }
    }
  }
  return types;
}

function parseJsonLd(text: string): { ok: boolean; types: string[]; error: string | null } {
  try {
    return { ok: true, types: jsonLdTypes(JSON.parse(text)), error: null };
  } catch (error) {
    const message = error instanceof Error ? collapse(error.message) : "Invalid JSON";
    return { ok: false, types: [], error: clip(message, MAX_ERROR_LENGTH) };
  }
}

/** First URL of a srcset value, without splitting the whole string. */
function firstSrcsetUrl(srcset: string): string | null {
  const text = srcset.trim();
  let end = 0;
  while (end < text.length && !/\s/.test(text.charAt(end))) end += 1;
  let candidate = text.slice(0, end);
  while (candidate.endsWith(",")) candidate = candidate.slice(0, -1);
  return candidate === "" ? null : candidate;
}

// Structural view of a parsed node, enough to read text without recursion.
type TreeNode = { type: string; data?: string; children?: TreeNode[] };

/**
 * Text of an element in document order. Iterative, so deeply nested markup cannot overflow the
 * stack. Script and style content is skipped unless `rawText` is set.
 */
function textContent(el: El, rawText = false): string {
  const parts: string[] = [];
  // Cheerio's node types are an enum of string values; TreeNode reads the same fields.
  const stack: TreeNode[] = [...(el.children as unknown as TreeNode[])].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === "text") {
      parts.push(node.data ?? "");
    } else if (
      node.children !== undefined &&
      (rawText || (node.type !== "script" && node.type !== "style"))
    ) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i];
        if (child !== undefined) stack.push(child);
      }
    }
  }
  return parts.join("");
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "basefont",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
// Tags whose end tag may be left out, so they do not add nesting depth by themselves.
const AUTO_CLOSING_TAGS = new Set([
  "html",
  "head",
  "body",
  "p",
  "li",
  "dt",
  "dd",
  "tr",
  "td",
  "th",
  "thead",
  "tbody",
  "tfoot",
  "colgroup",
  "option",
  "optgroup",
  "rb",
  "rt",
  "rtc",
  "rp",
]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
const MAX_NESTING_DEPTH = 1000;

function isNameChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 58
  );
}

function isLetter(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

function matchesAt(text: string, index: number, word: string): boolean {
  if (index + word.length > text.length) return false;
  for (let i = 0; i < word.length; i += 1) {
    if ((text.charCodeAt(index + i) | 0x20) !== word.charCodeAt(i)) return false;
  }
  return true;
}

/** Index of the ">" that ends the tag starting at `from`, and whether it was written "/>". */
function tagEnd(html: string, from: number): { end: number; selfClosing: boolean } {
  let quote = 0;
  let previous = 0;
  for (let i = from; i < html.length; i += 1) {
    const code = html.charCodeAt(i);
    if (quote !== 0) {
      if (code === quote) {
        quote = 0;
        previous = code;
      }
    } else if ((code === 34 || code === 39) && previous === 61) {
      quote = code;
    } else if (code === 62) {
      return { end: i, selfClosing: previous === 47 };
    } else if (!isSpace(code)) {
      previous = code;
    }
  }
  return { end: html.length, selfClosing: false };
}

/**
 * Parsing and querying cost grows quickly with element depth, and the parser's recursion limits
 * are not ours to tune. Real pages are far shallower than the cap. When a document nests deeper,
 * only the part before the cap is kept. One linear scan, no regular expressions.
 */
function limitNesting(html: string): string {
  let depth = 0;
  let i = html.indexOf("<");
  while (i !== -1 && i < html.length - 1) {
    const next = html.charCodeAt(i + 1);
    if (next === 33 && html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i + 4);
      i = close === -1 ? -1 : html.indexOf("<", close + 3);
      continue;
    }
    const closing = next === 47;
    const nameStart = closing ? i + 2 : i + 1;
    if (!isLetter(html.charCodeAt(nameStart))) {
      i = html.indexOf("<", i + 1);
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < html.length && isNameChar(html.charCodeAt(nameEnd))) nameEnd += 1;
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const { end, selfClosing } = tagEnd(html, nameEnd);
    let resume = end + 1;
    if (!VOID_TAGS.has(name) && !AUTO_CLOSING_TAGS.has(name)) {
      if (closing) {
        depth = Math.max(0, depth - 1);
      } else if (!selfClosing) {
        depth += 1;
        if (depth > MAX_NESTING_DEPTH) return html.slice(0, i);
        if (RAW_TEXT_TAGS.has(name)) {
          // Skip the raw text up to the matching end tag.
          let close = html.indexOf("</", resume);
          while (close !== -1 && !matchesAt(html, close + 2, name))
            close = html.indexOf("</", close + 2);
          if (close === -1) return html;
          resume = close;
        }
      }
    }
    i = html.indexOf("<", resume);
  }
  return html;
}

function describeElement(el: El, attributes: string[]): string {
  let out = el.tagName.toLowerCase();
  for (const name of attributes) {
    const value = lowerOrRaw(el, name);
    if (value !== null) out += `[${name}=${clip(value, MAX_DESCRIBE_VALUE)}]`;
  }
  return out;
}

// Types and roles read better lower-cased; names and ids keep their case.
function lowerOrRaw(el: El, name: string): string | null {
  if (name === "type" || name === "role") return lowerAttr(el, name);
  const value = (attrOf(el, name) ?? "").trim();
  return value === "" ? null : value;
}

/**
 * Turn one HTML string into the facts every check reads. Pure and tolerant of broken markup.
 * `headers` supplies `x-robots-tag`.
 */
export function extractDocument(
  html: string,
  pageUrl: string,
  headers: Record<string, string> = {},
): ParsedDocument {
  const $ = load(limitNesting(html));
  const wrap = (el: El): Selection => $(el);
  const textOf = (el: El): string => collapse(textContent(el));
  const hasImageWithAlt = (el: El): boolean =>
    wrap(el)
      .find("img")
      .toArray()
      .some((img) => hasText(img, "alt"));
  const hasName = (el: El, text: string): boolean =>
    text !== "" ||
    hasText(el, "aria-label") ||
    hasText(el, "aria-labelledby") ||
    hasText(el, "title") ||
    hasImageWithAlt(el);

  // Base for every relative URL: a usable <base href>, else the page itself.
  let base = pageUrl;
  const baseHref = $("base[href]").first().attr("href");
  if (baseHref !== undefined) base = normaliseUrl(baseHref, pageUrl) ?? pageUrl;
  const resolve = (href: string | undefined): string | null =>
    href === undefined || href.trim() === "" ? null : normaliseUrl(href, base);

  const headElements = new Set<El>($("head").find("*").toArray());

  // Title.
  const titles = $("head > title").toArray();
  const firstTitle = titles[0];
  const titleText = firstTitle === undefined ? "" : textOf(firstTitle);

  // Meta.
  const metas = $("meta").toArray();
  const metaNamed = (name: string): El[] => metas.filter((el) => lowerAttr(el, "name") === name);
  const descriptionMeta = metaNamed("description")[0];
  const metaDescription =
    descriptionMeta === undefined ? "" : (descriptionMeta.attribs.content ?? "").trim();
  const robots: string[] = [];
  for (const el of metaNamed("robots"))
    robots.push(...splitDirectives(attrOf(el, "content") ?? ""));
  const robotsHeader = headerValue(headers, "x-robots-tag");
  if (robotsHeader !== undefined) robots.push(...headerDirectives(robotsHeader));
  const openGraph: Record<string, string> = {};
  for (const el of metas) {
    const property = lowerAttr(el, "property");
    if (property === null || !property.startsWith("og:")) continue;
    if (attrOf(el, "content") === undefined || property in openGraph) continue;
    openGraph[property] = (attrOf(el, "content") ?? "").trim();
  }

  // Head links.
  const linkElements = $("link").toArray();
  const canonicals: string[] = [];
  const stylesheets: ParsedDocument["stylesheets"] = [];
  let iconLink = false;
  for (const el of linkElements) {
    const rel = relTokens(el);
    if (rel.some((token) => token.includes("icon"))) iconLink = true;
    if (rel.includes("canonical") && headElements.has(el)) {
      const url = resolve(attrOf(el, "href"));
      if (url !== null) canonicals.push(url);
    }
    if (rel.includes("stylesheet")) {
      const url = resolve(attrOf(el, "href"));
      if (url !== null) {
        const media = (attrOf(el, "media") ?? "").trim();
        stylesheets.push({
          url,
          inHead: headElements.has(el),
          media: media === "" ? null : media,
        });
      }
    }
  }

  // Headings.
  const headings = $("h1, h2, h3, h4, h5, h6")
    .toArray()
    .map((el) => ({ level: Number(el.tagName.charAt(1)), text: textOf(el) }));

  // Scripts and JSON-LD.
  const jsonLd: ParsedDocument["jsonLd"] = [];
  const scripts: ParsedDocument["scripts"] = [];
  for (const el of $("script").toArray()) {
    const type = lowerAttr(el, "type");
    if (type === "application/ld+json") {
      jsonLd.push(parseJsonLd(textContent(el, true)));
      continue;
    }
    const src = attrOf(el, "src");
    scripts.push({
      url: resolve(src),
      inHead: headElements.has(el),
      async: attrOf(el, "async") !== undefined,
      defer: attrOf(el, "defer") !== undefined,
      module: type === "module",
      inline: src === undefined,
    });
  }

  // Links.
  const links: ParsedDocument["links"] = $("a[href]")
    .toArray()
    .map((el) => {
      const href = attrOf(el, "href") ?? "";
      const url = normaliseUrl(href, base);
      const text = textOf(el);
      return {
        href,
        url,
        text,
        internal: url !== null && sameOrigin(url, pageUrl),
        rel: relTokens(el),
        hasAccessibleName: hasName(el, text),
      };
    });

  // Images.
  const images: ParsedDocument["images"] = $("img")
    .toArray()
    .map((el, index) => {
      const src = attrOf(el, "src");
      const alt = attrOf(el, "alt");
      const srcset = firstSrcsetUrl(attrOf(el, "srcset") ?? "");
      const url =
        src !== undefined && src.trim() !== ""
          ? normaliseUrl(src, base)
          : resolve(srcset ?? undefined);
      return {
        src: src ?? null,
        url,
        hasAlt: alt !== undefined,
        alt: alt ?? null,
        width: attrOf(el, "width") !== undefined,
        height: attrOf(el, "height") !== undefined,
        loading: lowerAttr(el, "loading"),
        index,
        decorative:
          (alt !== undefined && alt.trim() === "") ||
          lowerAttr(el, "role") === "presentation" ||
          lowerAttr(el, "aria-hidden") === "true",
      };
    });

  // Form controls.
  const labelTargets = new Set<string>();
  for (const el of $("label[for]").toArray()) labelTargets.add(attrOf(el, "for") ?? "");
  const insideLabel = new Set<El>($("label").find("input, select, textarea").toArray());
  const formControls: ParsedDocument["formControls"] = [];
  for (const el of $("input, select, textarea").toArray()) {
    const tag = el.tagName.toLowerCase();
    const type = lowerAttr(el, "type");
    if (tag === "input" && type !== null && NON_LABELLED_INPUT_TYPES.has(type)) continue;
    let labelled: boolean;
    if (tag === "input" && type === "image") {
      labelled = hasText(el, "alt");
    } else {
      const id = attrOf(el, "id") ?? "";
      labelled =
        (id !== "" && labelTargets.has(id)) ||
        insideLabel.has(el) ||
        hasText(el, "aria-label") ||
        hasText(el, "aria-labelledby") ||
        hasText(el, "title");
    }
    formControls.push({
      tag,
      type,
      labelled,
      describe: describeElement(
        el,
        lowerOrRaw(el, "name") === null ? ["type", "id"] : ["type", "name"],
      ),
    });
  }

  // Buttons and iframes.
  const buttons: ParsedDocument["buttons"] = $("button, [role=button]")
    .toArray()
    .map((el) => ({
      hasName: hasName(el, textOf(el)),
      describe: describeElement(el, ["type", "role"]),
    }));
  const iframes: ParsedDocument["iframes"] = $("iframe")
    .toArray()
    .map((el) => ({ hasTitle: hasText(el, "title"), src: attrOf(el, "src") ?? null }));

  // Mixed content, only meaningful when the page itself is on HTTPS.
  const mixedContent: string[] = [];
  if (pageUrl.toLowerCase().startsWith("https:")) {
    const selector =
      "img[src], script[src], link[href], iframe[src], video[src], audio[src], source[src]";
    for (const el of $(selector).toArray()) {
      const tag = el.tagName.toLowerCase();
      if (tag === "link" && !relTokens(el).includes("stylesheet")) continue;
      const url = resolve(attrOf(el, tag === "link" ? "href" : "src"));
      if (url !== null && url.startsWith("http://")) mixedContent.push(url);
    }
  }

  // Word count last: it removes non-visible elements from the tree.
  const body = $("body");
  body.find(SKIPPED_TEXT_ELEMENTS).remove();
  const bodyElement = body.toArray()[0];
  const bodyText = bodyElement === undefined ? "" : collapse(textContent(bodyElement));
  const wordCount = bodyText === "" ? 0 : bodyText.split(" ").length;

  const viewport = metaNamed("viewport")[0];

  return {
    title: titleText === "" ? null : titleText,
    titleCount: titles.length,
    metaDescription: metaDescription === "" ? null : metaDescription,
    metaRobots: unique(robots),
    canonicals,
    lang: htmlLang($),
    hasViewport: viewport !== undefined && hasText(viewport, "content"),
    headings,
    openGraph,
    jsonLd,
    links,
    images,
    scripts,
    stylesheets,
    iconLink,
    formControls,
    buttons,
    iframes,
    wordCount,
    mixedContent,
  };
}

function htmlLang($: CheerioAPI): string | null {
  const lang = ($("html").first().attr("lang") ?? "").trim();
  return lang === "" ? null : lang;
}
