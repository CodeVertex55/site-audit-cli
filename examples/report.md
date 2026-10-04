# Site audit: http://127.0.0.1:4173

## Scope

- **Tool:** site-audit-cli 1.0.0
- **Start URL:** http://127.0.0.1:4173/
- **Audited origin:** http://127.0.0.1:4173
- **Date:** 2026-10-04T09:00:00.000Z
- **Duration:** 12.0 seconds
- **Pages crawled:** 12 (limit 50)
- **Depth limit:** 3
- **Left uncrawled:** 0
- **Skipped by robots.txt:** 0
- **Ignore robots.txt:** no
- **External links checked:** no
- **Assets not measured:** 0
- **Check groups:** seo, health, performance, accessibility
- **What this audit does not see:** Content rendered by JavaScript. Pages behind a login. Real-user performance. Anything beyond the page limit.

## Summary

| Group | Errors | Warnings | Info |
| --- | ---: | ---: | ---: |
| SEO | 2 | 14 | 20 |
| Health | 2 | 4 | 4 |
| Performance | 1 | 6 | 1 |
| Accessibility | 0 | 2 | 2 |
| **Total** | 5 | 26 | 27 |

## Fix first

Ordered by severity, then by number of affected pages. Info findings are not counted, and checks whose findings are all info are left out.

1. **HTTP is not upgraded to HTTPS** (`HEALTH-HTTPS-020`, error, affected: 1): Install a certificate, serve the site over HTTPS, and redirect every HTTP address to its HTTPS version.
2. **Broken internal link** (`HEALTH-LINK-001`, error, affected: 1): Fix the link to point at a working page, or restore the missing page and redirect it if it moved.
3. **HTML is served without compression** (`PERF-COMP-020`, error, affected: 1): Turn on gzip or Brotli compression for HTML responses in the web server or CDN.
4. **A noindex page is listed in the sitemap** (`SEO-INDEX-041`, error, affected: 1): Remove the page from the sitemap, or remove the noindex directive.
5. **Page has no title** (`SEO-TITLE-001`, error, affected: 1): Add a unique \<title\> that describes the page in about 50 to 60 characters.

## SEO

### Page has no title

- **Check:** `SEO-TITLE-001`
- **Severity:** error
- **Why:** The title is the main heading shown in search results and browser tabs. Without one, search engines pick their own text.
- **Fix:** Add a unique \<title\> that describes the page in about 50 to 60 characters.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/untitled | No \<title\> element, or it is empty. |

### Title is shared with other pages

- **Check:** `SEO-TITLE-003`
- **Severity:** warning
- **Why:** Pages with the same title are hard to tell apart in search results and in browser tabs.
- **Fix:** Give each page its own title that describes what is unique about it.

Findings (2):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/dup-a | Title is shared with 1 other indexable page. Evidence: http://127.0.0.1:4173/dup-b |
| http://127.0.0.1:4173/dup-b | Title is shared with 1 other indexable page. Evidence: http://127.0.0.1:4173/dup-a |

### Meta description is very short or very long

- **Check:** `SEO-DESC-011`
- **Severity:** info
- **Why:** A very short description gives searchers little reason to click. Search results cut long descriptions off.
- **Fix:** Write a description between 50 and 160 characters that says what the page offers.
- **Heuristic:** Fails below 50 or above 160 characters. Snippet length varies by device and query, so 160 characters is a rule of thumb.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/untitled | Meta description is 40 characters long. A typical range is 50 to 160. |

### Meta description is shared with other pages

- **Check:** `SEO-DESC-012`
- **Severity:** warning
- **Why:** Identical descriptions make different pages look the same in search results.
- **Fix:** Write a description for each page that reflects its own content.

Findings (2):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/dup-a | Meta description is shared with 1 other indexable page. Evidence: http://127.0.0.1:4173/dup-b |
| http://127.0.0.1:4173/dup-b | Meta description is shared with 1 other indexable page. Evidence: http://127.0.0.1:4173/dup-a |

### Page has more than one h1 heading

- **Check:** `SEO-H1-021`
- **Severity:** info
- **Why:** HTML allows more than one h1, but a single one keeps the page outline clear for readers and search engines.
- **Fix:** Use one \<h1\> for the page topic and \<h2\> or lower for sections.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/two-h1 | The page has 2 \<h1\> headings. |

### Page has no canonical link

- **Check:** `SEO-CANON-030`
- **Severity:** warning
- **Why:** A canonical link tells search engines which URL to index when the same content is reachable at several addresses.
- **Fix:** Add \<link rel="canonical"\> pointing at the preferred URL of the page, usually the page itself.

Findings (8):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/ | No canonical link found. |
| http://127.0.0.1:4173/about | No canonical link found. |
| http://127.0.0.1:4173/untitled | No canonical link found. |
| http://127.0.0.1:4173/dup-a | No canonical link found. |
| http://127.0.0.1:4173/dup-b | No canonical link found. |
| http://127.0.0.1:4173/two-h1 | No canonical link found. |
| http://127.0.0.1:4173/form | No canonical link found. |
| http://127.0.0.1:4173/media | No canonical link found. |

### Page is set to noindex

- **Check:** `SEO-INDEX-040`
- **Severity:** info
- **Why:** Search engines will not list a noindex page. This is listed so you can confirm it is intended.
- **Fix:** If the page should appear in search, remove the noindex directive from the meta robots tag and the X-Robots-Tag header.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/hidden | The page carries a noindex directive. |

### A noindex page is listed in the sitemap

- **Check:** `SEO-INDEX-041`
- **Severity:** error
- **Why:** The sitemap says the page should be indexed while the page says it should not, so the two signals contradict each other.
- **Fix:** Remove the page from the sitemap, or remove the noindex directive.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/hidden | The page is noindex but is listed in the sitemap. |

### Open Graph tags are missing

- **Check:** `SEO-OG-060`
- **Severity:** info
- **Why:** Open Graph tags control the title, text and image shown when the page is shared on social networks and in chat apps.
- **Fix:** Add og:title, og:description and og:image meta tags to the head.

Findings (8):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/ | Missing og:title, og:description, og:image. |
| http://127.0.0.1:4173/about | Missing og:title, og:description, og:image. |
| http://127.0.0.1:4173/untitled | Missing og:title, og:description, og:image. |
| http://127.0.0.1:4173/dup-a | Missing og:title, og:description, og:image. |
| http://127.0.0.1:4173/dup-b | Missing og:title, og:description, og:image. |
| http://127.0.0.1:4173/two-h1 | Missing og:title, og:description, og:image. |
| http://127.0.0.1:4173/form | Missing og:title, og:description, og:image. |
| http://127.0.0.1:4173/media | Missing og:title, og:description, og:image. |

### Structured data is not valid JSON

- **Check:** `SEO-LD-070`
- **Severity:** warning
- **Why:** Search engines skip a JSON-LD block they cannot parse, so the page loses any rich results it was meant to earn.
- **Fix:** Fix the syntax of the JSON-LD block. A JSON validator will point at the error.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/form | A JSON-LD block is not valid JSON. |

### No robots.txt file

- **Check:** `SEO-ROBOTS-080`
- **Severity:** warning
- **Why:** Crawlers look for robots.txt first. Without one they assume everything may be crawled and they cannot find the sitemap from it.
- **Fix:** Publish a robots.txt at the root of the site, even a short one that links to the sitemap.

Findings (1):

| Page | Detail |
| --- | --- |
| (whole site) | robots.txt returned status 404. |

### robots.txt does not reference the sitemap

- **Check:** `SEO-MAP-091`
- **Severity:** info
- **Why:** A Sitemap line in robots.txt lets every crawler find the sitemap without being told about it.
- **Fix:** Add a line such as Sitemap: https://example.com/sitemap.xml to robots.txt.

Findings (1):

| Page | Detail |
| --- | --- |
| (whole site) | A sitemap exists but robots.txt has no Sitemap line. |

### Page has little text

- **Check:** `SEO-THIN-100`
- **Severity:** info
- **Why:** Pages with very little text give search engines little to rank. Some pages, such as contact or gallery pages, are fine this way.
- **Fix:** If the page should rank, add useful text that answers what visitors come for.
- **Heuristic:** Fails below 150 words of visible text. This is a rule of thumb and may be fine for contact or gallery pages.

Findings (8):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/ | The page has 77 words of visible text. |
| http://127.0.0.1:4173/about | The page has 62 words of visible text. |
| http://127.0.0.1:4173/untitled | The page has 62 words of visible text. |
| http://127.0.0.1:4173/dup-a | The page has 62 words of visible text. |
| http://127.0.0.1:4173/dup-b | The page has 62 words of visible text. |
| http://127.0.0.1:4173/two-h1 | The page has 66 words of visible text. |
| http://127.0.0.1:4173/form | The page has 67 words of visible text. |
| http://127.0.0.1:4173/media | The page has 62 words of visible text. |

## Health

### Broken internal link

- **Check:** `HEALTH-LINK-001`
- **Severity:** error
- **Why:** Visitors and search engines who follow the link reach an error page instead of content.
- **Fix:** Fix the link to point at a working page, or restore the missing page and redirect it if it moved.
- **Heuristic:** A link whose target answered 429 or 503 during the audit is reported as not verified, because the answer says nothing about whether the page exists.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/missing | The URL returns status 404. Evidence: http://127.0.0.1:4173/ |

### Internal link points at a redirect

- **Check:** `HEALTH-LINK-002`
- **Severity:** warning
- **Why:** Each redirect adds a round trip for visitors and crawlers.
- **Fix:** Update the link to point straight at the final address.

Findings (2):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/old-page | Redirects to http://127.0.0.1:4173/about Evidence: http://127.0.0.1:4173/ |
| http://127.0.0.1:4173/chain-a | Redirects to http://127.0.0.1:4173/dup-a Evidence: http://127.0.0.1:4173/ |

### Redirect chain has more than one hop

- **Check:** `HEALTH-REDIR-010`
- **Severity:** warning
- **Why:** Every extra hop slows the page down and gives crawlers another chance to give up.
- **Fix:** Redirect the first address straight to the final address.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/chain-a | Redirect chain of 2 hops ending at http://127.0.0.1:4173/dup-a. Evidence: http://127.0.0.1:4173/chain-a; http://127.0.0.1:4173/chain-b |

### HTTP is not upgraded to HTTPS

- **Check:** `HEALTH-HTTPS-020`
- **Severity:** error
- **Why:** Plain HTTP traffic can be read and changed on the way, and browsers label such sites as not secure.
- **Fix:** Install a certificate, serve the site over HTTPS, and redirect every HTTP address to its HTTPS version.

Findings (1):

| Page | Detail |
| --- | --- |
| (whole site) | The site is served over plain HTTP. |

### No favicon

- **Check:** `HEALTH-FAV-040`
- **Severity:** info
- **Why:** Browsers ask for a favicon to show in tabs and bookmarks. Without one they show a generic icon, and the requests end in 404 errors.
- **Fix:** Add a favicon link to the page head, or serve a file at /favicon.ico.

Findings (1):

| Page | Detail |
| --- | --- |
| (whole site) | No favicon link in the pages and no /favicon.ico file. |

### No Content-Security-Policy header

- **Check:** `HEALTH-HDR-051`
- **Severity:** info
- **Why:** A content security policy limits where scripts and other resources can load from, which reduces the damage of injected code.
- **Fix:** Add a Content-Security-Policy header. Start in report-only mode if the site loads many third-party resources.

Findings (1):

| Page | Detail |
| --- | --- |
| (whole site) | The start page has no Content-Security-Policy header. 8 other pages also lack it. |

### No X-Content-Type-Options nosniff header

- **Check:** `HEALTH-HDR-052`
- **Severity:** warning
- **Why:** Without nosniff, some browsers guess file types and may run a file as a script when it was not meant to be one.
- **Fix:** Send X-Content-Type-Options: nosniff on every response.

Findings (1):

| Page | Detail |
| --- | --- |
| (whole site) | The start page has no X-Content-Type-Options: nosniff header. 8 other pages also lack it. |

### No Referrer-Policy header

- **Check:** `HEALTH-HDR-053`
- **Severity:** info
- **Why:** Without a policy, browsers decide how much of the page address is shared with other sites when a visitor clicks a link.
- **Fix:** Send a Referrer-Policy header such as strict-origin-when-cross-origin.

Findings (1):

| Page | Detail |
| --- | --- |
| (whole site) | The start page has no Referrer-Policy header. 8 other pages also lack it. |

### No clickjacking protection

- **Check:** `HEALTH-HDR-054`
- **Severity:** info
- **Why:** Without X-Frame-Options or a frame-ancestors rule, other sites can embed the page in a frame and trick visitors into clicking hidden controls.
- **Fix:** Send X-Frame-Options or add a frame-ancestors rule to the Content-Security-Policy.

Findings (1):

| Page | Detail |
| --- | --- |
| (whole site) | The start page has no X-Frame-Options or CSP frame-ancestors header. 8 other pages also lack it. |

## Performance

### HTML is served without compression

- **Check:** `PERF-COMP-020`
- **Severity:** error
- **Why:** Compression usually cuts the size of HTML by a large share, so pages download faster.
- **Fix:** Turn on gzip or Brotli compression for HTML responses in the web server or CDN.
- **Heuristic:** Only documents over 1 KB (1024 bytes) are checked, because compressing tiny files gains little.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/ | The 1119 byte HTML response has no gzip, br, deflate or zstd encoding. |

### Script or stylesheet served without compression

- **Check:** `PERF-COMP-021`
- **Severity:** warning
- **Why:** Text assets compress well. Sending them as they are wastes bandwidth and slows rendering.
- **Fix:** Turn on gzip or Brotli compression for JavaScript and CSS files.
- **Heuristic:** Only files over 1 KB (1024 bytes) are checked.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/assets/plain.css | The 2640 byte stylesheet has no compression. Evidence: http://127.0.0.1:4173/media |

### Static asset is not cached for long

- **Check:** `PERF-CACHE-030`
- **Severity:** warning
- **Why:** Without a cache lifetime, returning visitors download the same files again on every visit.
- **Fix:** Send Cache-Control with a max-age of at least one hour, and a year for files whose names change when they change.
- **Heuristic:** Fails when there is no max-age and no Expires, when max-age is under 3600 seconds, or on no-store. Only measured assets on the audited origin are checked.

Findings (2):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/assets/huge.png | No Cache-Control or Expires header. Evidence: http://127.0.0.1:4173/media |
| http://127.0.0.1:4173/assets/plain.css | No Cache-Control or Expires header. Evidence: http://127.0.0.1:4173/media |

### Large image

- **Check:** `PERF-IMG-050`
- **Severity:** warning
- **Why:** Images are often the largest part of a page.
- **Fix:** Resize the image to the size it is shown at and compress it, or use a modern format such as WebP or AVIF.
- **Heuristic:** Fails above 300 KB (300000 bytes) and up to 1 MB. A rule of thumb.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/assets/huge.png | The image is 600000 bytes. Evidence: http://127.0.0.1:4173/media |

### Images without width and height

- **Check:** `PERF-IMG-052`
- **Severity:** warning
- **Why:** Without both attributes the browser cannot reserve space, so the page jumps as images load.
- **Fix:** Add width and height attributes that match the image's own size, and let CSS scale it.
- **Heuristic:** Decorative images are counted too, because layout shift applies to them as well.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/media | 1 image lacks a width or height attribute. Evidence: http://127.0.0.1:4173/assets/huge.png |

### Large JPEG or PNG

- **Check:** `PERF-IMG-054`
- **Severity:** info
- **Why:** Modern formats such as WebP and AVIF are often smaller at the same quality.
- **Fix:** Convert the image to WebP or AVIF, and keep the old format as a fallback only if needed.
- **Heuristic:** Fails for JPEG and PNG files over 100 KB (100000 bytes). A modern format may be smaller, but not always.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/assets/huge.png | The image/png image is 600000 bytes. Evidence: http://127.0.0.1:4173/media |

### Render-blocking script in the head

- **Check:** `PERF-BLOCK-060`
- **Severity:** warning
- **Why:** A script in the head without async or defer stops the browser from showing the page until it has loaded and run.
- **Fix:** Add defer, or async for independent scripts, or move the script to the end of the body.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/media | 1 script in the head blocks rendering. Evidence: http://127.0.0.1:4173/assets/blocking.js |

## Accessibility

> Static checks only. This is not an accessibility audit: contrast, keyboard use, focus order and screen reader behaviour are not tested.

### Image without an alt attribute

- **Check:** `A11Y-ALT-001`
- **Severity:** warning
- **Why:** Screen readers have nothing to say about an image with no alt attribute, and may read out the file name instead.
- **Fix:** Add an alt attribute that describes the image. Use alt="" for images that are only decoration.
- **Heuristic:** Images marked aria-hidden="true" or role="presentation" are not counted, because screen readers skip them.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/media | 1 image has no alt attribute. Evidence: http://127.0.0.1:4173/assets/huge.png |

### Form control without a label

- **Check:** `A11Y-LABEL-010`
- **Severity:** warning
- **Why:** People using screen readers cannot tell what a field is for, and a label also gives a larger target to click.
- **Fix:** Add a label element that points at the field, or an aria-label or aria-labelledby attribute.
- **Heuristic:** Hidden, submit, button, reset and image inputs are not counted. Image inputs need alt text instead.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/form | 1 form control has no label. Evidence: input\[type=text\]\[name=query\] |

### Generic link text

- **Check:** `A11Y-LINK-021`
- **Severity:** info
- **Why:** People who move through a page by its links hear them out of context, so click here and read more tell them nothing.
- **Fix:** Write link text that says where the link goes or what it does.
- **Heuristic:** Compares the link text, lower-cased and without trailing punctuation, with: "click here", "here", "read more", "more", "learn more", "link", "this".

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/form | 1 link uses generic text such as click here. Evidence: /about |

### Heading levels are skipped

- **Check:** `A11Y-HEAD-040`
- **Severity:** info
- **Why:** People who move through a page by its headings expect the levels to nest, and a gap suggests missing content.
- **Fix:** Use the next heading level down, and pick levels for structure and not for size.
- **Heuristic:** Fails when a heading is more than one level deeper than the heading before it.

Findings (1):

| Page | Detail |
| --- | --- |
| http://127.0.0.1:4173/form | 1 heading level is skipped. Evidence: h1 to h3 |

Checks: 33 failed, 33 passed, 3 not applicable.

site-audit-cli 1.0.0
