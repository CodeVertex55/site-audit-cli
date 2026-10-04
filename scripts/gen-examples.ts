import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { audit } from "../src/audit.js";
import { renderHtml } from "../src/report/html.js";
import { renderJson } from "../src/report/json.js";
import { renderMarkdown } from "../src/report/markdown.js";
import { renderText } from "../src/report/text.js";
import { DEFAULT_OPTIONS, type AuditResult } from "../src/types.js";
import { startSite } from "../test/server/index.js";
import { messySite } from "../test/server/sites.js";

export type ExampleName = "report.txt" | "report.md" | "report.json" | "report.html";

/** The fixture site always listens here, so the example files name the same address. */
const FIXTURE_PORT = 4173;
const STARTED_AT = "2026-10-04T09:00:00.000Z";
const FINISHED_AT = "2026-10-04T09:00:12.000Z";

/** The response time written into the example of the page at this position in the page list. */
function fixedResponseMs(index: number): number {
  return 40 + index * 7;
}

/**
 * Replaces the fields that change from run to run: the two timestamps, every response time and
 * any finding text that quotes a response time. No other field is touched.
 */
function normalise(result: AuditResult): AuditResult {
  const indexOfUrl = new Map(result.pages.map((page, index) => [page.url, index]));
  return {
    ...result,
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    checks: result.checks.map((check) => ({
      ...check,
      findings: check.findings.map((finding) => {
        const index = finding.url === null ? undefined : indexOfUrl.get(finding.url);
        if (index === undefined) return finding;
        return {
          ...finding,
          detail: finding.detail.replace(
            /Response took \d+ ms/g,
            `Response took ${fixedResponseMs(index)} ms`,
          ),
        };
      }),
    })),
    pages: result.pages.map((page, index) => ({
      ...page,
      responseMs: page.responseMs === null ? null : fixedResponseMs(index),
    })),
  };
}

/** Audits the bundled messy fixture site and renders the four example reports. */
export async function generateExamples(): Promise<Record<ExampleName, string>> {
  const site = await startSite(messySite(), { port: FIXTURE_PORT });
  try {
    const result = normalise(
      await audit({ ...DEFAULT_OPTIONS, startUrl: `${site.origin}/`, delayMs: 0 }),
    );
    return {
      "report.txt": renderText(result, { color: false }),
      "report.md": renderMarkdown(result),
      "report.json": renderJson(result),
      "report.html": renderHtml(result),
    };
  } finally {
    await site.close();
  }
}

async function main(): Promise<void> {
  const target = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples");
  await mkdir(target, { recursive: true });
  const files = await generateExamples();
  for (const [name, content] of Object.entries(files)) {
    await writeFile(resolve(target, name), content, "utf8");
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  await main();
}
