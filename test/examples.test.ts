import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { generateExamples } from "../scripts/gen-examples.js";

const NAMES = ["report.txt", "report.md", "report.json", "report.html"] as const;

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

const generated = await generateExamples();

test.each(NAMES)("examples/%s matches a fresh run against the fixture site", (name) => {
  const onDisk = lf(readFileSync(`examples/${name}`, "utf8"));
  expect(onDisk, `examples/${name} is stale. Run npm run examples`).toBe(lf(generated[name]));
});

test("a second run gives the same files", async () => {
  const again = await generateExamples();
  for (const name of NAMES) expect(lf(again[name])).toBe(lf(generated[name]));
});

test("the example reports hold the normalised dates and no real timings", () => {
  const result = JSON.parse(generated["report.json"]) as {
    startedAt: string;
    finishedAt: string;
    pages: { responseMs: number | null }[];
  };
  expect(result.startedAt).toBe("2026-10-04T09:00:00.000Z");
  expect(result.finishedAt).toBe("2026-10-04T09:00:12.000Z");
  result.pages.forEach((page, index) => {
    if (page.responseMs !== null) expect(page.responseMs).toBe(40 + index * 7);
  });
});

const FIXTURE_HOST = "127.0.0.1:4173";

function hostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/([^/\s"'<>)]+)/g)) hosts.add(match[1] ?? "");
  return [...hosts];
}

test("the HTML example links and loads nothing from a host other than the fixture server", () => {
  const html = generated["report.html"];
  const attributes = [...html.matchAll(/\s(?:href|src|action|poster|srcset)="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .join("\n");
  expect(hostsIn(attributes)).toEqual([FIXTURE_HOST]);
  expect(html).not.toMatch(/url\(\s*["']?https?:/i);
});

test("the HTML example names no host other than the fixture server and example.com", () => {
  // example.com appears only in the advice text of one check, as the reserved documentation domain.
  expect(hostsIn(generated["report.html"]).sort()).toEqual(["127.0.0.1:4173", "example.com"]);
});
