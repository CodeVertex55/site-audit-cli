import type { Finding, ParsedDocument, SiteContext } from "../types.js";
import { defineCheck, htmlPages, type CheckSpec, type Emit } from "./helpers.js";

export const A11Y_NOTICE =
  "Static checks only. This is not an accessibility audit: contrast, keyboard use, focus order and screen reader behaviour are not tested.";

const MAX_EVIDENCE = 5;

const GENERIC_LINK_TEXTS = new Set([
  "click here",
  "here",
  "read more",
  "more",
  "learn more",
  "link",
  "this",
]);

function a11y(spec: Parameters<typeof defineCheck>[1]): CheckSpec {
  return defineCheck("accessibility", spec);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * One finding per page for the items `pick` returns. The detail names the count and the
 * evidence lists the first five items.
 */
function perPage<T>(
  ctx: SiteContext,
  emit: Emit,
  pick: (doc: ParsedDocument) => T[],
  describeItem: (item: T) => string,
  detail: (count: number) => string,
): Finding[] {
  return htmlPages(ctx).flatMap((page) => {
    if (page.doc === null) return [];
    const items = pick(page.doc);
    if (items.length === 0) return [];
    return [emit(page.url, detail(items.length), items.slice(0, MAX_EVIDENCE).map(describeItem))];
  });
}

function isPunctuation(ch: string): boolean {
  return /^[\p{P}\p{S}]$/u.test(ch);
}

/** Lower-cased, trimmed text with trailing punctuation and spaces removed. */
function normaliseLinkText(text: string): string {
  const chars = Array.from(text.trim().toLowerCase());
  let end = chars.length;
  while (end > 0) {
    const ch = chars[end - 1] ?? "";
    if (ch.trim() === "" || isPunctuation(ch)) end -= 1;
    else break;
  }
  return chars.slice(0, end).join("");
}

type SkippedLevel = { from: number; to: number };

/** Headings whose level is more than one deeper than the heading before them. */
function skippedLevels(headings: ParsedDocument["headings"]): SkippedLevel[] {
  const skips: SkippedLevel[] = [];
  let previous: number | null = null;
  for (const heading of headings) {
    if (previous !== null && heading.level > previous + 1) {
      skips.push({ from: previous, to: heading.level });
    }
    previous = heading.level;
  }
  return skips;
}

export const ACCESSIBILITY_CHECKS: CheckSpec[] = [
  a11y({
    id: "A11Y-ALT-001",
    severity: "warning",
    scope: "page",
    title: "Image without an alt attribute",
    why: "Screen readers have nothing to say about an image with no alt attribute, and often read out the file name instead.",
    fix: 'Add an alt attribute that describes the image. Use alt="" for images that are only decoration.',
    heuristic: null,
    run: (ctx, emit) =>
      perPage(
        ctx,
        emit,
        (doc) => doc.images.filter((i) => !i.hasAlt),
        (i) => i.url ?? i.src ?? "image with no source",
        (n) => `${n} ${plural(n, "image has", "images have")} no alt attribute.`,
      ),
  }),
  a11y({
    id: "A11Y-LABEL-010",
    severity: "warning",
    scope: "page",
    title: "Form control without a label",
    why: "People using screen readers cannot tell what a field is for, and a label also gives a larger target to click.",
    fix: "Add a label element that points at the field, or an aria-label or aria-labelledby attribute.",
    heuristic:
      "Hidden, submit, button, reset and image inputs are not counted. Image inputs need alt text instead.",
    run: (ctx, emit) =>
      perPage(
        ctx,
        emit,
        (doc) => doc.formControls.filter((c) => !c.labelled),
        (c) => c.describe,
        (n) => `${n} form ${plural(n, "control has", "controls have")} no label.`,
      ),
  }),
  a11y({
    id: "A11Y-LINK-020",
    severity: "warning",
    scope: "page",
    title: "Link without an accessible name",
    why: "A link with no text, label or image alt is announced as just link, so people using screen readers cannot tell where it goes.",
    fix: "Add link text, or an aria-label, or alt text on the image inside the link.",
    heuristic: null,
    run: (ctx, emit) =>
      perPage(
        ctx,
        emit,
        (doc) => doc.links.filter((l) => !l.hasAccessibleName),
        (l) => l.href,
        (n) => `${n} ${plural(n, "link has", "links have")} no accessible name.`,
      ),
  }),
  a11y({
    id: "A11Y-LINK-021",
    severity: "info",
    scope: "page",
    title: "Generic link text",
    why: "People who move through a page by its links hear them out of context, so click here and read more tell them nothing.",
    fix: "Write link text that says where the link goes or what it does.",
    heuristic:
      'Compares the link text, lower-cased and without trailing punctuation, with: "click here", "here", "read more", "more", "learn more", "link", "this".',
    run: (ctx, emit) =>
      perPage(
        ctx,
        emit,
        (doc) => doc.links.filter((l) => GENERIC_LINK_TEXTS.has(normaliseLinkText(l.text))),
        (l) => l.href,
        (n) => `${n} ${plural(n, "link uses", "links use")} generic text such as click here.`,
      ),
  }),
  a11y({
    id: "A11Y-BTN-030",
    severity: "warning",
    scope: "page",
    title: "Button without an accessible name",
    why: "A button with no text or label is announced as just button, so people using screen readers cannot tell what it does.",
    fix: "Add text inside the button, or an aria-label.",
    heuristic: null,
    run: (ctx, emit) =>
      perPage(
        ctx,
        emit,
        (doc) => doc.buttons.filter((b) => !b.hasName),
        (b) => b.describe,
        (n) => `${n} ${plural(n, "button has", "buttons have")} no accessible name.`,
      ),
  }),
  a11y({
    id: "A11Y-HEAD-040",
    severity: "info",
    scope: "page",
    title: "Heading levels are skipped",
    why: "People who move through a page by its headings expect the levels to nest, and a gap suggests missing content.",
    fix: "Use the next heading level down, and pick levels for structure and not for size.",
    heuristic: "Fails when a heading is more than one level deeper than the heading before it.",
    run: (ctx, emit) =>
      perPage(
        ctx,
        emit,
        (doc) => skippedLevels(doc.headings),
        (s) => `h${s.from} to h${s.to}`,
        (n) => `${n} heading ${plural(n, "level is", "levels are")} skipped.`,
      ),
  }),
  a11y({
    id: "A11Y-FRAME-050",
    severity: "info",
    scope: "page",
    title: "Iframe without a title",
    why: "Screen readers announce an iframe by its title, so without one people cannot tell what the embedded content is.",
    fix: "Add a short title attribute that says what the frame contains.",
    heuristic: null,
    run: (ctx, emit) =>
      perPage(
        ctx,
        emit,
        (doc) => doc.iframes.filter((f) => !f.hasTitle),
        (f) => f.src ?? "iframe with no source",
        (n) => `${n} ${plural(n, "iframe has", "iframes have")} no title.`,
      ),
  }),
];
