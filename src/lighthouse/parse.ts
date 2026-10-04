import type { LighthousePage } from "../types.js";

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function score(categories: Dict | null, key: string): number | null {
  const value = finiteNumber(asDict(categories?.[key])?.score);
  return value === null ? null : Math.round(value * 100);
}

function metric(audits: Dict | null, key: string): number | null {
  return finiteNumber(asDict(audits?.[key])?.numericValue);
}

function runtimeError(raw: Dict): string | null {
  const error = asDict(raw.runtimeError);
  if (error === null) return null;
  const message = error.message;
  return typeof message === "string" && message.trim() !== ""
    ? message
    : "Lighthouse reported a runtime error.";
}

/** Reads the scores, lab metrics and version out of a Lighthouse JSON result. Never throws. */
export function parseLighthouseResult(
  raw: unknown,
  url: string,
): { page: LighthousePage; version: string | null } {
  const root = asDict(raw) ?? {};
  const categories = asDict(root.categories);
  const audits = asDict(root.audits);
  return {
    page: {
      url,
      scores: {
        performance: score(categories, "performance"),
        accessibility: score(categories, "accessibility"),
        bestPractices: score(categories, "best-practices"),
        seo: score(categories, "seo"),
      },
      metrics: {
        fcpMs: metric(audits, "first-contentful-paint"),
        lcpMs: metric(audits, "largest-contentful-paint"),
        tbtMs: metric(audits, "total-blocking-time"),
        cls: metric(audits, "cumulative-layout-shift"),
        speedIndexMs: metric(audits, "speed-index"),
      },
      error: runtimeError(root),
    },
    version: typeof root.lighthouseVersion === "string" ? root.lighthouseVersion : null,
  };
}
