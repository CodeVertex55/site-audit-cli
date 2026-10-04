# How the crawl works

This page describes what the tool requests, in what order, and where it stops. The audited site is treated as untrusted input: every response has a size cap, every request has a timeout, and redirects are limited.

## Order of requests

1. `robots.txt` of the origin you gave. It is read before the start page. A start URL that robots.txt disallows is never requested.
2. The start page.
3. The sitemaps.
4. The pages, breadth first.
5. Size probes for assets.
6. Four extra requests about the site as a whole (see [Probes](#probes)).
7. External links, only with `--check-external`.

### The start page

The start page is fetched with redirects followed by the crawler itself, so every hop is recorded. Each hop is checked before it is sent: it must not match `--exclude` and must not be disallowed by robots.txt.

The audit origin is the origin of the final URL. The start URL may move to another origin once, for example from `example.com` to `www.example.com`. The new origin's robots.txt is read first, the report notes the move, and a later hop to a third origin is not followed.

The run ends with exit code 3 when the start page cannot be audited: the request fails (DNS, connection, timeout, certificate), the redirects loop or exceed 10 hops, the final status is 400 or above, the response is not HTML, robots.txt disallows the start URL, or robots.txt cannot be read.

### Sitemaps

Sitemaps are taken from the `Sitemap` lines in robots.txt. When there are none, `/sitemap.xml` is tried. Limits:

- At most 5 sitemap files are read and at most 5000 URLs are kept.
- A sitemap index is followed one level. A sitemap listed inside an index that is itself an index is not followed.
- Gzip-compressed sitemaps (`.gz`) are skipped and recorded as skipped.
- Only URLs on the audit origin are kept.
- A sitemap on a different site is not read. A redirect from a sitemap URL is followed only within the same site: the same hostname (for example http to https) or its www or apex counterpart. A redirect to any other site is not followed and the sitemap is recorded as not read.

With `--ignore-robots`, robots.txt is still read for its `Sitemap` lines, but its rules are not applied.

### Pages

The crawl is breadth first. The start URL is at depth 0. Links found on a page are queued at the next depth, up to `--max-depth`. After the link queue is empty, sitemap URLs that no link reached are added at depth `sitemap`. A sitemap URL that no crawled page links to may be an orphan, and one of the SEO checks reports it.

- Only `<a href>` links are followed. A link with `rel="nofollow"` is still followed, because that attribute is advice to search engines and not a rule for an audit. `mailto:`, `tel:`, `javascript:` and `data:` links are ignored.
- URLs are normalised before they are compared: the fragment is removed, default ports are removed, the host is lower-cased and dot segments are resolved. The query is kept as it is. Two URLs that normalise to the same string are one page.
- URLs on another origin are not requested. With `--check-external` they are checked as external links, but never crawled.
- URLs whose path matches an `--exclude` pattern are never requested. The pattern must match the whole path. `*` matches any characters except `/`, and `**` matches any characters.
- URLs that robots.txt disallows are never requested. They are counted and listed in the scope block of the report.
- A response whose `Content-Type` is not HTML is recorded as a resource and is not parsed. It does not count against `--max-pages`.
- The crawl stops at `--max-pages` pages. The report says how many discovered URLs were left uncrawled.

### Fetching

- Requests are `GET`, or `HEAD` for some probes. No other method is used.
- The headers sent are `User-Agent` and `Accept`. The runtime decides `Accept-Encoding`. No cookies are stored or sent, and there is no `Authorization` header.
- Redirects are followed by the crawler, up to 10 hops. A URL that repeats in the chain is a loop. A redirect that leaves the audit origin is not followed during the crawl.
- "Response time" is the time from sending the request to receiving the response headers. It is measured once, from the machine that runs the audit.
- HTML bodies are read up to 5 MB. A longer body is cut at 5 MB, parsed as far as it goes, and flagged as truncated.
- Bodies are decoded with the charset from `Content-Type`, then from a `<meta charset>` near the top of the document, then as UTF-8.
- The parser keeps the facts that the checks need and discards the document, so memory use does not grow with the size of the crawl.

### Parsing limits

HTML is parsed with a nesting limit of 256 levels and a cap of 500000 nodes. A page that goes beyond either one is cut at that point and reported as truncated. The facts before the cut are still used. Sloppy markup with very many unclosed tags can reach the nesting limit. A page that needs an unusually large amount of work to read is cut and reported in the same way.

## Rate limiting

All requests to a host go through one gate. The gate spaces the starts of requests to that host by at least the delay, whatever the concurrency. With the defaults that is at most one new request per second, with up to 2 in flight.

- `--delay` sets the gap in milliseconds. A `Crawl-delay` in robots.txt that is larger than `--delay` wins. A `Crawl-delay` above 30 seconds is cut to 30 seconds and the tool says so. `--ignore-robots` ignores `Crawl-delay` too.
- `--concurrency` sets how many requests to one host may be in flight.
- Other hosts, which are contacted only for the sibling host probe, redirects of robots.txt and sitemaps within the same site, and `--check-external` (external links and third-party asset sizes), have their own gate with one request at a time per host and the same delay.

### 429 and 503

When a page, robots.txt or a sitemap answers 429 or 503, the tool waits and tries again, up to 2 more times. The wait is the `Retry-After` header (seconds or an HTTP date), at most 60 seconds, and 5 seconds when the header is missing or cannot be read. When the retries are used up, the answer is recorded as it is. At that point the delay for that host is doubled, once, for the rest of the run, and the report notes it in the scope block. A delay of 0 becomes 1000 milliseconds.

Asset size requests, external link checks and the http variant, sibling host and favicon probes are not retried. When one of them is answered with 429 or 503 the result is left as not measured or unknown. The soft 404 probe is an ordinary page fetch, so it follows the retry rule above.

## robots.txt rules

- The group for the tool is the one whose user-agent name is the longest match for the token `site-audit-cli`. When no group matches, the `*` group is used. Several groups that name the same agent are combined.
- `Allow` and `Disallow` rules support `*` and a trailing `$`. The longest matching rule wins, and `Allow` wins a tie. The path and query of the URL are matched.
- A robots.txt that answers with a 4xx status is treated as no robots.txt, so everything is allowed.
- A robots.txt that answers with a 5xx status, or that cannot be fetched, makes the site count as disallowed. The run ends with exit code 3 unless `--ignore-robots` is used.
- A robots.txt that redirects to a different site is not followed. It is treated as unreadable, which means exit code 3 unless `--ignore-robots` is used.
- A robots.txt redirect within the same site, such as http to https or www to apex, is followed.
- robots.txt is read up to 512 KB of text.

## Assets

The crawled pages name images, scripts and stylesheets. Each unique URL is measured once across the whole run, in the order first seen, up to `--max-assets`.

- The first request is `HEAD`. When the answer has no `Content-Length`, or the server rejects `HEAD` with 405 or 501, the tool uses `GET` and counts the bytes up to 5 MB, then stops reading.
- An answer with status 400 or above gives no size.
- Same-origin assets obey robots.txt and `--exclude`. Blocked assets are not requested.
- Third-party assets are measured only with `--check-external`. Otherwise they are counted as not measured, and the report shows the count.
- Fonts and files that a stylesheet loads are not found, because stylesheets are not parsed.

The size, content type, content encoding and cache headers of each asset feed the performance checks.

## Probes

Four extra requests describe the site as a whole. Each is made once, apart from the retries described above.

- **http variant.** When the audit origin is `https`, a `GET` to `http://<host>/` without following redirects. It records whether the answer is a redirect to an `https` URL. The response body is not read.
- **Sibling host.** A `GET` to the `www` or apex counterpart of the host, for example `www.example.com` when the audit host is `example.com`, without following redirects. It records whether the sibling redirects to the audit host (good), answers 200 itself (two hosts serve the site), or something else. This is the one request that goes to a different host by default. It is skipped for IP addresses, `localhost`, single-label hosts and subdomains other than `www`, such as `shop.example.com`.
- **Soft 404.** A `GET` to a path that cannot exist, made of `/site-audit-cli-probe-` and 16 random hexadecimal characters. A 200 answer means the site returns normal pages for missing URLs.
- **Favicon.** Skipped when a crawled page has an icon link. Otherwise, when robots.txt allows it, a `HEAD` (or `GET` if `HEAD` is refused) to `/favicon.ico`. A 200 answer means there is a favicon.

A probe that fails, or is answered with 429 or 503, is recorded as unknown, and the checks that depend on it do not report on it.

## External links

Only with `--check-external`. Each unique external URL gets one request, `HEAD` first and then `GET` when the server answers 405 or 501. Redirects are not followed, and the answer is recorded as it came. Each host has one request at a time and the same delay as the audit host. A failure to reach an external URL is a finding. A status that often means "automated requests refused", such as 403, is reported as could not verify, with info severity.

## What stays on your machine

The tool writes nothing except the report. It makes no requests to anything but the hosts named above. With `--lighthouse` the browser that Lighthouse starts will contact whatever the page loads, which is outside the rules on this page.
