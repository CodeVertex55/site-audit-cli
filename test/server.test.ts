import { afterEach, expect, test } from "vitest";
import { startSite, type TestSite } from "./server/index.js";
import { page } from "./server/html.js";

let site: TestSite | undefined;
afterEach(async () => {
  await site?.close();
  site = undefined;
});

test("serves routes, logs requests, 404s unknown paths", async () => {
  site = await startSite({ "/": { body: page({ title: "Home" }) }, "/gone": { status: 410 } });
  const res = await fetch(site.url("/"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("<title>Home</title>");
  expect((await fetch(site.url("/gone"))).status).toBe(410);
  expect((await fetch(site.url("/nope"))).status).toBe(404);
  expect(site.log.map((r) => r.path)).toEqual(["/", "/gone", "/nope"]);
  expect(site.hits("/")).toBe(1);
});

test("function routes see the hit count; gzip and delay work", async () => {
  site = await startSite({
    "/flaky": (_req, hit) =>
      hit === 1 ? { status: 503, headers: { "retry-after": "0" } } : { body: "ok" },
    "/z": { body: "x".repeat(5000), gzip: true, headers: { "content-type": "text/css" } },
    "/slow": { body: "late", delayMs: 150 },
  });
  expect((await fetch(site.url("/flaky"))).status).toBe(503);
  expect((await fetch(site.url("/flaky"))).status).toBe(200);
  const raw = await fetch(site.url("/z"), { headers: { "accept-encoding": "gzip" } });
  expect(raw.headers.get("content-encoding")).toBe("gzip");
  expect((await raw.text()).length).toBe(5000);
  const t = Date.now();
  await fetch(site.url("/slow"));
  expect(Date.now() - t).toBeGreaterThanOrEqual(140);
});

test("query strings match exactly first, then fall back to the bare path", async () => {
  site = await startSite({
    "/a?x=1": { body: "with-query" },
    "/a": { body: "bare" },
  });
  expect(await (await fetch(site.url("/a?x=1"))).text()).toBe("with-query");
  expect(await (await fetch(site.url("/a?x=2"))).text()).toBe("bare");
  expect(site.log.map((r) => r.path)).toEqual(["/a?x=1", "/a?x=2"]);
});

test("HEAD requests get headers only, with content-length", async () => {
  site = await startSite({ "/": { body: "hello" } });
  const res = await fetch(site.url("/"), { method: "HEAD" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-length")).toBe("5");
  expect(await res.text()).toBe("");
  expect(site.log[0]?.method).toBe("HEAD");
});

test("non-loopback fetch is blocked in tests", () => {
  expect(() => fetch("https://example.com/")).toThrow(/non-loopback/);
});

test("page() defaults produce a valid document", () => {
  const html = page();
  expect(html).toContain('lang="en"');
  expect(html).toMatch(/<meta name="viewport"/);
  expect(html.match(/<h1[ >]/g)).toHaveLength(1);
  expect(html).toContain("<title>");
  expect(html).toContain('name="description"');
});

test("page() omits elements whose option is null", () => {
  const html = page({
    title: null,
    description: null,
    lang: null,
    canonical: null,
    h1: null,
    viewport: false,
  });
  expect(html).not.toContain("<title>");
  expect(html).not.toContain('name="description"');
  expect(html).not.toContain("lang=");
  expect(html).not.toContain('rel="canonical"');
  expect(html).not.toContain("<h1");
  expect(html).not.toContain("viewport");
});

test("page() includes a canonical link and extra head content when given", () => {
  const html = page({ canonical: "https://site.example/", head: '<meta name="x" content="y">' });
  expect(html).toContain('<link rel="canonical" href="https://site.example/">');
  expect(html).toContain('<meta name="x" content="y">');
});
