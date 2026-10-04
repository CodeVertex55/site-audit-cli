import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CHECKS } from "../src/checks/registry.js";
import { renderChecksReference } from "../src/run.js";

const generated = renderChecksReference("markdown");

test("docs/checks.md is up to date with the registry", () => {
  const onDisk = readFileSync("docs/checks.md", "utf8").replace(/\r\n/g, "\n");
  expect(onDisk, "docs/checks.md is stale. Run npm run docs:checks").toBe(generated);
});

test("the generated reference lists every check and follows the writing rules", () => {
  for (const check of CHECKS) expect(generated).toContain(`\`${check.id}\``);
  expect(generated).not.toMatch(/[\u2013\u2014!]/);
});
