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

export function startSite(routes: SiteDef, opts: { port?: number } = {}): Promise<TestSite> {
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

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo; // address() is an object once listening on a port
      const origin = `http://127.0.0.1:${port}`;
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
