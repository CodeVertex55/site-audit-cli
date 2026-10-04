import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

export type RouteDef = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  delayMs?: number;
  gzip?: boolean;
};

export type LoggedRequest = {
  method: string;
  path: string;
  at: number;
  headers: Record<string, string | string[] | undefined>;
};

export type SiteDef = Record<string, RouteDef | ((req: LoggedRequest, hit: number) => RouteDef)>;

export type TestSite = {
  origin: string;
  url(path: string): string;
  log: LoggedRequest[];
  hits(path: string): number;
  close(): Promise<void>;
};

const NOT_FOUND_BODY = "<!doctype html><title>Not found</title><p>Not found</p>";

/**
 * The fixture listens on ::ffff:127.0.0.1, the IPv4-mapped IPv6 form of 127.0.0.1, so tests
 * still talk only to this machine.
 *
 * Why not 127.0.0.1: with Node 24.15 on Windows 11 build 26200, a process that makes many TCP
 * connections now and then dies with exit code 0xC0000409. A debugger showed a failed stack
 * cookie check in libuv's TCP connect routine: something overwrites that routine's stack frame
 * while it runs. Which part of libuv or Windows does the writing is not known. When the target
 * address counts as loopback for libuv (127.0.0.0/8 or ::1), the routine also makes an extra
 * synchronous socket call (SIO_TCP_INITIAL_RTT), and that case crashed far more often. libuv
 * does not count the mapped address as loopback, so it skips that call. With the same traffic,
 * 127.0.0.1 crashed 11 runs in 16 and the mapped address 0 in 16. The crawler tests went from
 * 4 crashes in 30 runs to 0 in 50, but a full parallel test run still crashed now and then
 * afterwards, so this lowers the risk without removing it.
 */
const DEFAULT_HOST = "::ffff:127.0.0.1";

/**
 * For tests that close a site and then expect its port to refuse connections. That same libuv
 * step is what makes Windows refuse a closed loopback port at once. On the mapped address the
 * refusal takes about two seconds, longer than these tests allow, so they use 127.0.0.1.
 */
export const CLOSED_PORT_HOST = "127.0.0.1";

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function send(req: IncomingMessage, res: ServerResponse, route: RouteDef): void {
  const headers: Record<string, string> = { ...route.headers };
  if (!hasHeader(headers, "content-type")) headers["content-type"] = "text/html; charset=utf-8";
  let body: Buffer = Buffer.from(route.body ?? "");
  if (route.gzip) {
    body = gzipSync(body);
    headers["content-encoding"] = "gzip";
  }
  headers["content-length"] = String(body.length);
  res.writeHead(route.status ?? 200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

export function startSite(
  routes: SiteDef,
  opts: { port?: number; host?: string } = {},
): Promise<TestSite> {
  const log: LoggedRequest[] = [];
  const routeHits = new Map<string, number>();

  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    const entry: LoggedRequest = {
      method: req.method ?? "GET",
      path,
      at: Date.now(),
      headers: { ...req.headers },
    };
    log.push(entry);

    const bare = path.split("?")[0] ?? path;
    const key = Object.hasOwn(routes, path) ? path : Object.hasOwn(routes, bare) ? bare : null;
    const def = key === null ? undefined : routes[key];
    if (key === null || def === undefined) {
      send(req, res, { status: 404, body: NOT_FOUND_BODY });
      return;
    }

    const hit = (routeHits.get(key) ?? 0) + 1;
    routeHits.set(key, hit);
    const route = typeof def === "function" ? def(entry, hit) : def;
    if (route.delayMs && route.delayMs > 0) {
      setTimeout(() => send(req, res, route), route.delayMs);
    } else {
      send(req, res, route);
    }
  });

  const host = opts.host ?? DEFAULT_HOST;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const { port } = server.address() as AddressInfo; // address() is an object once listening on a port
      // The URL parser gives the form the crawler reports, such as http://[::ffff:7f00:1]:port.
      const origin = new URL(`http://${host.includes(":") ? `[${host}]` : host}:${port}`).origin;
      resolve({
        origin,
        url: (path) => origin + path,
        log,
        hits: (path) => log.filter((r) => r.path === path).length,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
