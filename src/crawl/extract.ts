import { load, type Cheerio } from "cheerio";
import type { ParsedDocument } from "../types.js";
import { normaliseUrl, sameOrigin } from "./url.js";

// The element type cheerio hands out for a tag selector, without importing domhandler directly.
type Selection = ReturnType<Cheerio<never>["find"]>;
type El = Selection extends Cheerio<infer E> ? E : never;

const MAX_ERROR_LENGTH = 120;
const MAX_DESCRIBE_VALUE = 40;
const NON_LABELLED_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset"]);

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

function looksLikeDirective(part: string): boolean {
  return /^[a-z_-]+$/.test(part);
}

/**
 * Directives from an X-Robots-Tag value that apply to every crawler. A part written
 * "bot: directive" is for one crawler and is ignored, and so are the plain directives after it.
 * A part with a colon that is not a bot prefix is dropped without scoping what follows. The
 * date after `unavailable_after` may itself contain commas, so the parts that follow it are
 * dropped until one looks like a directive name.
 */
function headerDirectives(value: string): string[] {
  const out: string[] = [];
  let scoped = false;
  let inDate = false;
  for (const part of splitDirectives(value)) {
    const colon = part.indexOf(":");
    if (colon !== -1) {
      const token = part.slice(0, colon);
      if (token === "unavailable_after") {
        inDate = true;
      } else if (!/\s/.test(token)) {
        scoped = true;
        inDate = false;
      }
    } else if (inDate && !looksLikeDirective(part)) {
      continue;
    } else {
      inDate = false;
      if (!scoped) out.push(part);
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
type TreeNode = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: TreeNode[];
};

// Names, headings and link text only ever need a short preview or an emptiness test, so the
// walks below stop early. That keeps the cost per element flat when elements are nested deeply.
const TEXT_BUDGET = 2000;
const SCAN_BUDGET = 20000;
const NODE_BUDGET = 20000;
// One budget per document, shared by every preview and name check, so total work stays bounded
// however many elements wrap large content.
const DOCUMENT_NODE_BUDGET = 3_000_000;

type Budget = { visits: number; exhausted: boolean };

/** Count one node visit. False once the document budget is spent. */
function spend(budget: Budget): boolean {
  if (budget.exhausted) return false;
  budget.visits += 1;
  if (budget.visits > DOCUMENT_NODE_BUDGET) {
    budget.exhausted = true;
    return false;
  }
  return true;
}

function childrenOf(el: El | TreeNode): TreeNode[] {
  // Cheerio's node types are an enum of string values; TreeNode reads the same fields.
  return (el.children ?? []) as unknown as TreeNode[];
}

function isWhitespace(char: string): boolean {
  const code = char.charCodeAt(0);
  if (code <= 32) return code === 32 || (code >= 9 && code <= 13);
  return code >= 128 && /\s/.test(char);
}

function isScriptOrStyle(node: TreeNode): boolean {
  return node.type === "script" || node.type === "style";
}

/**
 * Whitespace-collapsed visible text of an element, in document order, cut at TEXT_BUDGET
 * characters. Iterative, so deep markup cannot overflow the stack, and bounded in work.
 */
function textPreview(el: El, budget: Budget): string {
  let out = "";
  let pendingSpace = false;
  let scanned = 0;
  let visited = 0;
  const stack: TreeNode[] = [...childrenOf(el)].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    visited += 1;
    if (visited > NODE_BUDGET || !spend(budget)) break;
    if (node.type === "text") {
      const data = node.data ?? "";
      for (let k = 0; k < data.length; k += 1) {
        scanned += 1;
        if (scanned > SCAN_BUDGET) return out;
        const char = data.charAt(k);
        if (isWhitespace(char)) {
          pendingSpace = out !== "";
        } else {
          if (pendingSpace) out += " ";
          pendingSpace = false;
          out += char;
          if (out.length >= TEXT_BUDGET) return out.slice(0, TEXT_BUDGET);
        }
      }
    } else if (node.children !== undefined && !isScriptOrStyle(node)) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i];
        if (child !== undefined) stack.push(child);
      }
    }
  }
  return out;
}

/** True when an img with non-empty alt text sits inside the element. Stops after NODE_BUDGET nodes or when the document budget is spent. */
function containsImageWithAlt(el: El, budget: Budget): boolean {
  let visited = 0;
  const stack: TreeNode[] = [...childrenOf(el)];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    visited += 1;
    if (visited > NODE_BUDGET || !spend(budget)) return false;
    if (node.type === "tag" && node.name === "img" && (node.attribs?.alt ?? "").trim() !== "") {
      return true;
    }
    if (node.children !== undefined) {
      for (const child of node.children) stack.push(child);
    }
  }
  return false;
}

const WORD_SKIPPED_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);

const ELEMENT_END: TreeNode = { type: "element-end" };

/**
 * Words in the visible text under `root`, in one pass. Adjacent text nodes join as in
 * textContent, and the start and end of every element break a word, so minified markup such as
 * `<p>one</p><p>two</p>` still counts two words.
 */
function countWords(root: El): number {
  let words = 0;
  let inWord = false;
  const stack: TreeNode[] = [...childrenOf(root)].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node === ELEMENT_END) {
      inWord = false;
    } else if (node.type === "text") {
      const data = node.data ?? "";
      for (let k = 0; k < data.length; k += 1) {
        if (isWhitespace(data.charAt(k))) {
          inWord = false;
        } else if (!inWord) {
          inWord = true;
          words += 1;
        }
      }
    } else if (
      isScriptOrStyle(node) ||
      (node.name !== undefined && WORD_SKIPPED_TAGS.has(node.name))
    ) {
      inWord = false;
    } else if (node.children !== undefined) {
      inWord = false;
      stack.push(ELEMENT_END);
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i];
        if (child !== undefined) stack.push(child);
      }
    }
  }
  return words;
}

type TreeIndex = {
  byTag: Map<string, El[]>;
  inHead: Set<El>; // elements under <head>
  insideLabel: Set<El>; // form controls under any <label>
  headings: El[];
  controls: El[]; // input, select and textarea
  buttons: El[]; // button and [role=button]
  subresources: El[]; // img, script, link, iframe, video, audio and source
};

const HEAD_END: TreeNode = { type: "head-end" };
const LABEL_END: TreeNode = { type: "label-end" };
const SUBRESOURCE_TAGS = new Set(["img", "script", "link", "iframe", "video", "audio", "source"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * One pass over the tree, in document order, that sorts every element into the lists the
 * extractor reads. Selector queries each walk the whole tree, which is too slow on large pages.
 */
function indexTree(root: TreeNode): TreeIndex {
  const index: TreeIndex = {
    byTag: new Map(),
    inHead: new Set(),
    insideLabel: new Set(),
    headings: [],
    controls: [],
    buttons: [],
    subresources: [],
  };
  let headDepth = 0;
  let labelDepth = 0;
  const stack: TreeNode[] = [...childrenOf(root)].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node === HEAD_END) {
      headDepth -= 1;
      continue;
    }
    if (node === LABEL_END) {
      labelDepth -= 1;
      continue;
    }
    const name = node.name;
    if (name === undefined || node.children === undefined) continue;
    // Elements are the tag, script and style nodes, the only ones that carry a name.
    const el = node as unknown as El;
    const sameTag = index.byTag.get(name);
    if (sameTag === undefined) index.byTag.set(name, [el]);
    else sameTag.push(el);
    if (headDepth > 0) index.inHead.add(el);
    if (HEADING_TAGS.has(name)) index.headings.push(el);
    if (SUBRESOURCE_TAGS.has(name)) index.subresources.push(el);
    if (name === "button" || node.attribs?.role === "button") index.buttons.push(el);
    if (name === "input" || name === "select" || name === "textarea") {
      index.controls.push(el);
      if (labelDepth > 0) index.insideLabel.add(el);
    }
    if (name === "head") {
      headDepth += 1;
      stack.push(HEAD_END);
    } else if (name === "label") {
      labelDepth += 1;
      stack.push(LABEL_END);
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i];
      if (child !== undefined) stack.push(child);
    }
  }
  return index;
}

/** Text of a script element, which only holds text nodes. */
function scriptText(el: El): string {
  return childrenOf(el)
    .map((node) => (node.type === "text" ? (node.data ?? "") : ""))
    .join("");
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
// Tags whose end tag may be left out. In HTML content they are not counted, because they close
// each other and the elements that hold them (table, ul, select, ruby) are counted instead.
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
const FOREIGN_ROOTS = new Set(["svg", "math"]);
// Foreign elements whose children are parsed as HTML.
const INTEGRATION_POINTS = new Set([
  "foreignobject",
  "desc",
  "title",
  "annotation-xml",
  "mi",
  "mo",
  "mn",
  "ms",
  "mtext",
]);
// HTML tags that end foreign (svg or math) content when they appear inside it.
const FOREIGN_BREAKOUT_TAGS = new Set([
  "b",
  "big",
  "blockquote",
  "body",
  "br",
  "center",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "i",
  "img",
  "li",
  "listing",
  "menu",
  "meta",
  "nobr",
  "ol",
  "p",
  "pre",
  "ruby",
  "s",
  "small",
  "span",
  "strong",
  "strike",
  "sub",
  "sup",
  "table",
  "tt",
  "u",
  "ul",
  "var",
  "font",
]);
// Phrasing elements an end tag may close through. Anything else blocks the match, so the scan
// leaves the element counted as open (an over-count is safe, an under-count is not).
const TRANSPARENT_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "big",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "label",
  "mark",
  "nobr",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
]);
const MAX_NESTING_DEPTH = 1000;
const END_TAG_SCAN = 32;
const ROOT_END_TAG_SCAN = MAX_NESTING_DEPTH + 1;
const FOREIGN_ELEMENT = 1; // the element itself is svg or math content
const FOREIGN_CHILDREN = 2; // its children are svg or math content

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

/**
 * Index of the ">" that ends the tag whose name ends at `from`, and whether the tag is a leaf
 * in foreign content. `leaf` is true only for a "/>" that the HTML tokenizer certainly reads as
 * a self-closing flag: the slash is right before ">" and follows the tag name, whitespace that
 * does not come after "=", or the closing quote of a quoted value.
 */
function tagEnd(html: string, from: number): { end: number; leaf: boolean } {
  let quote = 0;
  let previous = 0; // last non-space character outside quotes
  let beforeSlash = 0;
  let quoteClosedAt = -1;
  for (let i = from; i < html.length; i += 1) {
    const code = html.charCodeAt(i);
    if (quote !== 0) {
      if (code === quote) {
        quote = 0;
        previous = code;
        quoteClosedAt = i;
      }
    } else if ((code === 34 || code === 39) && previous === 61) {
      quote = code;
    } else if (code === 62) {
      if (i === from || html.charCodeAt(i - 1) !== 47) return { end: i, leaf: false };
      if (i - 1 === from) return { end: i, leaf: true };
      const gap = html.charCodeAt(i - 2);
      const leaf = isSpace(gap)
        ? beforeSlash !== 61
        : (gap === 34 || gap === 39) && quoteClosedAt === i - 2;
      return { end: i, leaf };
    } else if (!isSpace(code)) {
      if (code === 47) beforeSlash = previous;
      previous = code;
    }
  }
  return { end: html.length, leaf: false };
}

/** Index just past the end of the comment that starts at `start`, or -1 when it never ends. */
function commentEnd(html: string, start: number): number {
  // "<!-->" and "<!--->" are complete comments.
  if (html.charCodeAt(start + 4) === 62) return start + 5;
  if (html.startsWith("->", start + 4)) return start + 6;
  let at = html.indexOf("--", start + 4);
  while (at !== -1) {
    const next = html.charCodeAt(at + 2);
    if (next === 62) return at + 3;
    if (next === 33 && html.charCodeAt(at + 3) === 62) return at + 4;
    at = html.indexOf("--", at + 1);
  }
  return -1;
}

/**
 * Parsing and querying cost grows quickly with element depth, and the parser's recursion limits
 * are not ours to tune. Real pages are far shallower than the cap. When a document nests deeper,
 * only the part before the cap is kept.
 *
 * The scan computes an upper bound on the real nesting depth, in one linear pass without regular
 * expressions. It does not copy the HTML parser. Whenever it is unsure that a start tag leaves
 * the element open, it counts the tag as open, and an end tag only closes an element it matches
 * by name. An over-count flags an unusual page, an under-count would let hostile markup through.
 */
function limitNesting(html: string): string {
  const names: string[] = [];
  const flags: number[] = [];
  const inForeign = (): boolean => ((flags[flags.length - 1] ?? 0) & FOREIGN_CHILDREN) !== 0;
  let i = html.indexOf("<");
  while (i !== -1 && i < html.length - 1) {
    const next = html.charCodeAt(i + 1);
    if (next === 33 && html.startsWith("<!--", i)) {
      const end = commentEnd(html, i);
      i = end === -1 ? -1 : html.indexOf("<", end);
      continue;
    }
    const closing = next === 47;
    const nameStart = closing ? i + 2 : i + 1;
    if (!isLetter(html.charCodeAt(nameStart))) {
      i = html.indexOf("<", i + 1);
      continue;
    }
    // A tag name runs to whitespace, "/" or ">".
    let nameEnd = nameStart;
    while (nameEnd < html.length) {
      const code = html.charCodeAt(nameEnd);
      if (isSpace(code) || code === 47 || code === 62) break;
      nameEnd += 1;
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const { end, leaf } = tagEnd(html, nameEnd);
    let resume = end + 1;

    if (closing) {
      if (!AUTO_CLOSING_TAGS.has(name) && !VOID_TAGS.has(name)) {
        const limit = FOREIGN_ROOTS.has(name) ? ROOT_END_TAG_SCAN : END_TAG_SCAN;
        for (let k = names.length - 1, steps = 0; k >= 0 && steps < limit; k -= 1, steps += 1) {
          if (names[k] === name) {
            names.length = k;
            flags.length = k;
            break;
          }
          const foreignElement = ((flags[k] ?? 0) & FOREIGN_ELEMENT) !== 0;
          if (!foreignElement && !TRANSPARENT_TAGS.has(names[k] ?? "")) break;
        }
      }
    } else {
      if (inForeign() && FOREIGN_BREAKOUT_TAGS.has(name)) {
        // The parser leaves svg or math content here, back to the nearest HTML context.
        while (names.length > 0 && inForeign()) {
          names.pop();
          flags.pop();
        }
      }
      if (inForeign()) {
        if (!leaf) {
          names.push(name);
          flags.push(FOREIGN_ELEMENT + (INTEGRATION_POINTS.has(name) ? 0 : FOREIGN_CHILDREN));
        }
      } else if (VOID_TAGS.has(name) || AUTO_CLOSING_TAGS.has(name)) {
        // Not counted in HTML content.
      } else if (FOREIGN_ROOTS.has(name)) {
        if (!leaf) {
          names.push(name);
          flags.push(FOREIGN_ELEMENT + FOREIGN_CHILDREN);
        }
      } else {
        // In HTML content a "/>" is ignored, so every other start tag opens an element.
        names.push(name);
        flags.push(0);
        if (RAW_TEXT_TAGS.has(name)) {
          let close = html.indexOf("</", resume);
          while (close !== -1 && !matchesAt(html, close + 2, name))
            close = html.indexOf("</", close + 2);
          if (close === -1) return html;
          resume = close;
        }
      }
      if (names.length > MAX_NESTING_DEPTH) return html.slice(0, i);
    }
    i = html.indexOf("<", resume);
  }
  return html;
}

/** True when `extractDocument` would cut this HTML at the nesting cap. */
export function exceedsNestingLimit(html: string): boolean {
  return limitNesting(html).length < html.length;
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
  return extractWithStatus(html, pageUrl, headers).doc;
}

/**
 * Same as `extractDocument`, and also says whether the facts are partial: `truncated` is true
 * when the HTML was cut at the nesting cap or the shared text-read budget ran out, in which case
 * some names and previews were decided from attributes only.
 */
export function extractWithStatus(
  html: string,
  pageUrl: string,
  headers: Record<string, string> = {},
): { doc: ParsedDocument; truncated: boolean } {
  const limited = limitNesting(html);
  const budget: Budget = { visits: 0, exhausted: false };
  const rootNode = load(limited).root().get(0) as unknown as TreeNode | undefined;
  const tree = indexTree(rootNode ?? { type: "root", children: [] });
  const doc = extractFacts(tree, pageUrl, headers, budget);
  return { doc, truncated: limited.length < html.length || budget.exhausted };
}

function extractFacts(
  tree: TreeIndex,
  pageUrl: string,
  headers: Record<string, string>,
  budget: Budget,
): ParsedDocument {
  const textOf = (el: El): string => textPreview(el, budget);
  const hasName = (el: El, text: string): boolean =>
    text !== "" ||
    hasText(el, "aria-label") ||
    hasText(el, "aria-labelledby") ||
    hasText(el, "title") ||
    containsImageWithAlt(el, budget);

  // Base for every relative URL: a usable <base href>, else the page itself.
  let base = pageUrl;
  const baseHref = (tree.byTag.get("base") ?? []).find((el) => attrOf(el, "href") !== undefined)
    ?.attribs.href;
  if (baseHref !== undefined) base = normaliseUrl(baseHref, pageUrl) ?? pageUrl;
  const resolve = (href: string | undefined): string | null =>
    href === undefined || href.trim() === "" ? null : normaliseUrl(href, base);

  const headElements = tree.inHead;
  const all = (tag: string): El[] => tree.byTag.get(tag) ?? [];

  // Title.
  const titles = all("title").filter((el) => (el.parent as TreeNode | null)?.name === "head");
  const firstTitle = titles[0];
  const titleText = firstTitle === undefined ? "" : textOf(firstTitle);

  // Meta.
  const metas = all("meta");
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
  const linkElements = all("link");
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
  const headings = tree.headings.map((el) => ({
    level: Number(el.tagName.charAt(1)),
    text: textOf(el),
  }));

  // Scripts and JSON-LD.
  const jsonLd: ParsedDocument["jsonLd"] = [];
  const scripts: ParsedDocument["scripts"] = [];
  for (const el of all("script")) {
    const type = lowerAttr(el, "type");
    if (type === "application/ld+json") {
      jsonLd.push(parseJsonLd(scriptText(el)));
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
  const links: ParsedDocument["links"] = all("a")
    .filter((el) => attrOf(el, "href") !== undefined)
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
  const images: ParsedDocument["images"] = all("img").map((el, index) => {
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
  for (const el of all("label")) {
    const target = attrOf(el, "for");
    if (target !== undefined) labelTargets.add(target);
  }
  const insideLabel = tree.insideLabel;
  const formControls: ParsedDocument["formControls"] = [];
  for (const el of tree.controls) {
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
  const buttons: ParsedDocument["buttons"] = tree.buttons.map((el) => ({
    hasName: hasName(el, textOf(el)),
    describe: describeElement(el, ["type", "role"]),
  }));
  const iframes: ParsedDocument["iframes"] = all("iframe").map((el) => ({
    hasTitle: hasText(el, "title"),
    src: attrOf(el, "src") ?? null,
  }));

  // Mixed content, only meaningful when the page itself is on HTTPS.
  const mixedContent: string[] = [];
  if (pageUrl.toLowerCase().startsWith("https:")) {
    for (const el of tree.subresources) {
      const tag = el.tagName.toLowerCase();
      const attribute = tag === "link" ? "href" : "src";
      if (attrOf(el, attribute) === undefined) continue;
      if (tag === "link" && !relTokens(el).includes("stylesheet")) continue;
      const url = resolve(attrOf(el, attribute));
      if (url !== null && url.startsWith("http://")) mixedContent.push(url);
    }
  }

  const bodyElement = all("body")[0];
  const wordCount = bodyElement === undefined ? 0 : countWords(bodyElement);

  return {
    title: titleText === "" ? null : titleText,
    titleCount: titles.length,
    metaDescription: metaDescription === "" ? null : metaDescription,
    metaRobots: unique(robots),
    canonicals,
    lang: htmlLang(all("html")[0]),
    hasViewport: metaNamed("viewport").some((el) => hasText(el, "content")),
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

function htmlLang(html: El | undefined): string | null {
  const lang = (html === undefined ? "" : (attrOf(html, "lang") ?? "")).trim();
  return lang === "" ? null : lang;
}
