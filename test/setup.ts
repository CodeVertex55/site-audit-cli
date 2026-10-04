const realFetch = globalThis.fetch;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(raw).hostname;
  if (!LOOPBACK.has(host)) throw new Error(`Test tried to reach a non-loopback host: ${host}`);
  return realFetch(input, init);
}) as typeof fetch;
