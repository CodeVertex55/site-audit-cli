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
  return value === null || value < 0 || value > 1 ? null : Math.round(value * 100);
}

function metric(audits: Dict | null, key: string): number | null {
  return finiteNumber(asDict(audits?.[key])?.numericValue);
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,30}$/;

/** Only a Lighthouse error code is reported, never its free-text message. */
function runtimeError(raw: Dict): string | null {
  const error = asDict(raw.runtimeError);
  if (error === null) return null;
  const code = error.code;
  return typeof code === "string" && ERROR_CODE.test(code)
    ? `Lighthouse reported a runtime error (${code}).`
    : "Lighthouse reported a runtime error.";
}

function safeVersion(value: unknown): string | null {
  return typeof value === "string" && VERSION.test(value) ? value : null;
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
    version: safeVersion(root.lighthouseVersion),
  };
}
