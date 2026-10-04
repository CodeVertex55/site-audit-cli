import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { HELP_TEXT } from "../src/args.js";
import { CHECKS } from "../src/checks/registry.js";
import { GROUPS } from "../src/types.js";

const FILES = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  ...readdirSync("docs")
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
];

// An en dash, an em dash or an exclamation mark.
const BANNED = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}!]`);

function read(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** The text with fenced code blocks and inline code spans blanked out. */
function proseOf(markdown: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && marker !== undefined) {
      fence = marker.charAt(0);
      lines.push("");
    } else if (fence !== null && marker !== undefined && marker.charAt(0) === fence) {
      fence = null;
      lines.push("");
    } else if (fence !== null) {
      lines.push("");
    } else {
      // The "!" that opens image syntax is markup, not prose.
      lines.push(line.replace(/`+[^`\n]*`+/g, "").replace(/!\[/g, "["));
    }
  }
  return lines.join("\n");
}

describe.each(FILES)("%s", (file) => {
  const prose = proseOf(read(file));

  test("has no em dash, en dash or exclamation mark in prose", () => {
    expect(prose).not.toMatch(BANNED);
  });

  test("every relative link points at a file that exists", () => {
    const targets = [...prose.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "");
    for (const target of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const path = target.split("#")[0] ?? "";
      expect(existsSync(resolve(dirname(file), path)), `${file} links to ${target}`).toBe(true);
    }
  });
});

describe("README", () => {
  const readme = read("README.md");

  test("the options table lists every flag in the help text", () => {
    const listed = new Set(
      [...readme.matchAll(/^\|\s*`(--[a-z-]+)/gm)].map((match) => match[1] ?? ""),
    );
    const flags = new Set(HELP_TEXT.match(/--[a-z]+(?:-[a-z]+)*/g) ?? []);
    expect(flags.size).toBeGreaterThan(10);
    for (const flag of flags) {
      expect(listed.has(flag), `${flag} is missing from the options table`).toBe(true);
    }
  });

  test("the check counts match the registry", () => {
    expect(readme).toContain(`${CHECKS.length} checks`);
    for (const group of GROUPS) {
      const count = CHECKS.filter((check) => check.group === group).length;
      expect(readme, `count for ${group}`).toMatch(new RegExp(`\\b${count} ${group}\\b`, "i"));
    }
  });

  test("describes the accessibility group as static checks only", () => {
    expect(readme).toContain("static checks only, not an accessibility audit");
  });

  test("links the example reports and the screenshot", () => {
    for (const name of ["report.txt", "report.md", "report.json", "report.html", "report.png"]) {
      expect(readme).toContain(`examples/${name}`);
      expect(existsSync(`examples/${name}`), `examples/${name}`).toBe(true);
    }
  });
});
