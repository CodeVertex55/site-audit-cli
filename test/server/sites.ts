import { page } from "./html.js";
import type { LoggedRequest, RouteDef, SiteDef } from "./index.js";

const WORDS = [
  "alpha",
  "bridge",
  "candle",
  "delta",
  "ember",
  "forest",
  "garden",
  "harbor",
  "island",
  "juniper",
];

/** A paragraph of plain filler text with exactly `count` words. */
function paragraph(count: number, offset = 0): string {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(WORDS[(i + offset) % WORDS.length] ?? "word");
  return `<p>${out.join(" ")}</p>`;
}

/** The origin a request was addressed to, so pages can carry absolute URLs. */
function originOf(req: LoggedRequest): string {
  const host = req.headers.host;
  return `http://${typeof host === "string" ? host : "127.0.0.1"}`;
}

/** A route whose body depends on the origin the fixture server listens on. */
function dynamic(build: (origin: string) => RouteDef): SiteDef[string] {
  return (req) => build(originOf(req));
}

function sitemapXml(origin: string, paths: string[]): string {
  const urls = paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// A 1 by 1 transparent PNG.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// ---------------------------------------------------------------------------
// cleanSite

const CLEAN_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "SAMEORIGIN",
};

const CLEAN_ASSET_HEADERS = { "cache-control": "public, max-age=31536000" };

const CLEAN_NAV =
  '<nav><a href="/">Home</a> <a href="/about">About the studio</a> <a href="/services">Our services</a> <a href="/contact">Contact the team</a></nav>';

type CleanPage = { path: string; title: string; description: string; h1: string; body: string };

const CLEAN_PAGES: CleanPage[] = [
  {
    path: "/",
    title: "Harbor Studio home page",
    description:
      "Harbor Studio is a fictional example business used to test the site audit tool on a clean site.",
    h1: "Welcome to Harbor Studio",
    body: `<h2>What we do</h2>${paragraph(90)}<h2>Why it matters</h2>${paragraph(90, 3)}<img src="/assets/logo.png" alt="Harbor Studio logo" width="1" height="1">`,
  },
  {
    path: "/about",
    title: "About Harbor Studio and its team",
    description:
      "Learn about the people behind Harbor Studio, a fictional example business used for testing.",
    h1: "About the studio",
    body: `<h2>Our story</h2>${paragraph(90, 1)}<h2>Our team</h2>${paragraph(90, 4)}`,
  },
  {
    path: "/services",
    title: "Services offered by Harbor Studio",
    description:
      "A list of the services that the fictional Harbor Studio offers, written for the audit test site.",
    h1: "Our services",
    body: `<h2>Design</h2>${paragraph(90, 2)}<h2>Build</h2>${paragraph(90, 5)}`,
  },
  {
    path: "/contact",
    title: "Contact the Harbor Studio team",
    description:
      "How to reach the fictional Harbor Studio team, with a short contact form that has labelled fields.",
    h1: "Contact the team",
    body: `<h2>Send a message</h2>${paragraph(80, 6)}<form action="/contact" method="post"><label for="name">Your name</label> <input id="name" name="name" type="text"> <label>Your email <input name="email" type="email"></label> <button type="submit">Send message</button></form>`,
  },
];

function cleanRoute(def: CleanPage): SiteDef[string] {
  return dynamic((origin) => ({
    headers: CLEAN_HEADERS,
    gzip: true,
    body: page({
      title: def.title,
      description: def.description,
      canonical: `${origin}${def.path}`,
      h1: def.h1,
      head: [
        '<link rel="icon" href="/assets/icon.png">',
        '<link rel="stylesheet" href="/assets/app.css">',
        '<script src="/assets/app.js" defer></script>',
        `<meta property="og:title" content="${def.title}">`,
        `<meta property="og:description" content="${def.description}">`,
        `<meta property="og:image" content="${origin}/assets/logo.png">`,
      ].join("\n"),
      body: `${CLEAN_NAV}\n${def.body}`,
    }),
  }));
}

/**
 * Four pages with unique titles and descriptions, canonicals, a robots.txt that names the
 * sitemap, a sitemap, an icon, security headers, gzip, cached assets and a labelled form.
 * The only non-info check expected to fail is the one about plain HTTP.
 */
export function cleanSite(): SiteDef {
  const site: SiteDef = {};
  for (const def of CLEAN_PAGES) site[def.path] = cleanRoute(def);

  site["/robots.txt"] = dynamic((origin) => ({
    headers: { "content-type": "text/plain" },
    body: `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
  }));
  site["/sitemap.xml"] = dynamic((origin) => ({
    headers: { "content-type": "application/xml" },
    body: sitemapXml(
      origin,
      CLEAN_PAGES.map((p) => p.path),
    ),
  }));
  site["/assets/app.css"] = {
    headers: { ...CLEAN_ASSET_HEADERS, "content-type": "text/css" },
    gzip: true,
    body: "body { font-family: sans-serif; margin: 2rem; }\n".repeat(40),
  };
  site["/assets/app.js"] = {
    headers: { ...CLEAN_ASSET_HEADERS, "content-type": "text/javascript" },
    gzip: true,
    body: "document.documentElement.classList.add('ready');\n".repeat(40),
  };
  site["/assets/logo.png"] = {
    headers: { ...CLEAN_ASSET_HEADERS, "content-type": "image/png" },
    body: TINY_PNG,
  };
  site["/assets/icon.png"] = {
    headers: { ...CLEAN_ASSET_HEADERS, "content-type": "image/png" },
    body: TINY_PNG,
  };
  return site;
}

// ---------------------------------------------------------------------------
// messySite

const HOSTILE_TITLE = "<script>alert(1)</script> | \u001b[31mred";

const MESSY_NAV = [
  '<a href="/about">About</a>',
  '<a href="/untitled">Untitled</a>',
  '<a href="/dup-a">First twin</a>',
  '<a href="/dup-b">Second twin</a>',
  '<a href="/two-h1">Two headings</a>',
  '<a href="/hidden">Hidden</a>',
  '<a href="/form">Form</a>',
  '<a href="/media">Media</a>',
  '<a href="/missing">Gone</a>',
  '<a href="/old-page">Old page</a>',
  '<a href="/chain-a">Chain</a>',
].join(" ");

const TWIN_TITLE = "Twin page that shares its title";
const TWIN_DESCRIPTION =
  "Two pages on the messy fixture site share this exact description, which the audit should notice.";

/**
 * Pages built to trip checks in every group: a missing title, shared titles and descriptions,
 * two H1s, a noindex page listed in the sitemap, a broken link, a redirect, a redirect chain,
 * a large image with no alt or size, a blocking script, an uncompressed uncached stylesheet,
 * an unlabelled input, a generic link, a skipped heading, broken JSON-LD and no security
 * headers or favicon. One page has a hostile title for the sanitising tests.
 */
export function messySite(): SiteDef {
  const site: SiteDef = {};

  site["/"] = {
    body: page({
      title: "Messy fixture home page for the audit",
      description:
        "The home page of the messy fixture site, which links to pages that each break a different rule.",
      body: `${MESSY_NAV}\n${paragraph(60)}`,
    }),
  };
  site["/about"] = {
    body: page({
      title: HOSTILE_TITLE,
      description: "A page whose title holds markup and a terminal escape sequence on purpose.",
      body: paragraph(60, 2),
    }),
  };
  site["/untitled"] = {
    body: page({
      title: null,
      description: "A page that has no title element at all.",
      body: paragraph(60, 3),
    }),
  };
  site["/dup-a"] = {
    body: page({
      title: TWIN_TITLE,
      description: TWIN_DESCRIPTION,
      body: paragraph(60, 4),
    }),
  };
  site["/dup-b"] = {
    body: page({
      title: TWIN_TITLE,
      description: TWIN_DESCRIPTION,
      body: paragraph(60, 5),
    }),
  };
  site["/two-h1"] = {
    body: page({
      title: "A page with two main headings",
      description: "This page carries a second h1 element so the heading count check can fire.",
      body: `<h1>The second main heading</h1>${paragraph(60, 6)}`,
    }),
  };
  site["/hidden"] = {
    body: page({
      title: "A noindex page that is in the sitemap",
      description: "This page asks search engines not to index it but the sitemap lists it anyway.",
      head: '<meta name="robots" content="noindex">',
      body: paragraph(60, 7),
    }),
  };
  site["/form"] = {
    body: page({
      title: "A page with accessibility and markup problems",
      description:
        "A form input with no label, a generic link, a skipped heading level and broken JSON-LD.",
      head: '<script type="application/ld+json">{ "@context": "https://schema.org", "@type": </script>',
      body: `<h3>Skipped a level</h3><form action="/form" method="post"><input name="query" type="text"></form><a href="/about">Click here</a>${paragraph(60, 8)}`,
    }),
  };
  site["/media"] = {
    body: page({
      title: "A page with heavy and blocking assets",
      description:
        "This page loads a large image with no alt text or size, a blocking script and a plain stylesheet.",
      head: '<link rel="stylesheet" href="/assets/plain.css">\n<script src="/assets/blocking.js"></script>',
      body: `<img src="/assets/huge.png">${paragraph(60, 9)}`,
    }),
  };

  site["/old-page"] = { status: 301, headers: { location: "/about" } };
  site["/chain-a"] = { status: 301, headers: { location: "/chain-b" } };
  site["/chain-b"] = { status: 301, headers: { location: "/dup-a" } };

  site["/sitemap.xml"] = dynamic((origin) => ({
    headers: { "content-type": "application/xml" },
    body: sitemapXml(origin, ["/", "/about", "/dup-a", "/hidden"]),
  }));
  site["/assets/plain.css"] = {
    headers: { "content-type": "text/css" },
    body: "body { color: #222; }\n".repeat(120),
  };
  site["/assets/blocking.js"] = {
    headers: { "content-type": "text/javascript", "cache-control": "public, max-age=3600" },
    body: "window.blocking = true;\n",
  };
  site["/assets/huge.png"] = {
    headers: { "content-type": "image/png" },
    body: Buffer.alloc(600_000),
  };
  return site;
}
