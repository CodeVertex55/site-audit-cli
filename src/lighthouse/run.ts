import { execFile } from "node:child_process";
import type { LighthousePage, LighthouseSection } from "../types.js";
import { parseLighthouseResult } from "./parse.js";

export type LighthouseRunner = (
  url: string,
) => Promise<{ ok: true; raw: unknown } | { ok: false; error: string }>;

export const LIGHTHOUSE_NOTE =
  "Lighthouse lab data, one run on this machine, mobile emulation. Results vary between runs.";

export const LIGHTHOUSE_NOT_FOUND_NOTE =
  "Not run: Lighthouse was not found. Install it with npm i -g lighthouse (Chrome is required), or pass --lighthouse-path.";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The failure text for a child that did not exit cleanly. Fixed strings only: nothing the child
 * wrote, and nothing from the command line, ever reaches the report.
 */
function failureText(
  error: { killed?: boolean; code?: unknown; signal?: unknown },
  timeoutMs: number,
): string {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "Lighthouse output was too large.";
  if (error.killed === true) {
    return `Lighthouse timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`;
  }
  if (typeof error.code === "number") return `Lighthouse exited with code ${error.code}.`;
  if (typeof error.signal === "string") return "Lighthouse was stopped by a signal.";
  return "Lighthouse could not be started.";
}

/**
 * Runs `node <entry> <url> ...` with an argument array and no shell, so the URL is never parsed
 * by a shell. A non-zero exit, a timeout or output that is not JSON is a failure result.
 */
export function createProcessRunner(
  entry: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): LighthouseRunner {
  return (url) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [
          entry,
          url,
          "--output=json",
          "--output-path=stdout",
          "--quiet",
          "--chrome-flags=--headless=new",
        ],
        { maxBuffer: MAX_BUFFER, timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
        (error, stdout) => {
          if (error !== null) {
            resolve({ ok: false, error: failureText(error, timeoutMs) });
            return;
          }
          try {
            resolve({ ok: true, raw: JSON.parse(stdout) as unknown });
          } catch {
            resolve({ ok: false, error: "Lighthouse output could not be read." });
          }
        },
      );
    });
}

function failedPage(url: string, error: string): LighthousePage {
  return {
    url,
    scores: { performance: null, accessibility: null, bestPractices: null, seo: null },
    metrics: { fcpMs: null, lcpMs: null, tbtMs: null, cls: null, speedIndexMs: null },
    error,
  };
}

function hasScore(page: LighthousePage): boolean {
  return Object.values(page.scores).some((value) => value !== null);
}

/** Runs the pages one at a time. Lighthouse results never feed findings or the exit code. */
export async function runLighthouse(
  urls: string[],
  runner: LighthouseRunner | null,
): Promise<LighthouseSection> {
  if (runner === null) {
    return { status: "not-found", version: null, note: LIGHTHOUSE_NOT_FOUND_NOTE, pages: [] };
  }

  const pages: LighthousePage[] = [];
  let version: string | null = null;
  for (const url of urls) {
    let outcome: Awaited<ReturnType<LighthouseRunner>>;
    try {
      outcome = await runner(url);
    } catch {
      outcome = { ok: false, error: "Lighthouse could not be run." };
    }
    if (!outcome.ok) {
      pages.push(failedPage(url, outcome.error));
      continue;
    }
    const parsed = parseLighthouseResult(outcome.raw, url);
    version ??= parsed.version;
    pages.push(
      !hasScore(parsed.page) && parsed.page.error === null
        ? { ...parsed.page, error: "Lighthouse returned no category scores." }
        : parsed.page,
    );
  }
  return {
    status: pages.some(hasScore) ? "ok" : "failed",
    version,
    note: LIGHTHOUSE_NOTE,
    pages,
  };
}
