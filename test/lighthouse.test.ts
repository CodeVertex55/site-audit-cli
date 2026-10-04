import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { locateLighthouse } from "../src/lighthouse/locate.js";
import { parseLighthouseResult } from "../src/lighthouse/parse.js";
import {
  createProcessRunner,
  LIGHTHOUSE_NOT_FOUND_NOTE,
  LIGHTHOUSE_NOTE,
  runLighthouse,
  type LighthouseRunner,
} from "../src/lighthouse/run.js";
import { main, type Io } from "../src/run.js";
import { startSite, type TestSite } from "./server/index.js";
import { cleanSite } from "./server/sites.js";

const temps: string[] = [];

function tempDir(): string {
  // realpath so the expected values match what the locator resolves on every platform
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "site-audit-lh-")));
  temps.push(dir);
  return dir;
}

function touch(path: string, content = "// fake lighthouse\n"): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

let site: TestSite | undefined;

afterEach(async () => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  await site?.close();
  site = undefined;
});

const ENTRY = ["node_modules", "lighthouse", "cli", "index.js"];

describe("locateLighthouse", () => {
  // The host platform, so the PATH delimiter always matches the temp paths built by node:path.
  const platform = process.platform;
  const base = { explicitPath: null, pathEnv: "", platform };

  test("an explicit package folder resolves to its cli/index.js", () => {
    const root = tempDir();
    const entry = touch(join(root, "pkg", "cli", "index.js"));
    expect(locateLighthouse({ ...base, explicitPath: join(root, "pkg"), cwd: root })).toBe(entry);
  });

  test("an explicit cli/index.js file is accepted as given", () => {
    const root = tempDir();
    const entry = touch(join(root, "pkg", "cli", "index.js"));
    expect(locateLighthouse({ ...base, explicitPath: entry, cwd: root })).toBe(entry);
  });

  test("an explicit path that does not exist gives null, even when another copy is installed", () => {
    const root = tempDir();
    touch(join(root, ...ENTRY));
    expect(
      locateLighthouse({ ...base, explicitPath: join(root, "missing"), cwd: root }),
    ).toBeNull();
  });

  test("an explicit folder without cli/index.js gives null", () => {
    const root = tempDir();
    mkdirSync(join(root, "empty"));
    expect(locateLighthouse({ ...base, explicitPath: join(root, "empty"), cwd: root })).toBeNull();
  });

  test("finds node_modules/lighthouse in the working directory", () => {
    const root = tempDir();
    const entry = touch(join(root, ...ENTRY));
    expect(locateLighthouse({ ...base, cwd: root })).toBe(entry);
  });

  test("walks up from a nested working directory", () => {
    const root = tempDir();
    const entry = touch(join(root, ...ENTRY));
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(locateLighthouse({ ...base, cwd: nested })).toBe(entry);
  });

  test("finds the Windows global layout beside lighthouse.cmd on PATH", () => {
    const root = tempDir();
    const bin = join(root, "npm");
    touch(join(bin, "lighthouse.cmd"), "@echo off\n");
    const entry = touch(join(bin, ...ENTRY));
    const cwd = join(root, "work");
    mkdirSync(cwd);
    expect(
      locateLighthouse({
        explicitPath: null,
        cwd,
        pathEnv: [root, bin].join(";"),
        platform: "win32",
      }),
    ).toBe(entry);
  });

  test("finds the Unix global layout beside lighthouse on PATH", () => {
    const root = tempDir();
    const bin = join(root, "bin");
    touch(join(bin, "lighthouse"), "#!/bin/sh\n");
    const entry = resolve(touch(join(root, "lib", ...ENTRY)));
    const cwd = join(root, "work");
    mkdirSync(cwd);
    expect(
      locateLighthouse({
        explicitPath: null,
        cwd,
        pathEnv: [join(root, "other"), bin].join(delimiter),
        platform,
      }),
    ).toBe(entry);
  });

  test("follows a lighthouse symlink that ends in cli/index.js", (ctx) => {
    const root = tempDir();
    const entry = touch(join(root, "elsewhere", "lighthouse", "cli", "index.js"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    try {
      symlinkSync(entry, join(bin, "lighthouse"));
    } catch {
      ctx.skip();
    }
    const cwd = join(root, "work");
    mkdirSync(cwd);
    expect(
      locateLighthouse({
        explicitPath: null,
        cwd,
        pathEnv: [join(root, "other"), bin].join(delimiter),
        platform,
      }),
    ).toBe(entry);
  });

  test("a PATH folder without a lighthouse executable is ignored", () => {
    const root = tempDir();
    const bin = join(root, "bin");
    touch(join(bin, ...ENTRY));
    const cwd = join(root, "work");
    mkdirSync(cwd);
    expect(
      locateLighthouse({
        explicitPath: null,
        cwd,
        pathEnv: [join(root, "other"), bin].join(delimiter),
        platform,
      }),
    ).toBeNull();
  });

  test("a PATH is split on the delimiter of the platform it is given", () => {
    const root = tempDir();
    const bin = join(root, "npm");
    touch(join(bin, "lighthouse.cmd"), "@echo off\n");
    const entry = touch(join(bin, ...ENTRY));
    const cwd = join(root, "work");
    mkdirSync(cwd);
    const pathEnv = [join(root, "other"), "", bin].join(";");
    expect(locateLighthouse({ explicitPath: null, cwd, pathEnv, platform: "win32" })).toBe(entry);
  });

  test("gives null when nothing is installed", () => {
    const root = tempDir();
    expect(locateLighthouse({ ...base, cwd: root, pathEnv: join(root, "none") })).toBeNull();
  });
});

const RAW = {
  lighthouseVersion: "12.0.0",
  categories: {
    performance: { score: 0.87 },
    accessibility: { score: 1 },
    "best-practices": { score: 0.92 },
    seo: { score: 0.9 },
  },
  audits: {
    "first-contentful-paint": { numericValue: 1234.5 },
    "largest-contentful-paint": { numericValue: 2500 },
    "total-blocking-time": { numericValue: 120 },
    "speed-index": { numericValue: 3100 },
    "cumulative-layout-shift": { numericValue: 0.045 },
  },
};

const NULL_SCORES = { performance: null, accessibility: null, bestPractices: null, seo: null };
const NULL_METRICS = { fcpMs: null, lcpMs: null, tbtMs: null, cls: null, speedIndexMs: null };

describe("parseLighthouseResult", () => {
  test("reads the four scores, the five metrics and the version", () => {
    expect(parseLighthouseResult(RAW, "https://example.com/")).toEqual({
      page: {
        url: "https://example.com/",
        scores: { performance: 87, accessibility: 100, bestPractices: 92, seo: 90 },
        metrics: { fcpMs: 1234.5, lcpMs: 2500, tbtMs: 120, cls: 0.045, speedIndexMs: 3100 },
        error: null,
      },
      version: "12.0.0",
    });
  });

  test("rounds a score to a whole number", () => {
    const raw = { categories: { performance: { score: 0.876 } } };
    expect(parseLighthouseResult(raw, "u").page.scores.performance).toBe(88);
  });

  test.each([{}, null, "text", 42, [], { categories: "x", audits: 3 }])(
    "a malformed value gives nulls without throwing: %j",
    (raw) => {
      expect(parseLighthouseResult(raw, "u")).toEqual({
        page: { url: "u", scores: NULL_SCORES, metrics: NULL_METRICS, error: null },
        version: null,
      });
    },
  );

  test("a missing or non-numeric field gives null for that field only", () => {
    const raw = {
      categories: { performance: { score: null }, seo: { score: "high" }, accessibility: {} },
      audits: { "total-blocking-time": { numericValue: "fast" }, "speed-index": {} },
    };
    expect(parseLighthouseResult(raw, "u").page).toEqual({
      url: "u",
      scores: NULL_SCORES,
      metrics: NULL_METRICS,
      error: null,
    });
  });

  test.each([-0.1, 1.01, 500])("a score outside 0 to 1 becomes null: %s", (score) => {
    const raw = { categories: { performance: { score }, seo: { score: 0.5 } } };
    const parsed = parseLighthouseResult(raw, "u").page.scores;
    expect(parsed.performance).toBeNull();
    expect(parsed.seo).toBe(50);
  });

  test("a runtime error is reported by its code only, never its message", () => {
    const message = "C:\\Users\\Some Name\\chrome failed";
    const raw = { runtimeError: { code: "NO_FCP", message } };
    expect(parseLighthouseResult(raw, "u").page).toEqual({
      url: "u",
      scores: NULL_SCORES,
      metrics: NULL_METRICS,
      error: "Lighthouse reported a runtime error (NO_FCP).",
    });
  });

  test.each([["../../etc"], ["no_fcp"], ["X"], ["A".repeat(42)], [42], [undefined]])(
    "a runtime error with the code %j gets the generic message",
    (code) => {
      const raw = { runtimeError: { code, message: "secret" } };
      expect(parseLighthouseResult(raw, "u").page.error).toBe(
        "Lighthouse reported a runtime error.",
      );
    },
  );

  test.each([["/home/me/lighthouse"], ["12 0"], [""], ["1".repeat(31)], [12], [null]])(
    "a version that is not a plain version string becomes null: %j",
    (lighthouseVersion) => {
      expect(parseLighthouseResult({ lighthouseVersion }, "u").version).toBeNull();
    },
  );

  test("a plain version string is kept", () => {
    expect(parseLighthouseResult({ lighthouseVersion: "12.0.0-beta.1+x" }, "u").version).toBe(
      "12.0.0-beta.1+x",
    );
  });
});

const okRunner =
  (raw: unknown): LighthouseRunner =>
  () =>
    Promise.resolve({ ok: true, raw });

describe("runLighthouse", () => {
  test("a null runner gives the not-found section", async () => {
    expect(await runLighthouse(["https://example.com/"], null)).toEqual({
      status: "not-found",
      version: null,
      note: "Not run: Lighthouse was not found. Install it with npm i -g lighthouse (Chrome is required), or pass --lighthouse-path.",
      pages: [],
    });
    expect(LIGHTHOUSE_NOT_FOUND_NOTE).toContain("npm i -g lighthouse");
  });

  test("runs the pages in order, one at a time, and reports ok with the version", async () => {
    const seen: string[] = [];
    let active = 0;
    let overlapped = false;
    const runner: LighthouseRunner = async (url) => {
      active += 1;
      if (active > 1) overlapped = true;
      seen.push(url);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { ok: true, raw: RAW };
    };
    const section = await runLighthouse(["https://a.test/", "https://b.test/"], runner);
    expect(overlapped).toBe(false);
    expect(seen).toEqual(["https://a.test/", "https://b.test/"]);
    expect(section.status).toBe("ok");
    expect(section.version).toBe("12.0.0");
    expect(section.note).toBe(LIGHTHOUSE_NOTE);
    expect(section.note).toBe(
      "Lighthouse lab data, one run on this machine, mobile emulation. Results vary between runs.",
    );
    expect(section.pages.map((p) => p.url)).toEqual(["https://a.test/", "https://b.test/"]);
    expect(section.pages.every((p) => p.scores.performance === 87)).toBe(true);
  });

  test("a runner failure gives a page with nulls and the error, and the section fails", async () => {
    const runner: LighthouseRunner = () => Promise.resolve({ ok: false, error: "Chrome missing" });
    const section = await runLighthouse(["https://a.test/"], runner);
    expect(section.status).toBe("failed");
    expect(section.version).toBeNull();
    expect(section.pages).toEqual([
      {
        url: "https://a.test/",
        scores: NULL_SCORES,
        metrics: NULL_METRICS,
        error: "Chrome missing",
      },
    ]);
  });

  test("one failed page does not stop the next, and one scored page makes the section ok", async () => {
    let call = 0;
    const runner: LighthouseRunner = () => {
      call += 1;
      return Promise.resolve(call === 1 ? { ok: false, error: "boom" } : { ok: true, raw: RAW });
    };
    const section = await runLighthouse(["https://a.test/", "https://b.test/"], runner);
    expect(section.status).toBe("ok");
    expect(section.pages[0]?.error).toBe("boom");
    expect(section.pages[1]?.scores.performance).toBe(87);
  });

  test("a result with no scores and no error is a failed page with a stated reason", async () => {
    const section = await runLighthouse(["https://a.test/"], okRunner({ categories: {} }));
    expect(section.status).toBe("failed");
    expect(section.pages[0]?.error).toBe("Lighthouse returned no category scores.");
  });

  test("a runner that throws is a failed page, not a thrown error", async () => {
    const runner: LighthouseRunner = () =>
      Promise.reject(new Error("spawn failed in C:\\Users\\Some Name"));
    const section = await runLighthouse(["https://a.test/"], runner);
    expect(section.status).toBe("failed");
    expect(section.pages[0]?.error).toBe("Lighthouse could not be run.");
  });
});

describe("createProcessRunner", () => {
  function fakeLighthouse(script: string): string {
    return touch(join(tempDir(), "cli", "index.js"), script);
  }

  test("returns the parsed JSON the script prints and passes the documented flags", async () => {
    const entry = fakeLighthouse(
      `console.log(JSON.stringify({ lighthouseVersion: "0.0.0-test", categories: {}, argv: process.argv.slice(2) }));\n`,
    );
    const result = await createProcessRunner(entry)("https://example.com/a?b=1&c=$(x)");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = result.raw as { lighthouseVersion: string; argv: string[] };
    expect(raw.lighthouseVersion).toBe("0.0.0-test");
    expect(raw.argv).toEqual([
      "https://example.com/a?b=1&c=$(x)",
      "--output=json",
      "--output-path=stdout",
      "--quiet",
      "--chrome-flags=--headless=new",
    ]);
  });

  test("stderr text never reaches the error: a file URL and a stack trace give the exit code only", async () => {
    const entry = fakeLighthouse(
      `console.error("file:///C:/Users/Some%20Name/x/cli/index.js:2\\n    throw new Error(1);\\nError: boom\\n    at file:///C:/Users/Some%20Name/x/cli/index.js:2:7"); process.exit(1);\n`,
    );
    const result = await createProcessRunner(entry)("https://example.com/");
    expect(result).toEqual({ ok: false, error: "Lighthouse exited with code 1." });
  });

  test("a silent non-zero exit gives the exit code only", async () => {
    const entry = fakeLighthouse(`process.exit(1);\n`);
    const result = await createProcessRunner(entry)("https://example.com/");
    expect(result).toEqual({ ok: false, error: "Lighthouse exited with code 1." });
  });

  test.each([
    ["the entry path", `process.argv[1]`],
    ["the node path", `process.execPath`],
    ["the home folder", JSON.stringify(homedir())],
  ])("stderr naming %s gives the exit code only", async (_name, expr) => {
    const entry = fakeLighthouse(
      `console.error("failed in " + ${expr} + " badly"); process.exit(3);\n`,
    );
    const result = await createProcessRunner(entry)("https://example.com/");
    expect(result).toEqual({ ok: false, error: "Lighthouse exited with code 3." });
  });

  test("a missing entry file gives the exit code only, with no path or URL", async () => {
    const missing = join(tempDir(), "cli", "index.js");
    const result = await createProcessRunner(missing)("https://example.com/");
    expect(result).toEqual({ ok: false, error: "Lighthouse exited with code 1." });
  });

  test.skipIf(process.platform === "win32")(
    "a child stopped by a signal is reported as such",
    async () => {
      const entry = fakeLighthouse(`process.kill(process.pid, "SIGKILL");\n`);
      const result = await createProcessRunner(entry)("https://example.com/");
      expect(result).toEqual({ ok: false, error: "Lighthouse was stopped by a signal." });
    },
  );

  test("output that is not JSON is a failure", async () => {
    const entry = fakeLighthouse(`console.log("not json");\n`);
    const result = await createProcessRunner(entry)("https://example.com/");
    expect(result).toEqual({ ok: false, error: "Lighthouse output could not be read." });
  });

  test("a script that outlives the timeout is stopped and reported as timed out", async () => {
    const entry = fakeLighthouse(`setInterval(() => {}, 1000);\n`);
    const result = await createProcessRunner(entry, 300)("https://example.com/");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/timed out/i);
  });

  test("a missing entry file is a failure, not a thrown error", async () => {
    const missing = join(tempDir(), "cli", "index.js");
    expect(existsSync(missing)).toBe(false);
    const result = await createProcessRunner(missing)("https://example.com/");
    expect(result.ok).toBe(false);
  });
});

describe("main with --lighthouse", () => {
  function harness(): { io: Io; out: () => string; err: () => string } {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      stdout: (s) => void out.push(s),
      stderr: (s) => void err.push(s),
      writeFile: () => Promise.resolve(),
      isTTY: false,
      env: {},
    };
    return { io, out: () => out.join(""), err: () => err.join("") };
  }

  const args = (url: string): string[] => [
    url,
    "--delay",
    "0",
    "--quiet",
    "--max-pages",
    "2",
    "--format",
    "json",
  ];

  test("an injected runner puts its section in the JSON and leaves the exit code alone", async () => {
    site = await startSite(cleanSite());
    const urls: string[][] = [];
    const deps = {
      lighthouse: (u: string[]) => {
        urls.push(u);
        return runLighthouse(u, okRunner(RAW));
      },
    };

    const failing = harness();
    expect(await main([...args(site.url("/")), "--lighthouse"], failing.io, deps)).toBe(1);
    const parsed = JSON.parse(failing.out()) as { lighthouse: { status: string; version: string } };
    expect(parsed.lighthouse.status).toBe("ok");
    expect(parsed.lighthouse.version).toBe("12.0.0");
    expect(urls).toHaveLength(1);

    const passing = harness();
    const never = [...args(site.url("/")), "--lighthouse", "--fail-on", "never"];
    expect(await main(never, passing.io, deps)).toBe(0);
  });

  test("a failing Lighthouse run does not change the exit code", async () => {
    site = await startSite(cleanSite());
    const deps = {
      lighthouse: (u: string[]) =>
        runLighthouse(u, () => Promise.resolve({ ok: false, error: "no chrome" })),
    };
    const h = harness();
    const argv = [...args(site.url("/")), "--lighthouse", "--fail-on", "never"];
    expect(await main(argv, h.io, deps)).toBe(0);
    const parsed = JSON.parse(h.out()) as { lighthouse: { status: string } };
    expect(parsed.lighthouse.status).toBe("failed");
  });

  test("without --lighthouse there is no section and the runner is not called", async () => {
    site = await startSite(cleanSite());
    let called = false;
    const deps = {
      lighthouse: (u: string[]) => {
        called = true;
        return runLighthouse(u, okRunner(RAW));
      },
    };
    const h = harness();
    await main(args(site.url("/")), h.io, deps);
    expect(called).toBe(false);
    expect((JSON.parse(h.out()) as { lighthouse: unknown }).lighthouse).toBeNull();
  });

  test("a found entry is run as a child process and its result lands in the report", async () => {
    site = await startSite(cleanSite());
    const pkg = join(tempDir(), "lighthouse");
    touch(
      join(pkg, "cli", "index.js"),
      `console.log(JSON.stringify({ lighthouseVersion: "0.0.0-test", categories: { performance: { score: 0.9 } } }));\n`,
    );
    const h = harness();
    const argv = [...args(site.url("/")), "--lighthouse", "--lighthouse-path", pkg];
    expect(await main([...argv, "--fail-on", "never"], h.io)).toBe(0);
    const parsed = JSON.parse(h.out()) as {
      lighthouse: { status: string; version: string; pages: { scores: { performance: number } }[] };
    };
    expect(parsed.lighthouse.status).toBe("ok");
    expect(parsed.lighthouse.version).toBe("0.0.0-test");
    expect(parsed.lighthouse.pages).toHaveLength(1);
    expect(parsed.lighthouse.pages[0]?.scores.performance).toBe(90);
    expect(h.err()).toBe("");
  });

  test("--lighthouse-path to a missing folder gives a not-found section and the install hint", async () => {
    site = await startSite(cleanSite());
    const h = harness();
    const missing = join(tempDir(), "no-such-lighthouse");
    const argv = [...args(site.url("/")), "--lighthouse", "--lighthouse-path", missing];
    expect(await main([...argv, "--fail-on", "never"], h.io)).toBe(0);
    const parsed = JSON.parse(h.out()) as { lighthouse: { status: string; pages: unknown[] } };
    expect(parsed.lighthouse.status).toBe("not-found");
    expect(parsed.lighthouse.pages).toEqual([]);
    expect(h.err()).toContain(LIGHTHOUSE_NOT_FOUND_NOTE);
    expect(h.err()).toContain("npm i -g lighthouse");
  });
});

describe("failure text is never free text", () => {
  const FIXED =
    /^Lighthouse (exited with code \d+|timed out after \d+ seconds|reported a runtime error( \([A-Z0-9_]+\))?|could not be started|could not be run|output was too large|output could not be read|was stopped by a signal|returned no category scores)\.$/;

  test("every failure path yields a fixed message even when the child and Lighthouse name local paths", async () => {
    const dir = tempDir();
    const leak = "C:\\Users\\Some Name\\chrome failed";
    const noisy = (script: string): string =>
      touch(join(dir, `${Math.random()}`, "cli", "index.js"), script);
    const errors: string[] = [];
    const record = async (runner: LighthouseRunner): Promise<void> => {
      const section = await runLighthouse(["https://a.test/"], runner);
      for (const page of section.pages) if (page.error !== null) errors.push(page.error);
    };

    await record(
      createProcessRunner(noisy(`console.error(${JSON.stringify(leak)}); process.exit(2);\n`)),
    );
    await record(createProcessRunner(noisy(`console.log(${JSON.stringify(leak)});\n`)));
    await record(createProcessRunner(noisy(`setInterval(() => {}, 1000);\n`), 300));
    await record(createProcessRunner(join(dir, "missing", "cli", "index.js")));
    await record(() => Promise.reject(new Error(leak)));
    await record(okRunner({ runtimeError: { code: "NO_FCP", message: leak } }));
    await record(okRunner({ runtimeError: { code: leak, message: leak } }));
    await record(okRunner({ runtimeError: { message: leak } }));
    await record(okRunner({ categories: {} }));

    expect(errors).toHaveLength(9);
    for (const error of errors) {
      expect(error).toMatch(FIXED);
      expect(error).not.toContain("Some Name");
    }
  });
});
