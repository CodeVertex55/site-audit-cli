# Changelog

## Unreleased

- The repository moved to github.com/CodeVertex55 after a GitHub account rename. The default user agent now links to the new address, and so do the install commands, the CI example and the package metadata. The old address still redirects.

## 1.0.0

First release.

- Polite crawler: reads the audited site's robots.txt first, obeys `Allow`, `Disallow` and `Crawl-delay`, spaces requests per host, sends only GET and HEAD, stores and sends no cookies.
- Back-off on 429 and 503 for pages, robots.txt, sitemaps and the soft 404 probe: it waits for `Retry-After`, retries up to twice, and then doubles that host's delay once. Asset size requests, external link checks and the other probes are not retried.
- Besides the audited origin it contacts the `www` or apex counterpart of the host for the host and plain-HTTP probes. `--check-external` allows external links and third-party assets. Requests to other hosts never leave the site they were sent to, and URLs on the audited host under another scheme or port follow the audited site's robots.txt rules and pace.
- Linked files that are not HTML are fetched up to a cap equal to `--max-pages`. Bodies that are not text are not downloaded. Text-like files (any `text/` type, XML including SVG, and JSON) are read up to the 5 MB cap.
- Notes such as a governing or capped `Crawl-delay` or a moved origin are printed on stderr, and a robots.txt `Crawl-delay` that sets the pace is shown in the scope block of every report.
- 69 checks in four groups: 30 SEO, 17 health, 15 performance and 7 accessibility (static checks only, not an accessibility audit). Each finding names the check, the affected pages and a plain fix.
- No score. Reports list findings with their own severity, a "Fix first" list, and a fixed list of what a static HTTP audit does not see.
- Four report formats: text, JSON, Markdown and one self-contained HTML file with light and dark themes and a print stylesheet.
- Exit codes for pipelines: 0 and 1 from the findings and `--fail-on`, 2 for usage errors and unwritable output files (checked before the crawl starts), 3 when the start URL cannot be audited.
- Optional Lighthouse lab results with `--lighthouse`, run from a Lighthouse install that you provide. They never change findings or the exit code. The crawler's rules (GET and HEAD only, robots.txt, pacing, no cookies) do not apply to the browser that Lighthouse starts.
- Programmatic use: `audit`, `DEFAULT_OPTIONS`, `parseStartUrl`, `CHECKS`, `VERSION`, `UnreachableError`, `UsageError` and the result types.
- Generated check reference in `docs/checks.md`, and example reports in `examples/` made from the bundled fixture site.
