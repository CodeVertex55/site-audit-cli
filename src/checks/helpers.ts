import { normaliseUrl, sameOrigin } from "../crawl/url.js";
import type { CheckDef, Finding, Group, PageRecord, Severity, SiteContext } from "../types.js";

/** A check as written in a group file. The registry adds the group. */
export type CheckSpec = Omit<CheckDef, "group">;

/** Builds a finding for one check without repeating its id, group and severity. */
export type Emit = (url: string | null, detail: string, evidence?: string[]) => Finding;

const DETAIL_MAX = 200;
const EVIDENCE_MAX_ITEMS = 5;
const EVIDENCE_ITEM_MAX = 300;
const ELLIPSIS = "...";

function isUnsafeChar(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Drops control and bidirectional characters, collapses whitespace, trims. */
function tidy(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0xa0) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (isUnsafeChar(code)) continue;
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += ch;
  }
  return out;
}

function clipEnd(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max - ELLIPSIS.length).join("") + ELLIPSIS;
}

function clipMiddle(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const keep = max - ELLIPSIS.length;
  const head = Math.ceil(keep / 2);
  return (
    chars.slice(0, head).join("") + ELLIPSIS + chars.slice(chars.length - (keep - head)).join("")
  );
}

/** True when the page carries a robots directive of `noindex` or `none`. */
export function isNoindex(page: PageRecord): boolean {
  const directives = page.doc?.metaRobots ?? [];
  return directives.includes("noindex") || directives.includes("none");
}

/** HTML pages that loaded with status 200, were parsed, and sit on the audit origin. */
export function htmlPages(ctx: SiteContext): PageRecord[] {
  return ctx.pages.filter(
    (p) => p.status === 200 && p.isHtml && p.doc !== null && sameOrigin(p.finalUrl, ctx.origin),
  );
}

/** `htmlPages` without a `noindex` or `none` directive. */
export function indexablePages(ctx: SiteContext): PageRecord[] {
  return htmlPages(ctx).filter((p) => !isNoindex(p));
}

/** The crawled record for a requested URL, matched on the normalised form too. */
export function findPage(ctx: SiteContext, url: string): PageRecord | undefined {
  const normal = normaliseUrl(url);
  return ctx.pages.find((p) => p.url === url || (normal !== null && p.url === normal));
}

/**
 * Builds a finding. The detail is tidied and capped at 200 characters, and evidence is
 * limited to five items of at most 300 characters each.
 */
export function finding(
  def: Pick<CheckDef, "id" | "group" | "severity">,
  url: string | null,
  detail: string,
  evidence?: string[],
): Finding {
  const out: Finding = {
    checkId: def.id,
    severity: def.severity,
    group: def.group,
    url,
    detail: clipEnd(tidy(detail), DETAIL_MAX),
  };
  if (evidence !== undefined && evidence.length > 0) {
    out.evidence = evidence
      .slice(0, EVIDENCE_MAX_ITEMS)
      .map((item) => clipMiddle(tidy(item), EVIDENCE_ITEM_MAX));
  }
  return out;
}

/**
 * Declares a check whose `run` receives an emitter bound to the check's own id, group and
 * severity, so the three are written once.
 */
export function defineCheck(
  group: Group,
  spec: Omit<CheckSpec, "run"> & { run: (ctx: SiteContext, emit: Emit) => Finding[] },
): CheckSpec {
  const { run, ...rest } = spec;
  const def: { id: string; group: Group; severity: Severity } = {
    id: spec.id,
    group,
    severity: spec.severity,
  };
  return {
    ...rest,
    run: (ctx) => run(ctx, (url, detail, evidence) => finding(def, url, detail, evidence)),
  };
}
