# Changelog

## 1.0.0

First release.

- Polite crawler: reads the audited site's robots.txt first, obeys `Allow`, `Disallow` and `Crawl-delay`, spaces requests per host, backs off on 429 and 503, sends only GET and HEAD, stores and sends no cookies.
- Besides the audited origin it contacts the `www` or apex counterpart of the host for the host and plain-HTTP probes. `--check-external` allows external links and third-party assets. Requests to other hosts never follow a redirect to a different host.
- Linked files that are not HTML are fetched up to a cap equal to `--max-pages`, without downloading their bodies.
- Notes such as a capped `Crawl-delay` or a moved origin are printed on stderr, and the applied `Crawl-delay` is shown in the scope block of every report.
- 69 checks in four groups: 30 SEO, 17 health, 15 performance and 7 accessibility (static checks only, not an accessibility audit). Each finding names the check, the affected pages and a plain fix.
- No score. Reports list findings with their own severity, a "Fix first" list, and a fixed list of what a static HTTP audit does not see.
- Four report formats: text, JSON, Markdown and one self-contained HTML file with light and dark themes and a print stylesheet.
- Exit codes for pipelines: 0 and 1 from the findings and `--fail-on`, 2 for usage errors and unwritable output files (checked before the crawl starts), 3 when the start URL cannot be audited.
- Optional Lighthouse lab results with `--lighthouse`, run from a Lighthouse install that you provide. They never change findings or the exit code.
- Programmatic use: `audit`, `DEFAULT_OPTIONS`, `parseStartUrl`, `CHECKS`, `VERSION`, `UnreachableError`, `UsageError` and the result types.
- Generated check reference in `docs/checks.md`, and example reports in `examples/` made from the bundled fixture site.
