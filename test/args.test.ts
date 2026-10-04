import { describe, expect, test } from "vitest";
import { HELP_TEXT, parseCli } from "../src/args.js";
import { UsageError } from "../src/errors.js";

describe("parseCli", () => {
  test("defaults", () => {
    const c = parseCli(["https://example.com"]);
    expect(c).toMatchObject({
      kind: "audit",
      options: {
        startUrl: "https://example.com/",
        maxPages: 50,
        delayMs: 1000,
        checkExternal: false,
        ignoreRobots: false,
        only: null,
        lighthouse: false,
      },
      cli: { format: "text", failOn: "error", output: null, color: null, quiet: false },
    });
  });

  test("a bare host is accepted", () => {
    expect(parseCli(["example.com"])).toMatchObject({
      options: { startUrl: "https://example.com/" },
    });
  });

  test("every value flag is read, in both spellings", () => {
    const c = parseCli([
      "example.com",
      "--max-pages",
      "10",
      "--max-depth=0",
      "--concurrency",
      "8",
      "--delay",
      "0",
      "--timeout",
      "1000",
      "--max-assets",
      "5000",
      "--user-agent",
      "my-agent",
      "--lighthouse-pages",
      "5",
      "--lighthouse-path",
      "some/folder",
      "--fail-on",
      "warning",
      "--check-external",
      "--ignore-robots",
      "--lighthouse",
      "--no-color",
      "--quiet",
    ]);
    expect(c).toMatchObject({
      options: {
        maxPages: 10,
        maxDepth: 0,
        concurrency: 8,
        delayMs: 0,
        timeoutMs: 1000,
        maxAssets: 5000,
        userAgent: "my-agent",
        lighthousePages: 5,
        lighthousePath: "some/folder",
        checkExternal: true,
        ignoreRobots: true,
        lighthouse: true,
      },
      cli: { failOn: "warning", color: false, quiet: true },
    });
  });

  test("the range ends are accepted", () => {
    expect(parseCli(["example.com", "--max-pages", "2000", "--max-depth", "20"])).toMatchObject({
      options: { maxPages: 2000, maxDepth: 20 },
    });
    expect(parseCli(["example.com", "--timeout", "120000", "--delay", "60000"])).toMatchObject({
      options: { timeoutMs: 120000, delayMs: 60000 },
    });
  });

  test("--exclude is repeatable and does not leak into the defaults", () => {
    const c = parseCli(["example.com", "--exclude", "/blog/**", "--exclude", "/tmp/*"]);
    expect(c).toMatchObject({ options: { exclude: ["/blog/**", "/tmp/*"] } });
    expect(parseCli(["example.com"])).toMatchObject({ options: { exclude: [] } });
  });

  test("--only is put in the canonical order without repeats", () => {
    expect(parseCli(["example.com", "--only", "health,seo,seo"])).toMatchObject({
      options: { only: ["seo", "health"] },
    });
    expect(parseCli(["example.com", "--only", "accessibility, performance"])).toMatchObject({
      options: { only: ["performance", "accessibility"] },
    });
  });

  test("format is inferred from the output extension", () => {
    expect(parseCli(["example.com", "--output", "r.html"])).toMatchObject({
      cli: { format: "html", output: "r.html" },
    });
    expect(parseCli(["example.com", "--output", "r.html", "--format", "json"])).toMatchObject({
      cli: { format: "json" },
    });
    for (const [file, format] of [
      ["r.json", "json"],
      ["r.md", "markdown"],
      ["r.MARKDOWN", "markdown"],
      ["r.htm", "html"],
      ["r.txt", "text"],
      ["report", "text"],
    ] as const) {
      expect(parseCli(["example.com", "--output", file])).toMatchObject({ cli: { format } });
    }
  });

  test("--help and --version win over everything", () => {
    expect(parseCli(["--help"])).toEqual({ kind: "help" });
    expect(parseCli(["example.com", "--nope", "--max-pages", "x", "--help"])).toEqual({
      kind: "help",
    });
    expect(parseCli(["a.example", "b.example", "--version"])).toEqual({ kind: "version" });
  });

  test("checks selects the reference command", () => {
    expect(parseCli(["checks"])).toEqual({ kind: "checks", format: "text" });
    expect(parseCli(["checks", "--format", "markdown"])).toEqual({
      kind: "checks",
      format: "markdown",
    });
    expect(() => parseCli(["checks", "--format", "json"])).toThrow(UsageError);
    expect(() => parseCli(["checks", "--quiet"])).toThrow(UsageError);
    expect(() => parseCli(["checks", "example.com"])).toThrow(UsageError);
  });

  test.each([
    [[]],
    [["a.example", "b.example"]],
    [["example.com", "--max-pages", "0"]],
    [["example.com", "--max-pages", "2001"]],
    [["example.com", "--max-pages", "x"]],
    [["example.com", "--max-pages", "1.5"]],
    [["example.com", "--max-pages"]],
    [["example.com", "--max-pages", "--quiet"]],
    [["example.com", "--max-depth", "21"]],
    [["example.com", "--format", "pdf"]],
    [["example.com", "--only", "seo,speed"]],
    [["example.com", "--only", ""]],
    [["example.com", "--nope"]],
    [["ftp://example.com"]],
    [["https://user:pass@example.com"]],
    [["example.com", "--concurrency", "9"]],
    [["example.com", "--delay", "60001"]],
    [["example.com", "--timeout", "999"]],
    [["example.com", "--max-assets", "5001"]],
    [["example.com", "--lighthouse-pages", "6"]],
    [["example.com", "--fail-on", "info"]],
    [["example.com", "--quiet=yes"]],
  ])("usage error for %j", (argv) => expect(() => parseCli(argv)).toThrow(UsageError));

  test("the help text names every flag", () => {
    for (const flag of [
      "--format",
      "--output",
      "--max-pages",
      "--max-depth",
      "--concurrency",
      "--delay",
      "--timeout",
      "--max-assets",
      "--exclude",
      "--check-external",
      "--ignore-robots",
      "--user-agent",
      "--only",
      "--lighthouse",
      "--lighthouse-pages",
      "--lighthouse-path",
      "--fail-on",
      "--no-color",
      "--quiet",
      "--version",
      "--help",
    ]) {
      expect(HELP_TEXT, flag).toContain(flag);
    }
    expect(HELP_TEXT).toContain("site-audit checks");
  });
});
