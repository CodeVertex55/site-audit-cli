import { describe, expect, test } from "vitest";
import { runChecks } from "../src/checks/registry.js";
import type { AssetRecord, ParsedDocument, PageRecord, SiteContext } from "../src/types.js";
import { makeAsset, makeContext, makePage } from "./helpers/context.js";

const SITE = "https://site.example";

function ids(ctx: SiteContext): string[] {
  return runChecks(ctx, ["performance"])
    .filter((c) => c.status === "fail")
    .map((c) => c.id);
}

function only(id: string, ctx: SiteContext) {
  const outcome = runChecks(ctx, ["performance"]).find((c) => c.id === id);
  if (outcome === undefined) throw new Error(`no check ${id} in the registry`);
  return outcome;
}

function image(url: string, over: Partial<AssetRecord> = {}): AssetRecord {
  return makeAsset({
    url,
    kind: "image",
    bytes: 50_000,
    contentType: "image/webp",
    contentEncoding: null,
    ...over,
  });
}

type Img = ParsedDocument["images"][number];

function img(index: number, over: Partial<Img> = {}): Img {
  return {
    src: `/i${index}.webp`,
    url: `${SITE}/i${index}.webp`,
    hasAlt: true,
    alt: "x",
    width: true,
    height: true,
    loading: "lazy",
    index,
    decorative: false,
    ...over,
  };
}

type Script = ParsedDocument["scripts"][number];

function script(over: Partial<Script> = {}): Script {
  return {
    url: `${SITE}/a.js`,
    inHead: true,
    async: false,
    defer: false,
    module: false,
    inline: false,
    ...over,
  };
}

function ctxWith(
  assets: AssetRecord[],
  pageOver: Parameters<typeof makePage>[0] = {},
): { ctx: SiteContext; page: PageRecord } {
  const page = makePage(pageOver);
  return { ctx: makeContext({ pages: [page], assets }), page };
}

describe("response and size checks", () => {
  test("PERF-RESP-001 passes at 800 ms and fails at 801", () => {
    const at800 = makeContext({ pages: [makePage({ responseMs: 800 })] });
    expect(ids(at800)).not.toContain("PERF-RESP-001");
    const at801 = makeContext({ pages: [makePage({ responseMs: 801 })] });
    const out = only("PERF-RESP-001", at801);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toBe(
      "Response took 801 ms (single measurement from this machine).",
    );
    expect(out.findings[0]?.url).toBe(`${SITE}/`);
  });

  test("PERF-RESP-001 ignores a page with no measurement", () => {
    expect(
      only("PERF-RESP-001", makeContext({ pages: [makePage({ responseMs: null })] })).status,
    ).toBe("pass");
  });

  test("PERF-HTML-010 passes at 500000 bytes and fails above", () => {
    expect(
      only("PERF-HTML-010", makeContext({ pages: [makePage({ bytes: 500_000 })] })).status,
    ).toBe("pass");
    const out = only("PERF-HTML-010", makeContext({ pages: [makePage({ bytes: 500_001 })] }));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toContain("500001");
  });

  test("PERF-COMP-020 fires on uncompressed HTML over 1 KB only", () => {
    const plain = { "content-type": "text/html" };
    const big = makeContext({ pages: [makePage({ headers: plain, bytes: 1025 })] });
    expect(only("PERF-COMP-020", big).findings).toHaveLength(1);
    const small = makeContext({ pages: [makePage({ headers: plain, bytes: 1024 })] });
    expect(only("PERF-COMP-020", small).status).toBe("pass");
    for (const encoding of ["gzip", "br", "deflate", "zstd", "GZIP", "br, gzip"]) {
      const headers = { ...plain, "content-encoding": encoding };
      const ctx = makeContext({ pages: [makePage({ headers, bytes: 50_000 })] });
      expect(only("PERF-COMP-020", ctx).status, encoding).toBe("pass");
    }
    const identity = { ...plain, "content-encoding": "identity" };
    const ctx = makeContext({ pages: [makePage({ headers: identity, bytes: 50_000 })] });
    expect(only("PERF-COMP-020", ctx).findings).toHaveLength(1);
  });

  test("PERF-COMP-021 fires on uncompressed scripts and stylesheets over 1 KB", () => {
    const js = makeAsset({
      url: `${SITE}/a.js`,
      kind: "script",
      bytes: 5000,
      contentEncoding: null,
    });
    const css = makeAsset({ bytes: 1025, contentEncoding: null });
    const tiny = makeAsset({ url: `${SITE}/t.css`, bytes: 1024, contentEncoding: null });
    const font = makeAsset({
      url: `${SITE}/f.woff2`,
      kind: "font",
      bytes: 50_000,
      contentEncoding: null,
    });
    const packed = makeAsset({ url: `${SITE}/p.js`, kind: "script", bytes: 50_000 });
    const { ctx } = ctxWith([js, css, tiny, font, packed]);
    const out = only("PERF-COMP-021", ctx);
    expect(out.findings.map((f) => f.url)).toEqual([js.url, css.url]);
    expect(out.findings[0]?.evidence).toEqual([`${SITE}/`]);
  });

  test("PERF-COMP-021 ignores unmeasured assets", () => {
    const skipped = makeAsset({ bytes: null, contentEncoding: null, measured: false });
    const { ctx } = ctxWith([skipped, makeAsset({ url: `${SITE}/b.css` })]);
    expect(only("PERF-COMP-021", ctx).status).toBe("pass");
  });
});

describe("cache checks", () => {
  function cacheFindings(cacheControl: string | null, over: Partial<AssetRecord> = {}) {
    const { ctx } = ctxWith([makeAsset({ cacheControl, ...over })]);
    return only("PERF-CACHE-030", ctx).findings;
  }

  test("PERF-CACHE-030 passes at max-age=3600 and fails at max-age=600", () => {
    expect(cacheFindings("public, max-age=3600")).toEqual([]);
    const f = cacheFindings("public, max-age=600");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ url: `${SITE}/app.css`, evidence: [`${SITE}/`] });
    expect(f[0]?.detail).toContain("600");
    expect(cacheFindings("max-age=3599")).toHaveLength(1);
  });

  test("PERF-CACHE-030 fails on no header, on no-store, and on no lifetime", () => {
    expect(cacheFindings(null)).toHaveLength(1);
    expect(cacheFindings("no-store")).toHaveLength(1);
    expect(cacheFindings("no-store, max-age=31536000")).toHaveLength(1);
    expect(cacheFindings("public")).toHaveLength(1);
    expect(cacheFindings("no-cache")).toHaveLength(1);
  });

  test("PERF-CACHE-030 passes on immutable, on an Expires header and on a long max-age", () => {
    expect(cacheFindings("public, immutable")).toEqual([]);
    expect(cacheFindings("expires")).toEqual([]);
    expect(cacheFindings("MAX-AGE=86400")).toEqual([]);
    expect(cacheFindings("public, max-age=31536000, immutable")).toEqual([]);
  });

  test("PERF-CACHE-030 skips third-party and unmeasured assets", () => {
    expect(cacheFindings(null, { thirdParty: true, url: "https://cdn.example/a.js" })).toEqual([]);
    expect(cacheFindings(null, { measured: false, bytes: null })).toEqual([]);
  });

  test("asset checks are not applicable when no asset was measured", () => {
    const unmeasured = makeAsset({ measured: false, bytes: null });
    const ctx = makeContext({ assets: [unmeasured] });
    for (const id of [
      "PERF-COMP-021",
      "PERF-CACHE-030",
      "PERF-IMG-050",
      "PERF-IMG-051",
      "PERF-IMG-054",
    ]) {
      expect(only(id, ctx).status, id).toBe("not-applicable");
      expect(only(id, makeContext()).status, id).toBe("not-applicable");
    }
    expect(only("PERF-CACHE-030", makeContext({ assets: [makeAsset()] })).status).toBe("pass");
  });
});

describe("page weight and request count", () => {
  test("PERF-WEIGHT-041 supersedes 040", () => {
    const p = makePage({ bytes: 100_000 });
    const big = makeAsset({
      url: "https://site.example/hero.png",
      kind: "image",
      bytes: 6_000_000,
      usedBy: [p.url],
    });
    const got = ids(makeContext({ pages: [p], assets: [big] }));
    expect(got).toContain("PERF-WEIGHT-041");
    expect(got).not.toContain("PERF-WEIGHT-040");
  });

  test("PERF-WEIGHT-040 covers over 2 MB up to 5 MB and states weight and unmeasured count", () => {
    const p = makePage({ transferBytes: null, bytes: 100_000 });
    const hero = image(`${SITE}/hero.png`, { bytes: 2_000_000, usedBy: [p.url] });
    const skipped = image(`${SITE}/skip.png`, {
      bytes: null,
      measured: false,
      status: 503,
      usedBy: [p.url],
    });
    const other = image(`${SITE}/other.png`, { bytes: 4_000_000, usedBy: [`${SITE}/elsewhere`] });
    const out = only(
      "PERF-WEIGHT-040",
      makeContext({ pages: [p], assets: [hero, skipped, other] }),
    );
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.url).toBe(p.url);
    expect(out.findings[0]?.detail).toContain("2.1 MB");
    expect(out.findings[0]?.detail).toContain("1 asset not measured");
    expect(ids(makeContext({ pages: [p], assets: [hero, skipped, other] }))).not.toContain(
      "PERF-WEIGHT-041",
    );
  });

  test("PERF-WEIGHT-040 boundaries: exactly 2 MB passes, exactly 5 MB is not 041", () => {
    const p = makePage({ transferBytes: null, bytes: 1_000_000 });
    const exact2 = image(`${SITE}/a.png`, { bytes: 1_000_000, usedBy: [p.url] });
    expect(ids(makeContext({ pages: [p], assets: [exact2] }))).not.toContain("PERF-WEIGHT-040");
    const exact5 = image(`${SITE}/b.png`, { bytes: 4_000_000, usedBy: [p.url] });
    const got = ids(makeContext({ pages: [p], assets: [exact5] }));
    expect(got).toContain("PERF-WEIGHT-040");
    expect(got).not.toContain("PERF-WEIGHT-041");
  });

  test("page weight uses transferBytes when present", () => {
    const p = makePage({ transferBytes: 1_000, bytes: 3_000_000 });
    expect(only("PERF-WEIGHT-040", makeContext({ pages: [p] })).status).toBe("pass");
    const q = makePage({ transferBytes: null, bytes: 3_000_000 });
    expect(only("PERF-WEIGHT-040", makeContext({ pages: [q] })).findings).toHaveLength(1);
  });

  test("page weight states zero unmeasured assets in the plural form", () => {
    const p = makePage({ transferBytes: null, bytes: 3_000_000 });
    const detail = only("PERF-WEIGHT-040", makeContext({ pages: [p] })).findings[0]?.detail;
    expect(detail).toContain("3.0 MB");
    expect(detail).toContain("0 assets not measured");
  });

  test("PERF-REQ-042 counts unique scripts, stylesheets and images, over 80", () => {
    const images = Array.from({ length: 78 }, (_, i) => img(i));
    const sheets = [
      { url: `${SITE}/a.css`, inHead: false, media: null },
      { url: `${SITE}/b.css`, inHead: false, media: null },
    ];
    const at80 = makePage({
      doc: {
        images: images.slice(0, 77),
        stylesheets: sheets,
        scripts: [script({ inHead: false })],
      },
    });
    expect(only("PERF-REQ-042", makeContext({ pages: [at80] })).status).toBe("pass");
    const at81 = makePage({
      doc: {
        images,
        stylesheets: sheets,
        scripts: [script({ inHead: false }), script({ url: `${SITE}/b.js`, inHead: false })],
      },
    });
    const out = only("PERF-REQ-042", makeContext({ pages: [at81] }));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toContain("82");
  });

  test("PERF-REQ-042 does not count duplicates, inline scripts or images without a URL", () => {
    const images = Array.from({ length: 100 }, () => img(0));
    const inline = Array.from({ length: 10 }, () => script({ url: null, inline: true }));
    const noUrl = Array.from({ length: 10 }, (_, i) => img(i, { url: null, src: null }));
    const page = makePage({ doc: { images: [...images, ...noUrl], scripts: inline } });
    expect(only("PERF-REQ-042", makeContext({ pages: [page] })).status).toBe("pass");
  });
});

describe("image checks", () => {
  function imageFindings(id: string, asset: AssetRecord) {
    return only(id, makeContext({ assets: [asset] })).findings;
  }

  test("PERF-IMG-050 passes at 300000 bytes and fails at 300001", () => {
    expect(imageFindings("PERF-IMG-050", image(`${SITE}/a.webp`, { bytes: 300_000 }))).toEqual([]);
    const f = imageFindings("PERF-IMG-050", image(`${SITE}/a.webp`, { bytes: 300_001 }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ url: `${SITE}/a.webp`, evidence: [`${SITE}/`] });
  });

  test("PERF-IMG-051 fires over 1 MB and 050 does not", () => {
    const at1m = image(`${SITE}/a.webp`, { bytes: 1_000_000 });
    expect(imageFindings("PERF-IMG-051", at1m)).toEqual([]);
    expect(imageFindings("PERF-IMG-050", at1m)).toHaveLength(1);
    const over = image(`${SITE}/b.webp`, { bytes: 1_000_001 });
    expect(imageFindings("PERF-IMG-051", over)).toHaveLength(1);
    expect(imageFindings("PERF-IMG-050", over)).toEqual([]);
  });

  test("PERF-IMG-050 and 051 ignore non-images and unmeasured images", () => {
    const script = makeAsset({ kind: "script", bytes: 2_000_000 });
    const skipped = image(`${SITE}/s.webp`, { bytes: null, measured: false });
    const ctx = makeContext({ assets: [script, skipped, makeAsset({ url: `${SITE}/z.css` })] });
    expect(only("PERF-IMG-050", ctx).findings).toEqual([]);
    expect(only("PERF-IMG-051", ctx).findings).toEqual([]);
  });

  test("PERF-IMG-054 fires on JPEG and PNG over 100 KB, not on WebP or small files", () => {
    const jpeg = image(`${SITE}/a.jpg`, { bytes: 100_001, contentType: "image/jpeg" });
    const png = image(`${SITE}/b.png`, {
      bytes: 200_000,
      contentType: "IMAGE/PNG; charset=binary",
    });
    const webp = image(`${SITE}/c.webp`, { bytes: 200_000, contentType: "image/webp" });
    const small = image(`${SITE}/d.jpg`, { bytes: 100_000, contentType: "image/jpeg" });
    const none = image(`${SITE}/e.jpg`, { bytes: 200_000, contentType: null });
    const out = only("PERF-IMG-054", makeContext({ assets: [jpeg, png, webp, small, none] }));
    expect(out.findings.map((f) => f.url)).toEqual([jpeg.url, png.url]);
  });

  test("PERF-IMG-052 fires once per page with a count and up to five URLs", () => {
    const images = Array.from({ length: 7 }, (_, i) => img(i, { width: false }));
    images.push(img(7, { height: false }), img(8));
    const page = makePage({ doc: { images } });
    const out = only("PERF-IMG-052", makeContext({ pages: [page] }));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toContain("8 images");
    expect(out.findings[0]?.evidence).toHaveLength(5);
    expect(out.findings[0]?.evidence?.[0]).toBe(`${SITE}/i0.webp`);
  });

  test("PERF-IMG-052 counts decorative images, skips images without a URL, passes sized images", () => {
    const decorative = img(0, { width: false, decorative: true });
    const noUrl = img(1, { width: false, url: null, src: null });
    const page = makePage({ doc: { images: [decorative, noUrl] } });
    expect(only("PERF-IMG-052", makeContext({ pages: [page] })).findings).toHaveLength(1);
    const noUrlOnly = makePage({ doc: { images: [noUrl] } });
    expect(only("PERF-IMG-052", makeContext({ pages: [noUrlOnly] })).status).toBe("pass");
    const sized = makePage({ doc: { images: [img(0), img(1)] } });
    expect(only("PERF-IMG-052", makeContext({ pages: [sized] })).status).toBe("pass");
  });

  test("PERF-IMG-053 fires on images from the fourth on without lazy loading", () => {
    const images = [
      img(0, { loading: null }),
      img(1, { loading: null }),
      img(2, { loading: null }),
      img(3, { loading: null }),
      img(4, { loading: "eager" }),
      img(5),
    ];
    const out = only("PERF-IMG-053", makeContext({ pages: [makePage({ doc: { images } })] }));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toContain("2 images");
    const lazy = [img(0, { loading: null }), img(1, { loading: null }), img(2, { loading: null })];
    expect(
      only(
        "PERF-IMG-053",
        makeContext({ pages: [makePage({ doc: { images: [...lazy, img(3)] } })] }),
      ).status,
    ).toBe("pass");
  });
});

describe("render blocking checks", () => {
  test("PERF-BLOCK-060 fires on blocking head scripts only", () => {
    const scripts = [
      script({ url: `${SITE}/a.js` }),
      script({ url: `${SITE}/b.js` }),
      script({ url: `${SITE}/c.js`, async: true }),
      script({ url: `${SITE}/d.js`, defer: true }),
      script({ url: `${SITE}/e.js`, module: true }),
      script({ url: null, inline: true }),
      script({ url: `${SITE}/f.js`, inHead: false }),
    ];
    const out = only("PERF-BLOCK-060", makeContext({ pages: [makePage({ doc: { scripts } })] }));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toContain("2 ");
    expect(out.findings[0]?.evidence).toEqual([`${SITE}/a.js`, `${SITE}/b.js`]);
  });

  test("PERF-BLOCK-060 passes when every script is async, deferred, module, inline or in the body", () => {
    const scripts = [
      script({ async: true }),
      script({ defer: true }),
      script({ module: true }),
      script({ url: null, inline: true }),
      script({ inHead: false }),
    ];
    expect(
      only("PERF-BLOCK-060", makeContext({ pages: [makePage({ doc: { scripts } })] })).status,
    ).toBe("pass");
  });

  test("PERF-BLOCK-061 fires over four head stylesheets and not at four", () => {
    const sheet = (n: number, inHead = true) => ({ url: `${SITE}/${n}.css`, inHead, media: null });
    const five = [1, 2, 3, 4, 5].map((n) => sheet(n));
    const out = only(
      "PERF-BLOCK-061",
      makeContext({ pages: [makePage({ doc: { stylesheets: five } })] }),
    );
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toContain("5");
    const four = [1, 2, 3, 4].map((n) => sheet(n));
    expect(
      only("PERF-BLOCK-061", makeContext({ pages: [makePage({ doc: { stylesheets: four } })] }))
        .status,
    ).toBe("pass");
    const bodySheets = [1, 2, 3, 4, 5, 6].map((n) => sheet(n, false));
    expect(
      only(
        "PERF-BLOCK-061",
        makeContext({ pages: [makePage({ doc: { stylesheets: bodySheets } })] }),
      ).status,
    ).toBe("pass");
  });
});

describe("performance checks on a clean context", () => {
  test("a clean page with a clean asset has no performance findings", () => {
    const { ctx } = ctxWith([makeAsset()]);
    expect(ids(ctx)).toEqual([]);
  });

  test("page checks never report pages blocked by robots or redirect records", () => {
    const blocked = makePage({
      url: `${SITE}/private`,
      finalUrl: `${SITE}/private`,
      status: null,
      failure: "blocked-by-robots",
      doc: null,
      isHtml: false,
      responseMs: null,
      bytes: null,
    });
    const redirect = makePage({
      url: `${SITE}/old`,
      finalUrl: `${SITE}/`,
      status: 301,
      hops: [{ url: `${SITE}/old`, status: 301, location: `${SITE}/` }],
      doc: null,
      responseMs: 5000,
      bytes: 9_000_000,
      headers: {},
    });
    expect(ids(makeContext({ pages: [makePage(), blocked, redirect] }))).toEqual([]);
  });
});
