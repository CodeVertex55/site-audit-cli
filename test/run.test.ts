import { load } from "cheerio";
import { afterEach, describe, expect, test } from "vitest";
import { CHECKS } from "../src/checks/registry.js";
import type { AuditResult, Finding } from "../src/types.js";
import { exitCodeFor, main, renderChecksReference, type Io } from "../src/run.js";
import { startSite, type TestSite } from "./server/index.js";
import { cleanSite, messySite } from "./server/sites.js";

type Harness = {
  io: Io;
  out: () => string;
  err: () => string;
  files: Map<string, string>;
};

function harness(overrides: Partial<Pick<Io, "isTTY" | "env" | "canWrite">> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const io: Io = {
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    writeFile: (path, data) => {
      files.set(path, data);
      return Promise.resolve();
    },
    canWrite: overrides.canWrite ?? (() => Promise.resolve(true)),
    isTTY: overrides.isTTY ?? false,
    env: overrides.env ?? {},
  };
  return { io, out: () => out.join(""), err: () => err.join(""), files };
}

let site: TestSite | undefined;

afterEach(async () => {
  await site?.close();
  site = undefined;
});

async function clean(): Promise<TestSite> {
  site = await startSite(cleanSite());
  return site;
}

describe("main: information commands and usage errors", () => {
  test("--version prints the version", async () => {
    const h = harness();
    expect(await main(["--version"], h.io)).toBe(0);
    expect(h.out()).toBe("1.0.0\n");
  });

  test("--help prints the usage and returns 0", async () => {
    const h = harness();
    expect(await main(["--help"], h.io)).toBe(0);
    for (const flag of ["--format", "--fail-on", "--only", "--lighthouse-path", "--quiet"]) {
      expect(h.out()).toContain(flag);
    }
    expect(h.err()).toBe("");
  });

  test("no arguments is a usage error", async () => {
    const h = harness();
    expect(await main([], h.io)).toBe(2);
    expect(h.err()).toContain("site-audit: ");
    expect(h.err()).toContain("Run site-audit --help for usage.");
    expect(h.out()).toBe("");
  });

  test("checks prints every check id", async () => {
    const h = harness();
    expect(await main(["checks"], h.io)).toBe(0);
    for (const check of CHECKS) expect(h.out()).toContain(check.id);
  });

  test("checks --format markdown matches the generated reference", async () => {
    const h = harness();
    expect(await main(["checks", "--format", "markdown"], h.io)).toBe(0);
    expect(h.out()).toBe(renderChecksReference("markdown"));
  });
});

describe("main: exit codes on the fixture sites", () => {
  test("the clean site fails on plain HTTP by default and passes with --fail-on never", async () => {
    const s = await clean();
    const a = harness();
    expect(await main([s.url("/"), "--delay", "0", "--quiet"], a.io)).toBe(1);
    const b = harness();
    expect(await main([s.url("/"), "--delay", "0", "--quiet", "--fail-on", "never"], b.io)).toBe(0);
  });

  test("the clean site passes when only the SEO group runs", async () => {
    const s = await clean();
    const h = harness();
    expect(await main([s.url("/"), "--delay", "0", "--quiet", "--only", "seo"], h.io)).toBe(0);
  });

  test("the messy site returns 1", async () => {
    site = await startSite(messySite());
    const h = harness();
    expect(await main([site.url("/"), "--delay", "0", "--quiet"], h.io)).toBe(1);
  });

  test("--fail-on warning with the accessibility group on the messy site returns 1", async () => {
    site = await startSite(messySite());
    const h = harness();
    const args = [site.url("/"), "--delay", "0", "--quiet", "--fail-on", "warning"];
    expect(await main([...args, "--only", "accessibility"], h.io)).toBe(1);
  });

  test("a closed port returns 3 with a message on stderr and nothing on stdout", async () => {
    const s = await startSite(cleanSite());
    const url = s.url("/");
    await s.close();
    const h = harness();
    expect(await main([url, "--delay", "0", "--timeout", "2000", "--quiet"], h.io)).toBe(3);
    expect(h.err()).toContain("site-audit: ");
    expect(h.err().length).toBeGreaterThan("site-audit: ".length);
    expect(h.out()).toBe("");
  });
});

describe("main: output", () => {
  test("each format produces output its parser accepts", async () => {
    const s = await clean();
    const base = [s.url("/"), "--delay", "0", "--quiet", "--fail-on", "never", "--max-pages", "2"];

    const json = harness();
    expect(await main([...base, "--format", "json"], json.io)).toBe(0);
    const parsed = JSON.parse(json.out()) as AuditResult;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.scope.maxPages).toBe(2);

    const html = harness();
    expect(await main([...base, "--format", "html"], html.io)).toBe(0);
    expect(load(html.out())("html[lang]").length).toBe(1);

    const md = harness();
    expect(await main([...base, "--format", "markdown"], md.io)).toBe(0);
    expect(md.out().startsWith("# ")).toBe(true);

    const text = harness();
    expect(await main(base, text.io)).toBe(0);
    expect(text.out()).toContain("Site audit: ");
  });

  test("--output writes the file and prints nothing to stdout", async () => {
    const s = await clean();
    const h = harness();
    const args = [
      s.url("/"),
      "--delay",
      "0",
      "--quiet",
      "--fail-on",
      "never",
      "--output",
      "out.json",
    ];
    expect(await main(args, h.io)).toBe(0);
    expect(h.out()).toBe("");
    expect(h.err()).toContain("Report written to out.json");
    const written = h.files.get("out.json");
    expect(written).toBeDefined();
    expect((JSON.parse(written ?? "") as AuditResult).schemaVersion).toBe(1);
  });

  test("an unwritable --output path returns 2 with a cleaned message and nothing on stdout", async () => {
    const s = await clean();
    const h = harness();
    const io: Io = {
      ...h.io,
      writeFile: () => Promise.reject(new Error("EACCES: permission denied\u001b[31m")),
    };
    const args = [
      s.url("/"),
      "--delay",
      "0",
      "--quiet",
      "--max-pages",
      "1",
      "--output",
      "bad\u0007/r.json",
    ];
    expect(await main(args, io)).toBe(2);
    expect(h.err()).toBe("site-audit: could not write bad/r.json: EACCES: permission denied\n");
    expect(h.out()).toBe("");
  });

  test("an --output path that cannot be written returns 2 before any request is made", async () => {
    const s = await clean();
    const asked: string[] = [];
    const h = harness({
      canWrite: (path) => {
        asked.push(path);
        return Promise.resolve(false);
      },
    });
    const args = [s.url("/"), "--delay", "0", "--quiet", "--output", "bad\u0007/r.json"];
    expect(await main(args, h.io)).toBe(2);
    expect(asked).toEqual(["bad\u0007/r.json"]);
    expect(h.err()).toBe("site-audit: could not write bad/r.json\n");
    expect(h.out()).toBe("");
    expect(h.files.size).toBe(0);
    expect(s.log).toEqual([]);
  });

  test("crawl notes go to stderr, cleaned, unless --quiet", async () => {
    const target = await startSite(cleanSite());
    try {
      site = await startSite({ "/": { status: 302, headers: { location: target.url("/") } } });
      const base = [site.url("/"), "--delay", "0", "--fail-on", "never", "--max-pages", "1"];
      const loud = harness();
      await main(base, loud.io);
      expect(loud.err()).toContain(`Note: Start URL redirected to ${target.origin}/\n`);
      expect(loud.out()).not.toContain("Note:");
      const quiet = harness();
      await main([...base, "--quiet"], quiet.io);
      expect(quiet.err()).toBe("");
    } finally {
      await target.close();
    }
  });

  test("progress goes to stderr unless --quiet", async () => {
    const s = await clean();
    const loud = harness();
    await main([s.url("/"), "--delay", "0", "--fail-on", "never", "--max-pages", "2"], loud.io);
    expect(loud.err()).toMatch(/\[1\/2\] http:\/\/127\.0\.0\.1:\d+\//);
    expect(loud.out()).not.toContain("[1/2]");

    const quiet = harness();
    await main(
      [s.url("/"), "--delay", "0", "--fail-on", "never", "--max-pages", "2", "--quiet"],
      quiet.io,
    );
    expect(quiet.err()).toBe("");
  });

  test("colour is used only on a terminal, without NO_COLOR or --no-color, and on stdout", async () => {
    const s = await clean();
    const base = [s.url("/"), "--delay", "0", "--quiet", "--fail-on", "never", "--max-pages", "1"];
    const colourful = async (
      extra: string[],
      io: Partial<Pick<Io, "isTTY" | "env">>,
    ): Promise<boolean> => {
      const h = harness(io);
      await main([...base, ...extra], h.io);
      const text = h.files.get("r.txt") ?? h.out();
      return text.includes("\u001b[");
    };
    expect(await colourful([], { isTTY: false })).toBe(false);
    expect(await colourful([], { isTTY: true })).toBe(true);
    expect(await colourful([], { isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(await colourful(["--no-color"], { isTTY: true })).toBe(false);
    expect(await colourful(["--output", "r.txt"], { isTTY: true })).toBe(false);
  });
});

describe("exitCodeFor", () => {
  const finding = (severity: Finding["severity"]): Finding => ({
    checkId: "X",
    severity,
    group: "seo",
    url: null,
    detail: "d",
  });
  const result = (checkSeverity: Finding["severity"], findings: Finding[]): AuditResult =>
    ({
      checks: [
        {
          id: "X",
          group: "seo",
          severity: checkSeverity,
          title: "t",
          why: "w",
          fix: "f",
          status: findings.length > 0 ? "fail" : "pass",
          findings,
        },
      ],
    }) as unknown as AuditResult;

  test("counts findings by their own severity", () => {
    const lowered = result("error", [finding("warning")]);
    expect(exitCodeFor(lowered, "error")).toBe(0);
    expect(exitCodeFor(lowered, "warning")).toBe(1);
    expect(exitCodeFor(lowered, "never")).toBe(0);
    const raised = result("info", [finding("error")]);
    expect(exitCodeFor(raised, "error")).toBe(1);
    expect(exitCodeFor(raised, "never")).toBe(0);
  });

  test("info findings never fail a run and an empty result passes", () => {
    expect(exitCodeFor(result("info", [finding("info")]), "warning")).toBe(0);
    expect(exitCodeFor(result("error", []), "warning")).toBe(0);
  });
});

describe("renderChecksReference", () => {
  test("the text form lists every check with its severity and title", () => {
    const text = renderChecksReference("text");
    for (const check of CHECKS) {
      expect(text).toContain(check.id);
      expect(text).toContain(check.title);
    }
  });

  test("the markdown form has one table per group and the accessibility notice", () => {
    const md = renderChecksReference("markdown");
    expect(md.startsWith("# ")).toBe(true);
    expect(
      md.match(
        /^\| Id \| Severity \| Check \| Why it matters \| How to fix \| Rule of thumb \|$/gm,
      ),
    ).toHaveLength(4);
    expect(md).toContain("Static checks only.");
    expect(md).not.toContain("\r");
  });
});
