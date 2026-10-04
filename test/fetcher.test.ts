import { afterEach, describe, expect, test } from "vitest";
import { Fetcher, type FetcherOptions } from "../src/crawl/fetcher.js";
import { HostGate, type Clock } from "../src/crawl/ratelimit.js";
import { startSite, type SiteDef, type TestSite } from "./server/index.js";
import { page } from "./server/html.js";

let site: TestSite | undefined;

afterEach(async () => {
  await site?.close();
  site = undefined;
});

function fetcher(opts: Partial<FetcherOptions> = {}): Fetcher {
  return new Fetcher({
    userAgent: "test-agent/1.0",
    timeoutMs: 5000,
    gate: new HostGate({ delayMs: 0, concurrency: 2 }),
    ...opts,
  });
}

function sleepLog(): Clock & { slept: number[] } {
  const slept: number[] = [];
  let t = 0;
  return {
    slept,
    now: () => t,
    sleep: (ms) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
  };
}

describe("get: redirects", () => {
  test("follows a redirect chain and records every hop", async () => {
    site = await startSite({
      "/a": { status: 301, headers: { location: "/b" } },
      "/b": { status: 302, headers: { location: "/c" } },
      "/c": { body: page({ title: "C" }) },
    });
    const r = await fetcher().get(site.url("/a"));
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(site.url("/c"));
    expect(r.hops.map((h) => [h.status, h.location])).toEqual([
      [301, site.url("/b")],
      [302, site.url("/c")],
    ]);
    expect(r.hops.map((h) => h.url)).toEqual([site.url("/a"), site.url("/b")]);
    expect(r.body).toContain("<title>C</title>");
    expect(r.responseMs).toBeGreaterThanOrEqual(0);
    expect(r.totalMs).toBeGreaterThanOrEqual(r.responseMs ?? 0);
    expect(r.failure).toBeNull();
  });

  test("a redirect loop fails with redirect-loop and no status", async () => {
    site = await startSite({
      "/x": { status: 302, headers: { location: "/y" } },
      "/y": { status: 302, headers: { location: "/x" } },
    });
    const r = await fetcher().get(site.url("/x"));
    expect(r.failure).toBe("redirect-loop");
    expect(r.status).toBeNull();
    expect(r.body).toBeNull();
  });

  test("11 chained redirects fail with too-many-redirects", async () => {
    const routes: SiteDef = { "/r11": { body: page() } };
    for (let i = 0; i <= 10; i += 1) {
      routes[`/r${i}`] = { status: 302, headers: { location: `/r${i + 1}` } };
    }
    site = await startSite(routes);
    const r = await fetcher().get(site.url("/r0"));
    expect(r.failure).toBe("too-many-redirects");
    expect(r.status).toBeNull();
    expect(r.hops).toHaveLength(10);
  });

  test("exactly 10 redirects are followed", async () => {
    const routes: SiteDef = { "/r10": { body: page() } };
    for (let i = 0; i < 10; i += 1) {
      routes[`/r${i}`] = { status: 302, headers: { location: `/r${i + 1}` } };
    }
    site = await startSite(routes);
    const r = await fetcher().get(site.url("/r0"));
    expect(r.failure).toBeNull();
    expect(r.status).toBe(200);
    expect(r.hops).toHaveLength(10);
  });

  test("an unparseable Location ends the chain with failure other", async () => {
    site = await startSite({
      "/a": { status: 301, headers: { location: "http://[bad" } },
    });
    const r = await fetcher().get(site.url("/a"));
    expect(r.failure).toBe("other");
    expect(r.status).toBeNull();
  });

  test("a 3xx without Location is returned as the final response", async () => {
    site = await startSite({ "/a": { status: 304 } });
    const r = await fetcher().get(site.url("/a"));
    expect(r.status).toBe(304);
    expect(r.failure).toBeNull();
    expect(r.hops).toEqual([]);
  });
});

describe("get: failures", () => {
  test("a slow response gives timeout", async () => {
    site = await startSite({ "/slow": { delayMs: 500, body: "late" } });
    const r = await fetcher({ timeoutMs: 100 }).get(site.url("/slow"));
    expect(r.failure).toBe("timeout");
    expect(r.status).toBeNull();
    expect(r.responseMs).toBeNull();
  });

  test("a closed port gives connection", async () => {
    const closed = await startSite({ "/": { body: "x" } });
    const url = closed.url("/");
    await closed.close();
    const r = await fetcher().get(url);
    expect(r.failure).toBe("connection");
    expect(r.status).toBeNull();
  });

  const cases: [string, string][] = [
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns"],
    ["ECONNRESET", "connection"],
    ["EHOSTUNREACH", "connection"],
    ["CERT_HAS_EXPIRED", "tls"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
    ["ETIMEDOUT", "timeout"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
    ["EPIPE", "other"],
  ];
  test.each(cases)("error code %s maps to %s", async (code, expected) => {
    const failing = (() => {
      const error = new TypeError("fetch failed", {
        cause: Object.assign(new Error("x"), { code }),
      });
      return Promise.reject(error);
    }) as typeof fetch;
    const r = await fetcher({ fetchImpl: failing }).get("http://example.com/");
    expect(r.failure).toBe(expected);
    expect(r.status).toBeNull();
  });

  test("an error code inside an aggregate error is found", async () => {
    const failing = (() => {
      const inner = Object.assign(new Error("x"), { code: "ECONNREFUSED" });
      const error = new TypeError("fetch failed", { cause: new AggregateError([inner], "multi") });
      return Promise.reject(error);
    }) as typeof fetch;
    const r = await fetcher({ fetchImpl: failing }).get("http://example.com/");
    expect(r.failure).toBe("connection");
  });
});

describe("get: body", () => {
  test("caps the body at maxBytes and flags truncation", async () => {
    site = await startSite({
      "/big": {
        body: Buffer.alloc(6 * 1024 * 1024, "a"),
        headers: { "content-type": "text/html" },
      },
    });
    const r = await fetcher().get(site.url("/big"));
    expect(r.status).toBe(200);
    expect(r.bytes).toBe(5 * 1024 * 1024);
    expect(r.truncated).toBe(true);
  });

  test("honours a smaller maxBytes", async () => {
    site = await startSite({
      "/big": {
        body: Buffer.alloc(6 * 1024 * 1024, "a"),
        headers: { "content-type": "text/html" },
      },
    });
    const r = await fetcher({ maxBytes: 1_000_000 }).get(site.url("/big"));
    expect(r.truncated).toBe(true);
    expect(r.bytes).not.toBeNull();
    expect(r.bytes ?? 0).toBeLessThanOrEqual(1_000_000);
    expect(r.body?.length ?? 0).toBeLessThanOrEqual(1_000_000);
  });

  test("a body that fits is not truncated", async () => {
    const body = page();
    site = await startSite({ "/p": { body } });
    const r = await fetcher().get(site.url("/p"));
    expect(r.truncated).toBe(false);
    expect(r.bytes).toBe(Buffer.byteLength(body));
    expect(r.body).toBe(body);
    expect(r.contentType).toBe("text/html; charset=utf-8");
  });

  test("gzip bodies are decoded and transferBytes is the compressed size", async () => {
    const body = page({ body: `<p>${"hello world ".repeat(2000)}</p>` });
    site = await startSite({ "/z": { body, gzip: true } });
    const r = await fetcher().get(site.url("/z"));
    expect(r.body).toBe(body);
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(r.bytes).toBe(Buffer.byteLength(body));
    expect(r.transferBytes).not.toBeNull();
    expect(r.transferBytes ?? Infinity).toBeLessThan(r.bytes ?? 0);
  });

  test("decodes the charset named in Content-Type", async () => {
    const body = Buffer.concat([Buffer.from("<p>caf"), Buffer.from([0xe9]), Buffer.from("</p>")]);
    site = await startSite({
      "/l": { body, headers: { "content-type": "text/html; charset=iso-8859-1" } },
    });
    const r = await fetcher().get(site.url("/l"));
    expect(r.body).toContain("café");
  });

  test("falls back to a meta charset when Content-Type has none", async () => {
    const body = Buffer.concat([
      Buffer.from('<!doctype html><meta charset="iso-8859-1"><p>caf'),
      Buffer.from([0xe9]),
      Buffer.from("</p>"),
    ]);
    site = await startSite({ "/m": { body, headers: { "content-type": "text/html" } } });
    const r = await fetcher().get(site.url("/m"));
    expect(r.body).toContain("café");
  });

  test("reads the charset from an http-equiv meta tag", async () => {
    const body = Buffer.concat([
      Buffer.from(
        '<!doctype html><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><p>caf',
      ),
      Buffer.from([0xe9]),
      Buffer.from("</p>"),
    ]);
    site = await startSite({ "/h": { body, headers: { "content-type": "text/html" } } });
    const r = await fetcher().get(site.url("/h"));
    expect(r.body).toContain("café");
  });

  test("an unknown charset label falls back to utf-8", async () => {
    site = await startSite({
      "/u": { body: "<p>plain</p>", headers: { "content-type": "text/html; charset=no-such-set" } },
    });
    const r = await fetcher().get(site.url("/u"));
    expect(r.body).toBe("<p>plain</p>");
  });

  test("a non-text response has a null body but still counts bytes", async () => {
    site = await startSite({
      "/img": { body: Buffer.alloc(300, 1), headers: { "content-type": "image/png" } },
    });
    const r = await fetcher().get(site.url("/img"));
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
    expect(r.bytes).toBe(300);
    expect(r.contentType).toBe("image/png");
  });

  test("XML and plain text are decoded", async () => {
    site = await startSite({
      "/x": { body: "<urlset/>", headers: { "content-type": "application/xml" } },
      "/t": { body: "User-agent: *", headers: { "content-type": "text/plain" } },
    });
    expect((await fetcher().get(site.url("/x"))).body).toBe("<urlset/>");
    expect((await fetcher().get(site.url("/t"))).body).toBe("User-agent: *");
  });

  test("response headers are lower-cased", async () => {
    site = await startSite({ "/h": { body: "x", headers: { "X-Custom-Header": "Value" } } });
    const r = await fetcher().get(site.url("/h"));
    expect(r.headers["x-custom-header"]).toBe("Value");
  });
});

describe("get: request shape", () => {
  test("cookies are not stored or sent", async () => {
    site = await startSite({
      "/a": { body: page(), headers: { "set-cookie": "session=abc; Path=/" } },
    });
    const f = fetcher();
    await f.get(site.url("/a"));
    await f.get(site.url("/a"));
    expect(site.log).toHaveLength(2);
    expect(site.log[1]?.headers.cookie).toBeUndefined();
    expect(site.log[1]?.headers.authorization).toBeUndefined();
  });

  test("sends the configured user agent and an Accept header", async () => {
    site = await startSite({ "/a": { body: page() } });
    await fetcher({ userAgent: "my-agent/9" }).get(site.url("/a"));
    expect(site.log[0]?.method).toBe("GET");
    expect(site.log[0]?.headers["user-agent"]).toBe("my-agent/9");
    expect(site.log[0]?.headers.accept).toBe("text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
  });

  test("requestCount counts every network request", async () => {
    site = await startSite({
      "/a": { status: 301, headers: { location: "/b" } },
      "/b": { body: page() },
    });
    const f = fetcher();
    expect(f.requestCount).toBe(0);
    await f.get(site.url("/a"));
    expect(f.requestCount).toBe(2);
  });

  test("requests go through the gate and respect the host delay", async () => {
    site = await startSite({ "/a": { body: page() } });
    const f = fetcher({ gate: new HostGate({ delayMs: 200, concurrency: 2 }) });
    await Promise.all([f.get(site.url("/a")), f.get(site.url("/a"))]);
    const [first, second] = site.log;
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(150);
  });
});

describe("get: throttling", () => {
  test("a 503 with retry-after 0 is retried once and then succeeds", async () => {
    site = await startSite({
      "/r": (_req, hit) =>
        hit === 1 ? { status: 503, headers: { "retry-after": "0" } } : { body: page() },
    });
    const throttled: string[] = [];
    const r = await fetcher({ onThrottle: (host) => throttled.push(host) }).get(site.url("/r"));
    expect(r.status).toBe(200);
    expect(site.hits("/r")).toBe(2);
    expect(throttled).toEqual([]);
  });

  test("three 429 responses return 429 after two retries and report throttling once", async () => {
    site = await startSite({ "/limited": { status: 429, body: "slow down" } });
    const clock = sleepLog();
    const gate = new HostGate({ delayMs: 100, concurrency: 2 });
    const throttled: string[] = [];
    const r = await fetcher({ clock, gate, onThrottle: (host) => throttled.push(host) }).get(
      site.url("/limited"),
    );
    expect(r.status).toBe(429);
    expect(r.failure).toBeNull();
    expect(site.hits("/limited")).toBe(3);
    expect(throttled).toHaveLength(1);
    expect(clock.slept).toEqual([5000, 5000]);
    const host = new URL(site.origin).host;
    expect(throttled[0]).toBe(host);
    expect(gate.delayFor(host)).toBe(200);
  });

  test("two exhausted URLs on one host double the delay once and report throttling once", async () => {
    site = await startSite({
      "/one": { status: 429 },
      "/two": { status: 503 },
    });
    const gate = new HostGate({ delayMs: 100, concurrency: 2 });
    const throttled: string[] = [];
    const f = fetcher({
      clock: sleepLog(),
      gate,
      onThrottle: (host) => throttled.push(host),
    });
    expect((await f.get(site.url("/one"))).status).toBe(429);
    expect((await f.get(site.url("/two"))).status).toBe(503);
    const host = new URL(site.origin).host;
    expect(site.hits("/one")).toBe(3);
    expect(site.hits("/two")).toBe(3);
    expect(throttled).toEqual([host]);
    expect(gate.delayFor(host)).toBe(200);
  });

  test("a Retry-After header sets the wait", async () => {
    site = await startSite({
      "/r": (_req, hit) =>
        hit === 1 ? { status: 429, headers: { "retry-after": "7" } } : { body: page() },
    });
    const clock = sleepLog();
    const r = await fetcher({ clock }).get(site.url("/r"));
    expect(r.status).toBe(200);
    expect(clock.slept).toEqual([7000]);
  });

  test("other error statuses are not retried", async () => {
    site = await startSite({ "/e": { status: 500, body: "boom" } });
    const r = await fetcher().get(site.url("/e"));
    expect(r.status).toBe(500);
    expect(site.hits("/e")).toBe(1);
  });
});

describe("probe", () => {
  test("uses only HEAD and reads bytes from Content-Length", async () => {
    const body = "x".repeat(1234);
    site = await startSite({ "/a.js": { body, headers: { "content-type": "text/javascript" } } });
    const r = await fetcher().probe(site.url("/a.js"));
    expect(r.status).toBe(200);
    expect(r.bytes).toBe(1234);
    expect(r.measured).toBe(true);
    expect(r.failure).toBeNull();
    expect(r.finalUrl).toBe(site.url("/a.js"));
    expect(r.headers["content-type"]).toBe("text/javascript");
    expect(site.log.map((l) => l.method)).toEqual(["HEAD"]);
  });

  test("falls back to GET and counts bytes when HEAD answers 405", async () => {
    const body = "y".repeat(777);
    site = await startSite({
      "/b.css": (req) =>
        req.method === "HEAD" ? { status: 405 } : { body, headers: { "content-type": "text/css" } },
    });
    const r = await fetcher().probe(site.url("/b.css"));
    expect(r.status).toBe(200);
    expect(r.bytes).toBe(777);
    expect(r.measured).toBe(true);
    expect(site.log.map((l) => l.method)).toEqual(["HEAD", "GET"]);
  });

  test("falls back to GET when HEAD answers 501", async () => {
    site = await startSite({
      "/c": (req) => (req.method === "HEAD" ? { status: 501 } : { body: "z".repeat(50) }),
    });
    const r = await fetcher().probe(site.url("/c"));
    expect(r.bytes).toBe(50);
    expect(site.log.map((l) => l.method)).toEqual(["HEAD", "GET"]);
  });

  test("falls back to GET when HEAD has no Content-Length", async () => {
    site = await startSite({
      "/d": (req) =>
        req.method === "HEAD"
          ? {}
          : { body: "w".repeat(90), headers: { "content-type": "image/svg+xml" } },
    });
    const r = await fetcher({
      fetchImpl: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === "HEAD") {
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          return new Response(null, { status: response.status, headers });
        }
        return response;
      },
    }).probe(site.url("/d"));
    expect(r.bytes).toBe(90);
    expect(r.measured).toBe(true);
    expect(site.log.map((l) => l.method)).toEqual(["HEAD", "GET"]);
  });

  test("follows redirects and reports the final URL", async () => {
    site = await startSite({
      "/old.png": { status: 301, headers: { location: "/new.png" } },
      "/new.png": { body: "p".repeat(64), headers: { "content-type": "image/png" } },
    });
    const r = await fetcher().probe(site.url("/old.png"));
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(site.url("/new.png"));
    expect(r.bytes).toBe(64);
  });

  test("a missing asset reports its status and no size", async () => {
    site = await startSite({});
    const r = await fetcher().probe(site.url("/gone.png"));
    expect(r.status).toBe(404);
    expect(r.measured).toBe(false);
    expect(r.bytes).toBeNull();
  });

  test("a GET fallback stops counting at maxBytes", async () => {
    site = await startSite({
      "/big": (req) =>
        req.method === "HEAD" ? { status: 405 } : { body: Buffer.alloc(300_000, 1) },
    });
    const r = await fetcher({ maxBytes: 100_000 }).probe(site.url("/big"));
    expect(r.measured).toBe(true);
    expect(r.bytes).toBe(100_000);
  });

  test("a redirect loop is reported as a failure", async () => {
    site = await startSite({
      "/x": { status: 302, headers: { location: "/y" } },
      "/y": { status: 302, headers: { location: "/x" } },
    });
    const r = await fetcher().probe(site.url("/x"));
    expect(r.failure).toBe("redirect-loop");
    expect(r.status).toBeNull();
    expect(r.measured).toBe(false);
  });

  test("a connection failure is reported", async () => {
    const closed = await startSite({});
    const url = closed.url("/a.png");
    await closed.close();
    const r = await fetcher().probe(url);
    expect(r.failure).toBe("connection");
    expect(r.status).toBeNull();
    expect(r.finalUrl).toBe(url);
  });
});

describe("single", () => {
  test("returns the status and Location without following", async () => {
    site = await startSite({
      "/a": { status: 301, headers: { location: "/b" } },
      "/b": { body: page() },
    });
    const r = await fetcher().single(site.url("/a"));
    expect(r).toEqual({ status: 301, location: site.url("/b"), failure: null });
    expect(site.hits("/b")).toBe(0);
  });

  test("supports HEAD", async () => {
    site = await startSite({ "/a": { body: page() } });
    const r = await fetcher().single(site.url("/a"), "HEAD");
    expect(r).toEqual({ status: 200, location: null, failure: null });
    expect(site.log[0]?.method).toBe("HEAD");
  });

  test("reports a failure", async () => {
    const closed = await startSite({});
    const url = closed.url("/");
    await closed.close();
    const r = await fetcher().single(url);
    expect(r).toEqual({ status: null, location: null, failure: "connection" });
  });

  test("does not retry a 429", async () => {
    site = await startSite({ "/a": { status: 429 } });
    const r = await fetcher().single(site.url("/a"));
    expect(r.status).toBe(429);
    expect(site.hits("/a")).toBe(1);
  });
});
