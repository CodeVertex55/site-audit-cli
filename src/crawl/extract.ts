/*
 * HTML to page facts. The audited HTML is hostile input, so it is parsed with htmlparser2, a
 * streaming tokenizer with a plain open-element stack, and the parse stops at a fixed nesting
 * depth or node count (see parseBounded). Every walk below is iterative.
 *
 * htmlparser2 does not create implied html, head or body elements, so the field rules read:
 * - "In head" means inside a head element when the document has one. With no head element at
 *   all, the first title outside svg is the title and titleCount counts titles outside svg.
 * - Head content is html, head, title, meta, link, script, style, base and noscript. Scripts,
 *   stylesheets and canonical links inside a head element count as in head only when they come
 *   before the first element that is not head content, because a head left open does not hold
 *   the page. With no head element they count as in head when they come before the first body
 *   element or, with no body either, before the first element that is not head content.
 * - wordCount reads the first body element when there is one, else the whole document without
 *   title elements (script, style, noscript, template and svg are skipped as always).
 * - Content of noscript, template, iframe, noembed, noframes and xmp is not indexed or read for
 *   names. A browser running scripts treats it as text, never as elements.
 */
import type { Cheerio } from "cheerio";
import { DomHandler, Parser, type Handler } from "htmlparser2";
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

// Elements whose content a browser running scripts reads as text, or keeps out of the document.
const OPAQUE_TAGS = new Set(["noscript", "template", "iframe", "noembed", "noframes", "xmp"]);

/** True for nodes whose children are not read for text or names. */
function isOpaque(node: TreeNode): boolean {
  return isScriptOrStyle(node) || (node.name !== undefined && OPAQUE_TAGS.has(node.name));
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
    } else if (node.children !== undefined && !isOpaque(node)) {
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
    if (node.children !== undefined && !isOpaque(node)) {
      for (const child of node.children) stack.push(child);
    }
  }
  return false;
}

const WORD_SKIPPED_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);
// Without a body element the whole document is read, minus the text that only belongs in head.
const WORD_SKIPPED_WITHOUT_BODY = new Set([...WORD_SKIPPED_TAGS, "title"]);

const ELEMENT_END: TreeNode = { type: "element-end" };

/**
 * Words in the visible text under `root`, in one pass. Adjacent text nodes join as in
 * textContent, and the start and end of every element break a word, so minified markup such as
 * `<p>one</p><p>two</p>` still counts two words.
 */
function countWords(root: TreeNode, skipped: Set<string>): number {
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
    } else if (isScriptOrStyle(node) || (node.name !== undefined && skipped.has(node.name))) {
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
  root: TreeNode;
  byTag: Map<string, El[]>;
  inHead: Set<El>; // elements under <head>
  beforeBody: Set<El>; // scripts and links before the first <body>
  beforeContent: Set<El>; // scripts and links before the first element that is not head content
  titlesOutsideSvg: El[];
  insideLabel: Set<El>; // form controls under any <label>
  headings: El[];
  controls: El[]; // input, select and textarea
  buttons: El[]; // button and [role=button]
  subresources: El[]; // img, script, link, iframe, video, audio and source
};

const HEAD_END: TreeNode = { type: "head-end" };
const LABEL_END: TreeNode = { type: "label-end" };
const SVG_END: TreeNode = { type: "svg-end" };
const SUBRESOURCE_TAGS = new Set(["img", "script", "link", "iframe", "video", "audio", "source"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
// Elements that may come before the content of a page.
const HEAD_CONTENT_TAGS = new Set([
  "html",
  "head",
  "title",
  "meta",
  "link",
  "script",
  "style",
  "base",
  "noscript",
]);

/**
 * One pass over the tree, in document order, that sorts every element into the lists the
 * extractor reads. Selector queries each walk the whole tree, which is too slow on large pages.
 */
function indexTree(root: TreeNode): TreeIndex {
  const index: TreeIndex = {
    root,
    byTag: new Map(),
    inHead: new Set(),
    beforeBody: new Set(),
    beforeContent: new Set(),
    titlesOutsideSvg: [],
    insideLabel: new Set(),
    headings: [],
    controls: [],
    buttons: [],
    subresources: [],
  };
  let headDepth = 0;
  let labelDepth = 0;
  let svgDepth = 0;
  let seenBody = false;
  let seenContent = false;
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
    if (node === SVG_END) {
      svgDepth -= 1;
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
    if (name === "script" || name === "link") {
      if (!seenBody) index.beforeBody.add(el);
      if (!seenContent) index.beforeContent.add(el);
    }
    if (name === "body") seenBody = true;
    if (!HEAD_CONTENT_TAGS.has(name)) seenContent = true;
    if (name === "title" && svgDepth === 0) index.titlesOutsideSvg.push(el);
    if (HEADING_TAGS.has(name)) index.headings.push(el);
    if (SUBRESOURCE_TAGS.has(name)) index.subresources.push(el);
    if (name === "button" || node.attribs?.role === "button") index.buttons.push(el);
    if (name === "input" || name === "select" || name === "textarea") {
      index.controls.push(el);
      if (labelDepth > 0) index.insideLabel.add(el);
    }
    if (OPAQUE_TAGS.has(name)) continue;
    if (name === "head") {
      headDepth += 1;
      stack.push(HEAD_END);
    } else if (name === "label") {
      labelDepth += 1;
      stack.push(LABEL_END);
    } else if (name === "svg") {
      svgDepth += 1;
      stack.push(SVG_END);
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i];
      if (child !== undefined) stack.push(child);
    }
  }
  return index;
}

// Parse limits. The parser compares every end tag it cannot match with each open element, so the
// worst case costs MAX_DEPTH comparisons per end tag. At 128 the slowest 5 MB page of stray end
// tags measured stays under 2 seconds. MAX_NODES sits above large ordinary pages (200000 flat
// paragraphs are 400000 nodes) and bounds time and memory for hostile ones.
export const MAX_DEPTH = 128;
export const MAX_NODES = 500_000;
// Elements that make htmlparser2 record a foreign-content entry. It drops the entry only on an
// explicit end tag of the same name, so implied closes of these elements leave entries behind.
const FOREIGN_CONTEXT_TAGS = new Set([
  "svg",
  "math",
  "mi",
  "mo",
  "mn",
  "ms",
  "mtext",
  "annotation-xml",
  "foreignobject",
  "desc",
  "title",
]);

/**
 * Parse HTML into a domhandler tree, stopping at MAX_DEPTH open elements or MAX_NODES nodes.
 *
 * The parser's per-tag work grows with the number of open elements, so an unbounded depth makes
 * parsing quadratic. The handler below counts open elements from the parser's own open and close
 * events (void elements and implied closes fire both), and when the next open tag would pass a
 * limit it pauses the parser for good. Everything after that point is dropped. Elements of
 * FOREIGN_CONTEXT_TAGS that are left open without an explicit end tag are counted the same way,
 * since the parser keeps an entry for each of them.
 */
export function parseBounded(html: string): { root: TreeNode; truncated: boolean } {
  const dom = new DomHandler();
  let parser: Parser | null = null;
  let depth = 0;
  let foreignOpen = 0;
  let nodes = 0;
  let inText = false; // the handler merges adjacent text events into one node
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    parser?.pause();
  };
  const addNode = (): boolean => {
    nodes += 1;
    if (nodes > MAX_NODES) stop();
    return !stopped;
  };
  const handler: Partial<Handler> = {
    onparserinit: (instance) => dom.onparserinit(instance),
    onopentag: (name, attribs) => {
      if (stopped) return;
      const foreign = FOREIGN_CONTEXT_TAGS.has(name);
      if (depth >= MAX_DEPTH || (foreign && foreignOpen >= MAX_DEPTH)) {
        stop();
        return;
      }
      if (!addNode()) return;
      depth += 1;
      if (foreign) foreignOpen += 1;
      inText = false;
      dom.onopentag(name, attribs);
    },
    onclosetag: (name, isImplied) => {
      // When input ends inside a start tag, the parser closes that tag too although it never
      // sent an open event for it. That one extra close arrives last, at depth 0, and is ignored.
      if (stopped || depth === 0) return;
      depth -= 1;
      if (!isImplied && foreignOpen > 0 && FOREIGN_CONTEXT_TAGS.has(name)) foreignOpen -= 1;
      inText = false;
      dom.onclosetag();
    },
    ontext: (data) => {
      if (stopped || (!inText && !addNode())) return;
      inText = true;
      dom.ontext(data);
    },
    oncomment: (data) => {
      if (stopped || !addNode()) return;
      inText = false;
      dom.oncomment(data);
    },
    oncommentend: () => {
      if (!stopped) dom.oncommentend();
    },
    oncdatastart: () => {
      if (stopped || !addNode()) return;
      inText = true;
      dom.oncdatastart();
    },
    oncdataend: () => {
      if (stopped) return;
      inText = false;
      dom.oncdataend();
    },
    onprocessinginstruction: (name, data) => {
      if (stopped || !addNode()) return;
      inText = false;
      dom.onprocessinginstruction(name, data);
    },
    onend: () => {
      if (!stopped) dom.onend();
    },
  };
  parser = new Parser(handler, {
    xmlMode: false,
    decodeEntities: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
    recognizeSelfClosing: false,
  });
  parser.end(html);
  if (stopped) {
    // A paused parser never ends, so close what is open and finish the handler here.
    for (; depth > 0; depth -= 1) dom.onclosetag();
    dom.onend();
  }
  return { root: dom.root as unknown as TreeNode, truncated: stopped };
}

/** Text of a script element, which only holds text nodes. */
function scriptText(el: El): string {
  return childrenOf(el)
    .map((node) => (node.type === "text" ? (node.data ?? "") : ""))
    .join("");
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
 * when the parse stopped at the depth or node limit (the rest of the page is missing) or the shared
 * text-read budget ran out (some names and previews were decided from attributes only).
 */
export function extractWithStatus(
  html: string,
  pageUrl: string,
  headers: Record<string, string> = {},
): { doc: ParsedDocument; truncated: boolean } {
  const parsed = parseBounded(html);
  const budget: Budget = { visits: 0, exhausted: false };
  const doc = extractFacts(indexTree(parsed.root), pageUrl, headers, budget);
  return { doc, truncated: parsed.truncated || budget.exhausted };
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

  const all = (tag: string): El[] => tree.byTag.get(tag) ?? [];
  // Without a head element, head content is what comes before the body or the first content.
  const hasHead = all("head").length > 0;
  const hasBody = all("body").length > 0;
  const inHead = (el: El): boolean => {
    if (hasHead) return tree.inHead.has(el) && tree.beforeContent.has(el);
    return hasBody ? tree.beforeBody.has(el) : tree.beforeContent.has(el);
  };

  // Title.
  const titles = hasHead
    ? all("title").filter((el) => (el.parent as TreeNode | null)?.name === "head")
    : tree.titlesOutsideSvg;
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
    if (rel.includes("canonical") && inHead(el)) {
      const url = resolve(attrOf(el, "href"));
      if (url !== null) canonicals.push(url);
    }
    if (rel.includes("stylesheet")) {
      const url = resolve(attrOf(el, "href"));
      if (url !== null) {
        const media = (attrOf(el, "media") ?? "").trim();
        stylesheets.push({
          url,
          inHead: inHead(el),
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
      inHead: inHead(el),
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
  const wordCount =
    bodyElement === undefined
      ? countWords(tree.root, WORD_SKIPPED_WITHOUT_BODY)
      : countWords(bodyElement as unknown as TreeNode, WORD_SKIPPED_TAGS);

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
