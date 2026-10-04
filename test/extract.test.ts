import { describe, expect, test } from "vitest";
import {
  extractDocument,
  extractWithStatus,
  MAX_DEPTH,
  MAX_NODES,
  parseBounded,
} from "../src/crawl/extract.js";

const URL0 = "https://site.example/dir/page";

// Wall-clock bound for the large-input tests. It only guards against runaway (for example
// quadratic) cost, so it is set well above normal run times, including runs under coverage.
const RUNAWAY_MS = 15_000;

function html(head: string, body = ""): string {
  return `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}

describe("title", () => {
  test("first title in head, whitespace collapsed", () => {
    const doc = extractDocument(html("<title>\n  Hello \t  world  </title>"), URL0);
    expect(doc.title).toBe("Hello world");
    expect(doc.titleCount).toBe(1);
  });

  test("missing and empty titles are null", () => {
    expect(extractDocument(html(""), URL0)).toMatchObject({ title: null, titleCount: 0 });
    expect(extractDocument(html("<title>   </title>"), URL0)).toMatchObject({
      title: null,
      titleCount: 1,
    });
  });

  test("two title elements are counted and the first wins", () => {
    const doc = extractDocument(html("<title>One</title><title>Two</title>"), URL0);
    expect(doc.title).toBe("One");
    expect(doc.titleCount).toBe(2);
  });

  test("svg titles are not counted", () => {
    const doc = extractDocument(
      html("<title>Page</title>", `<svg><title>Icon</title></svg><svg><title>Other</title></svg>`),
      URL0,
    );
    expect(doc.title).toBe("Page");
    expect(doc.titleCount).toBe(1);
  });
});

describe("meta description", () => {
  test("first match, name compared case-insensitively, trimmed", () => {
    const doc = extractDocument(
      html(
        `<meta name="Description" content="  First one  "><meta name="description" content="Second">`,
      ),
      URL0,
    );
    expect(doc.metaDescription).toBe("First one");
  });

  test("missing and empty are null", () => {
    expect(extractDocument(html(""), URL0).metaDescription).toBeNull();
    expect(
      extractDocument(html(`<meta name="description" content="   ">`), URL0).metaDescription,
    ).toBeNull();
    expect(extractDocument(html(`<meta name="description">`), URL0).metaDescription).toBeNull();
  });
});

describe("robots directives", () => {
  test("merge meta and header", () => {
    const doc = extractDocument(
      `<html><head><meta name="ROBOTS" content="NoIndex, follow"></head><body></body></html>`,
      URL0,
      { "x-robots-tag": "noarchive, googlebot: nofollow" },
    );
    expect(doc.metaRobots.sort()).toEqual(["follow", "noarchive", "noindex"]);
  });

  test("every robots meta counts and values are de-duplicated", () => {
    const doc = extractDocument(
      html(
        `<meta name="robots" content="noindex,nofollow"><meta name="robots" content=" NOINDEX , noarchive ">`,
      ),
      URL0,
    );
    expect(doc.metaRobots).toEqual(["noindex", "nofollow", "noarchive"]);
  });

  test("a header with a bot prefix is ignored, including its later directives", () => {
    const doc = extractDocument(html(""), URL0, {
      "x-robots-tag": "googlebot: noindex, nofollow",
    });
    expect(doc.metaRobots).toEqual([]);
  });

  test("the header name is matched case-insensitively", () => {
    const doc = extractDocument(html(""), URL0, { "X-Robots-Tag": "noindex" });
    expect(doc.metaRobots).toEqual(["noindex"]);
  });

  test("an unavailable_after date is not a bot prefix", () => {
    const doc = extractDocument(html(""), URL0, {
      "x-robots-tag": "unavailable_after: 25 Jun 2030 15:00:00, noindex",
    });
    expect(doc.metaRobots).toEqual(["noindex"]);
    const withComma = extractDocument(html(""), URL0, {
      "x-robots-tag": "unavailable_after: Sat, 25 Jun 2030 15:00:00 PST, nofollow",
    });
    expect(withComma.metaRobots).toEqual(["nofollow"]);
  });

  test("only a single-token prefix scopes a directive to one bot", () => {
    const doc = extractDocument(html(""), URL0, {
      "x-robots-tag": "googlebot-news: noindex, nosnippet",
    });
    expect(doc.metaRobots).toEqual([]);
  });

  test("an unavailable_after date without a time leaves no stray directive", () => {
    const doc = extractDocument(html(""), URL0, {
      "x-robots-tag": "unavailable_after: Sat, 25 Jun 2030, noindex",
    });
    expect(doc.metaRobots).toEqual(["noindex"]);
  });

  test("no robots information gives an empty list", () => {
    expect(extractDocument(html(""), URL0).metaRobots).toEqual([]);
  });
});

describe("canonicals, lang and viewport", () => {
  test("canonicals resolve to absolute URLs, unparseable ones are dropped", () => {
    const doc = extractDocument(
      html(
        `<link rel="canonical" href="/clean"><link rel="Canonical" href="https://other.example/x#frag"><link rel="canonical" href="http://[bad"><link rel="canonical"><link rel="alternate canonical" href="rel/path">`,
      ),
      URL0,
    );
    expect(doc.canonicals).toEqual([
      "https://site.example/clean",
      "https://other.example/x",
      "https://site.example/dir/rel/path",
    ]);
  });

  test("canonical links outside head are ignored", () => {
    const doc = extractDocument(html("", `<link rel="canonical" href="/body">`), URL0);
    expect(doc.canonicals).toEqual([]);
  });

  test("lang is trimmed, null when missing or empty", () => {
    expect(
      extractDocument(`<html lang=" en-GB "><head></head><body></body></html>`, URL0).lang,
    ).toBe("en-GB");
    expect(extractDocument(`<html><head></head><body></body></html>`, URL0).lang).toBeNull();
    expect(
      extractDocument(`<html lang=" "><head></head><body></body></html>`, URL0).lang,
    ).toBeNull();
  });

  test("viewport needs non-empty content", () => {
    const withViewport = `<meta name="viewport" content="width=device-width, initial-scale=1">`;
    expect(extractDocument(html(withViewport), URL0).hasViewport).toBe(true);
    expect(extractDocument(html(`<meta name="viewport" content=" ">`), URL0).hasViewport).toBe(
      false,
    );
    expect(extractDocument(html(""), URL0).hasViewport).toBe(false);
  });

  test("viewport is true when any viewport meta has content", () => {
    const doc = extractDocument(
      html(`<meta name="viewport" content=""><meta name="viewport" content="width=device-width">`),
      URL0,
    );
    expect(doc.hasViewport).toBe(true);
  });
});

describe("headings", () => {
  test("h1 to h6 in document order with collapsed text", () => {
    const doc = extractDocument(
      html(
        "",
        `<h2>Second   level</h2><h1>Top\n</h1><div><h6>Six</h6></div><h3> <span>Three</span> </h3><h4></h4><h5>Five</h5>`,
      ),
      URL0,
    );
    expect(doc.headings).toEqual([
      { level: 2, text: "Second level" },
      { level: 1, text: "Top" },
      { level: 6, text: "Six" },
      { level: 3, text: "Three" },
      { level: 4, text: "" },
      { level: 5, text: "Five" },
    ]);
  });
});

describe("open graph", () => {
  test("keeps full property names, first wins", () => {
    const doc = extractDocument(
      html(
        `<meta property="og:title" content="First"><meta property="og:title" content="Second"><meta property="og:image" content=" /share.png "><meta property="article:author" content="x"><meta name="og:site_name" content="ignored">`,
      ),
      URL0,
    );
    expect(doc.openGraph).toEqual({ "og:title": "First", "og:image": "/share.png" });
  });

  test("none gives an empty object", () => {
    expect(extractDocument(html(""), URL0).openGraph).toEqual({});
  });
});

describe("json-ld", () => {
  test("single object, array of types, graph items", () => {
    const doc = extractDocument(
      html(
        `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"}</script>
         <script type="application/ld+json">{"@type":["Article","NewsArticle"]}</script>
         <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":["Person","Thing"]},{"name":"no type"}]}</script>`,
      ),
      URL0,
    );
    expect(doc.jsonLd).toEqual([
      { ok: true, types: ["Organization"], error: null },
      { ok: true, types: ["Article", "NewsArticle"], error: null },
      { ok: true, types: ["WebSite", "Person", "Thing"], error: null },
    ]);
  });

  test("invalid and empty blocks report a short error", () => {
    const doc = extractDocument(
      html(
        `<script type="application/ld+json">{bad</script><script type="application/ld+json"></script>`,
      ),
      URL0,
    );
    expect(doc.jsonLd).toHaveLength(2);
    for (const block of doc.jsonLd) {
      expect(block.ok).toBe(false);
      expect(block.types).toEqual([]);
      expect(block.error).toBe("not valid JSON");
    }
  });

  test("the error is a fixed string that carries no page content", () => {
    const doc = extractDocument(
      html(`<script type="application/ld+json">{"name": "Secret Shop", oops}</script>`),
      URL0,
    );
    expect(doc.jsonLd[0]?.error).toBe("not valid JSON");
    expect(doc.jsonLd[0]?.error).not.toContain("Secret");
  });

  test("valid JSON that is not an object has no types", () => {
    const doc = extractDocument(html(`<script type="application/ld+json">[1, "x"]</script>`), URL0);
    expect(doc.jsonLd).toEqual([{ ok: true, types: [], error: null }]);
  });

  test("json-ld scripts are not listed as scripts", () => {
    const doc = extractDocument(
      html(`<script type="application/ld+json">{}</script><script src="/a.js"></script>`),
      URL0,
    );
    expect(doc.scripts).toHaveLength(1);
  });
});

describe("links", () => {
  test("resolution, internal flag, accessible names", () => {
    const doc = extractDocument(
      `<!doctype html><html lang="en"><head><title>T</title><base href="/base/"></head><body>
    <a href="a">Rel</a>
    <a href="https://other.example/x" rel="nofollow noopener">Out</a>
    <a href="/icon"><img src="/i.png" alt="Home"></a>
    <a href="/empty"><img src="/i.png"></a>
    <a href="mailto:x@site.example">Mail</a>
    <a href="/aria" aria-label="Profile"></a>
  </body></html>`,
      URL0,
    );
    expect(doc.links.map((l) => [l.url, l.internal, l.hasAccessibleName])).toEqual([
      ["https://site.example/base/a", true, true],
      ["https://other.example/x", false, true],
      ["https://site.example/icon", true, true],
      ["https://site.example/empty", true, false],
      [null, false, true],
      ["https://site.example/aria", true, true],
    ]);
    expect(doc.links[1]?.rel).toEqual(["nofollow", "noopener"]);
  });

  test("raw href, collapsed text and empty rel", () => {
    const doc = extractDocument(html("", `<a href=" /x?y=1#z ">  Go   there \n now </a>`), URL0);
    expect(doc.links).toEqual([
      {
        href: " /x?y=1#z ",
        url: "https://site.example/x?y=1",
        text: "Go there now",
        internal: true,
        rel: [],
        hasAccessibleName: true,
      },
    ]);
  });

  test("non-http schemes and unparseable hrefs have a null url and are not internal", () => {
    const doc = extractDocument(
      html(
        "",
        `<a href="tel:+100">t</a><a href="javascript:void(0)">j</a><a href="data:text/plain,x">d</a><a href="http://[x">u</a>`,
      ),
      URL0,
    );
    expect(doc.links.map((l) => [l.url, l.internal])).toEqual([
      [null, false],
      [null, false],
      [null, false],
      [null, false],
    ]);
  });

  test("each accessible name mechanism", () => {
    const doc = extractDocument(
      html(
        "",
        `<a href="/1" aria-labelledby="x"></a><a href="/2" title="T"></a><a href="/3"><img alt="  "></a><a href="/4"> </a><a href="/5" aria-label=" "></a>`,
      ),
      URL0,
    );
    expect(doc.links.map((l) => l.hasAccessibleName)).toEqual([true, true, false, false, false]);
  });

  test("an svg with aria-label or a title child names the link", () => {
    const doc = extractDocument(
      html(
        "",
        `<a href="/1"><svg aria-label="Home"><path d="M0 0"/></svg></a><a href="/2"><svg><title>Cart</title><path d="M0 0"/></svg></a><a href="/3"><svg aria-label=" "><title> </title></svg></a><a href="/4"><svg><path d="M0 0"/></svg></a>`,
      ),
      URL0,
    );
    expect(doc.links.map((l) => l.hasAccessibleName)).toEqual([true, true, false, false]);
  });

  test("links without href are not listed and a base with a bad value is ignored", () => {
    const doc = extractDocument(
      html(`<base href="mailto:x@site.example">`, `<a name="anchor">A</a><a href="rel">R</a>`),
      URL0,
    );
    expect(doc.links.map((l) => l.url)).toEqual(["https://site.example/dir/rel"]);
  });
});

describe("images", () => {
  test("fields, order and flags", () => {
    const doc = extractDocument(
      html(
        "",
        `<img src="/a.png" alt="A" width="10" height="20" loading="LAZY">
         <img src="b.png">
         <img src="/c.png" alt="">
         <img src="/d.png" role="presentation">
         <img src="/e.png" alt="E" aria-hidden="true">`,
      ),
      URL0,
    );
    expect(doc.images).toEqual([
      {
        src: "/a.png",
        url: "https://site.example/a.png",
        hasAlt: true,
        alt: "A",
        width: true,
        height: true,
        loading: "lazy",
        index: 0,
        decorative: false,
      },
      {
        src: "b.png",
        url: "https://site.example/dir/b.png",
        hasAlt: false,
        alt: null,
        width: false,
        height: false,
        loading: null,
        index: 1,
        decorative: false,
      },
      {
        src: "/c.png",
        url: "https://site.example/c.png",
        hasAlt: true,
        alt: "",
        width: false,
        height: false,
        loading: null,
        index: 2,
        decorative: true,
      },
      {
        src: "/d.png",
        url: "https://site.example/d.png",
        hasAlt: false,
        alt: null,
        width: false,
        height: false,
        loading: null,
        index: 3,
        decorative: true,
      },
      {
        src: "/e.png",
        url: "https://site.example/e.png",
        hasAlt: true,
        alt: "E",
        width: false,
        height: false,
        loading: null,
        index: 4,
        decorative: true,
      },
    ]);
  });

  test("srcset only falls back to the first candidate", () => {
    const doc = extractDocument(
      html("", `<img srcset="/small.png 1x, /big.png 2x" alt="x"><img srcset="  /one.png  "><img>`),
      URL0,
    );
    expect(doc.images.map((i) => [i.src, i.url])).toEqual([
      [null, "https://site.example/small.png"],
      [null, "https://site.example/one.png"],
      [null, null],
    ]);
  });

  test("data sources have a null url", () => {
    const doc = extractDocument(
      html(
        "",
        `<img src="data:image/gif;base64,R0lGOD" alt=""><img srcset="data:image/gif;base64,R0 1x">`,
      ),
      URL0,
    );
    expect(doc.images.map((i) => i.url)).toEqual([null, null]);
    expect(doc.images[0]?.src).toBe("data:image/gif;base64,R0lGOD");
  });
});

describe("scripts", () => {
  test("inline, external, head, async, defer, module", () => {
    const doc = extractDocument(
      html(
        `<script src="/a.js" async></script><script src="b.js" defer></script><script type="module" src="/m.js"></script>`,
        `<script>var x = 1;</script><script src="https://cdn.example/c.js"></script>`,
      ),
      URL0,
    );
    expect(doc.scripts).toEqual([
      {
        url: "https://site.example/a.js",
        inHead: true,
        async: true,
        defer: false,
        module: false,
        inline: false,
      },
      {
        url: "https://site.example/dir/b.js",
        inHead: true,
        async: false,
        defer: true,
        module: false,
        inline: false,
      },
      {
        url: "https://site.example/m.js",
        inHead: true,
        async: false,
        defer: false,
        module: true,
        inline: false,
      },
      { url: null, inHead: false, async: false, defer: false, module: false, inline: true },
      {
        url: "https://cdn.example/c.js",
        inHead: false,
        async: false,
        defer: false,
        module: false,
        inline: false,
      },
    ]);
  });

  test("an inline module script", () => {
    const doc = extractDocument(html("", `<script type="Module">import "./x.js";</script>`), URL0);
    expect(doc.scripts[0]).toMatchObject({ inline: true, module: true });
  });
});

describe("stylesheets and icon", () => {
  test("resolved url, head flag and media", () => {
    const doc = extractDocument(
      html(
        `<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="b.css" media="print"><link rel="alternate stylesheet" href="/c.css"><link rel="stylesheet">`,
        `<link rel="stylesheet" href="/late.css">`,
      ),
      URL0,
    );
    expect(doc.stylesheets).toEqual([
      { url: "https://site.example/a.css", inHead: true, media: null },
      { url: "https://site.example/dir/b.css", inHead: true, media: "print" },
      { url: "https://site.example/c.css", inHead: true, media: null },
      { url: "https://site.example/late.css", inHead: false, media: null },
    ]);
  });

  test("icon link detection", () => {
    expect(extractDocument(html(`<link rel="icon" href="/f.ico">`), URL0).iconLink).toBe(true);
    expect(extractDocument(html(`<link rel="shortcut icon" href="/f.ico">`), URL0).iconLink).toBe(
      true,
    );
    expect(
      extractDocument(html(`<link rel="apple-touch-icon" href="/a.png">`), URL0).iconLink,
    ).toBe(true);
    expect(extractDocument(html(`<link rel="stylesheet" href="/a.css">`), URL0).iconLink).toBe(
      false,
    );
    expect(extractDocument(html(""), URL0).iconLink).toBe(false);
  });
});

describe("form controls", () => {
  test("excluded types are skipped", () => {
    const doc = extractDocument(
      html(
        "",
        `<input type="hidden" name="h"><input type="submit"><input type="button"><input type="reset"><input type="HIDDEN">`,
      ),
      URL0,
    );
    expect(doc.formControls).toEqual([]);
  });

  test("labelled by each of the five mechanisms, and one unlabelled", () => {
    const doc = extractDocument(
      html(
        "",
        `<label for="a">A</label><input id="a" type="text" name="a">
         <label>Inside <input type="email" name="b"></label>
         <input type="text" name="c" aria-label="C">
         <input type="text" name="d" aria-labelledby="x">
         <textarea name="e" title="E"></textarea>
         <select name="f"><option>1</option></select>`,
      ),
      URL0,
    );
    expect(doc.formControls.map((c) => [c.tag, c.labelled])).toEqual([
      ["input", true],
      ["input", true],
      ["input", true],
      ["input", true],
      ["textarea", true],
      ["select", false],
    ]);
  });

  test("a label for another id does not label the control", () => {
    const doc = extractDocument(
      html("", `<label for="other">X</label><input id="mine" type="text">`),
      URL0,
    );
    expect(doc.formControls[0]?.labelled).toBe(false);
  });

  test("an image input is labelled only by alt", () => {
    const doc = extractDocument(
      html(
        "",
        `<label for="i1">L</label><input id="i1" type="image" src="/go.png">
         <input type="image" src="/go.png" aria-label="Go" title="Go">
         <input type="image" src="/go.png" alt="Go">`,
      ),
      URL0,
    );
    expect(doc.formControls.map((c) => c.labelled)).toEqual([false, false, true]);
  });

  test("describe summarises tag, type and name", () => {
    const doc = extractDocument(
      html(
        "",
        `<input type="Email" name="email"><textarea name="msg"></textarea><select id="pick"></select><input>`,
      ),
      URL0,
    );
    expect(doc.formControls.map((c) => c.describe)).toEqual([
      "input[type=email][name=email]",
      "textarea[name=msg]",
      "select[id=pick]",
      "input",
    ]);
    expect(doc.formControls[0]).toMatchObject({ tag: "input", type: "email" });
    expect(doc.formControls[1]).toMatchObject({ tag: "textarea", type: null });
  });
});

describe("buttons and iframes", () => {
  test("button names", () => {
    const doc = extractDocument(
      html(
        "",
        `<button>Save</button>
         <button aria-label="Close"></button>
         <button aria-labelledby="x"></button>
         <button title="Help"></button>
         <button><img src="/i.png" alt="Menu"></button>
         <button><img src="/i.png"></button>
         <button type="submit"> </button>
         <div role="button">Div button</div>
         <span role="button"></span>`,
      ),
      URL0,
    );
    expect(doc.buttons.map((b) => b.hasName)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(doc.buttons[6]?.describe).toBe("button[type=submit]");
    expect(doc.buttons[8]?.describe).toBe("span[role=button]");
  });

  test("iframes", () => {
    const doc = extractDocument(
      html(
        "",
        `<iframe src="https://video.example/embed" title="Video"></iframe><iframe title=" "></iframe><iframe src="/inner"></iframe>`,
      ),
      URL0,
    );
    expect(doc.iframes).toEqual([
      { hasTitle: true, src: "https://video.example/embed" },
      { hasTitle: false, src: null },
      { hasTitle: false, src: "/inner" },
    ]);
  });
});

describe("word count", () => {
  test("counts body words and ignores script, style, noscript, template and svg text", () => {
    const doc = extractDocument(
      `<html><head><title>Not counted title</title><style>.a { color: red }</style></head><body>
        <p>One two  three</p>
        <script>var many = "words in a script";</script>
        <style>p { margin: 0 }</style>
        <noscript>Enable javascript please</noscript>
        <template><p>template words here</p></template>
        <svg><title>icon title</title><text>svg words</text></svg>
        <div>four
        five</div>
      </body></html>`,
      URL0,
    );
    expect(doc.wordCount).toBe(5);
  });

  test("minified block elements count as separate words", () => {
    expect(extractDocument(html("", "<p>one</p><p>two</p>"), URL0).wordCount).toBe(2);
    expect(
      extractDocument(html("", "<div>a</div><div>b</div><ul><li>c</li><li>d</li></ul>"), URL0)
        .wordCount,
    ).toBe(4);
    expect(extractDocument(html("", "<p>hel<b>lo</b></p>"), URL0).wordCount).toBe(2);
    expect(extractDocument(html("", "<p>a<br>b</p>"), URL0).wordCount).toBe(2);
  });

  test("skipped elements still break a word", () => {
    expect(extractDocument(html("", "foo<svg></svg>bar"), URL0).wordCount).toBe(2);
    expect(extractDocument(html("", "foo<script>x()</script>bar"), URL0).wordCount).toBe(2);
    expect(
      extractDocument(html("", "foo<style>p{}</style>bar<noscript>n</noscript>baz"), URL0)
        .wordCount,
    ).toBe(3);
  });

  test("whitespace and empty elements do not add words", () => {
    expect(
      extractDocument(html("", "<p> </p><div></div><span>x</span><p></p>"), URL0).wordCount,
    ).toBe(1);
  });

  test("empty and missing bodies are zero", () => {
    expect(extractDocument("", URL0).wordCount).toBe(0);
    expect(extractDocument(html(""), URL0).wordCount).toBe(0);
  });
});

describe("mixed content", () => {
  const body = `
    <img src="http://img.example/a.png">
    <script src="http://js.example/a.js"></script>
    <link rel="stylesheet" href="http://css.example/a.css">
    <iframe src="http://frame.example/"></iframe>
    <video src="http://media.example/v.mp4"><source src="http://media.example/v.webm"></video>
    <audio src="http://media.example/a.mp3"></audio>
    <img src="https://safe.example/b.png">
    <a href="http://plain.example/link">not a subresource</a>
    <img src="/relative.png">`;

  test("an https page lists http subresources, resolved", () => {
    const doc = extractDocument(html("", body), URL0);
    expect(doc.mixedContent).toEqual([
      "http://img.example/a.png",
      "http://js.example/a.js",
      "http://css.example/a.css",
      "http://frame.example/",
      "http://media.example/v.mp4",
      "http://media.example/v.webm",
      "http://media.example/a.mp3",
    ]);
  });

  test("a relative subresource on an http base resolves to http only when the page is http", () => {
    const doc = extractDocument(
      html(`<base href="http://insecure.example/">`, `<img src="/rel.png">`),
      URL0,
    );
    expect(doc.mixedContent).toEqual(["http://insecure.example/rel.png"]);
  });

  test("an http page has no mixed content", () => {
    const doc = extractDocument(html("", body), "http://site.example/dir/page");
    expect(doc.mixedContent).toEqual([]);
  });
});

describe("documents without head or body", () => {
  test("without a head element the first title outside svg is the title", () => {
    const doc = extractDocument(
      `<svg><title>Icon</title></svg><title> First  page </title><title>Second</title>`,
      URL0,
    );
    expect(doc.title).toBe("First page");
    expect(doc.titleCount).toBe(2);
  });

  test("with a head element only titles in head count", () => {
    const doc = extractDocument(html("<title>In head</title>", "<title>In body</title>"), URL0);
    expect(doc.title).toBe("In head");
    expect(doc.titleCount).toBe(1);
  });

  test("without a head element, elements before the body are in head", () => {
    const doc = extractDocument(
      `<script src="/a.js"></script><link rel="stylesheet" href="/a.css"><link rel="canonical" href="/c"><body><script src="/b.js"></script><link rel="stylesheet" href="/b.css"></body>`,
      URL0,
    );
    expect(doc.scripts.map((s) => s.inHead)).toEqual([true, false]);
    expect(doc.stylesheets.map((s) => s.inHead)).toEqual([true, false]);
    expect(doc.canonicals).toEqual(["https://site.example/c"]);
  });

  test("without head or body, elements before the first content element are in head", () => {
    const doc = extractDocument(
      `<html lang="en"><meta charset="utf-8"><title>T</title><script src="/a.js"></script><p>Hello world</p><script src="/b.js"></script><link rel="canonical" href="/late"></html>`,
      URL0,
    );
    expect(doc.title).toBe("T");
    expect(doc.lang).toBe("en");
    expect(doc.scripts.map((s) => s.inHead)).toEqual([true, false]);
    expect(doc.canonicals).toEqual([]);
    expect(doc.wordCount).toBe(2);
  });

  test("without a body the whole document is counted, minus titles", () => {
    const doc = extractDocument(
      `<html><head><title>Not counted</title></head><p>one two</p><div>three</div></html>`,
      URL0,
    );
    expect(doc.wordCount).toBe(3);
  });

  test("head content placed after </head> and before the body still counts as head", () => {
    const doc = extractDocument(
      `<html><head></head><title>T</title><link rel=canonical href=/c><script src="/a.js"></script><body><title>Late</title><script src="/b.js"></script></body></html>`,
      URL0,
    );
    expect(doc.title).toBe("T");
    expect(doc.titleCount).toBe(1);
    expect(doc.canonicals).toEqual(["https://site.example/c"]);
    expect(doc.scripts.map((s) => s.inHead)).toEqual([true, false]);
  });

  test("a head left open ends at the first content element", () => {
    const doc = extractDocument(
      `<html><head><title>T</title><link rel="stylesheet" href="/a.css"><p>words here</p><script src="/b.js"></script><link rel="canonical" href="/late">`,
      URL0,
    );
    expect(doc.title).toBe("T");
    expect(doc.stylesheets.map((s) => s.inHead)).toEqual([true]);
    expect(doc.scripts.map((s) => s.inHead)).toEqual([false]);
    expect(doc.canonicals).toEqual([]);
    expect(doc.wordCount).toBe(2);
  });

  test("content of noscript, template and iframe is not indexed", () => {
    const doc = extractDocument(
      html(
        `<noscript><link rel="stylesheet" href="/n.css"></noscript>`,
        `<noscript><img src="/n.png"><a href="/n">n</a></noscript><template><a href="/t">t</a></template><iframe title="f"><a href="/i">i</a></iframe><a href="/real"><noscript><img src="/x.png" alt="X"></noscript></a><img src="/real.png">`,
      ),
      URL0,
    );
    expect(doc.images.map((i) => i.src)).toEqual(["/real.png"]);
    expect(doc.links.map((l) => [l.href, l.hasAccessibleName])).toEqual([["/real", false]]);
    expect(doc.stylesheets).toEqual([]);
    expect(doc.iframes).toHaveLength(1);
  });
});

describe("ordinary pages are read in full", () => {
  test("a 200-item list", () => {
    const body = `<ul>${'<li><a href="/item">item</a></li>'.repeat(200)}</ul>`;
    const result = extractWithStatus(html("<title>List</title>", body), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.title).toBe("List");
    expect(result.doc.links).toHaveLength(200);
    expect(result.doc.wordCount).toBe(200);
  });

  test.each([
    ["with tbody", (rows: string) => `<table><tbody>${rows}</tbody></table>`],
    ["without tbody", (rows: string) => `<table>${rows}</table>`],
  ])("a 500-row table %s", (_name, table) => {
    const rows = '<tr><td><a href="/row">a</a></td><td>b</td></tr>'.repeat(500);
    const result = extractWithStatus(html("", `${table(rows)}<a href="/after">after</a>`), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.links).toHaveLength(501);
    expect(result.doc.wordCount).toBe(1001);
  });

  test("300 inline svg icons", () => {
    const icon =
      '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M0 0L16 16"/><path d="M16 0L0 16"/></svg>';
    const body = `<ul>${`<li><a href="/x">${icon}label</a></li>`.repeat(300)}</ul><a href="/after">after</a>`;
    const result = extractWithStatus(html("", body), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.links).toHaveLength(301);
    expect(result.doc.links.every((l) => l.hasAccessibleName)).toBe(true);
    expect(result.doc.wordCount).toBe(301);
  });

  test("an svg sprite with 300 symbols", () => {
    const sprite = `<svg style="display:none">${'<symbol id="i" viewBox="0 0 16 16"><title>Icon</title><path d="M0 0L16 16"/></symbol>'.repeat(300)}</svg>`;
    const body = `${sprite}<button><svg><use href="#i"/></svg></button><a href="/after">after</a>`;
    const result = extractWithStatus(html("<title>Page</title>", body), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.titleCount).toBe(1);
    expect(result.doc.links.map((l) => l.href)).toEqual(["/after"]);
    expect(result.doc.buttons).toHaveLength(1);
    expect(result.doc.wordCount).toBe(1);
  });

  test("a 5 MB page of 200000 flat paragraphs", () => {
    const body = `${"<p>word</p>".repeat(200000)}<!-- ${"x".repeat(2_800_000)} --><a href="/end">end</a>`;
    const started = Date.now();
    const result = extractWithStatus(html("", body), URL0);
    expect(Date.now() - started).toBeLessThan(RUNAWAY_MS);
    expect(result.truncated).toBe(false);
    expect(result.doc.wordCount).toBe(200001);
    expect(result.doc.links.map((l) => l.href)).toEqual(["/end"]);
  }, 20000);
});

type TreeLike = { type: string; children?: TreeLike[] };

/** Deepest element in the parsed tree, root at 0, walked without recursion. */
function elementDepth(root: TreeLike): number {
  let deepest = 0;
  const stack: [TreeLike, number][] = [[root, 0]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [node, depth] = item;
    if (node.type !== "text" && node.type !== "comment" && depth > deepest) deepest = depth;
    for (const child of node.children ?? []) stack.push([child, depth + 1]);
  }
  return deepest;
}

describe("hostile and broken markup", () => {
  test("does not throw", () => {
    for (const markup of [
      "",
      "<",
      "<html><head><title>",
      "\u0000\u0001<a href='http://[x'>",
      "<script type='application/ld+json'>{bad</script>",
      "<a href='",
      "<img srcset=',,,'><img srcset='    '>",
      `<script type="application/ld+json">${"[".repeat(100000)}</script>`,
      "<table><a href=/x><tr><td></table>".repeat(500),
    ]) {
      expect(() => extractDocument(markup, URL0)).not.toThrow();
    }
    expect(
      extractDocument("<script type='application/ld+json'>{bad</script>", URL0).jsonLd[0]?.ok,
    ).toBe(false);
  });

  test("very deep nesting stops at the depth limit and keeps the content before it", () => {
    const deep = `<title>Deep</title><a href="/before">before</a>${"<div>".repeat(300000)}<a href="/after">after</a>`;
    const started = Date.now();
    const result = extractWithStatus(html(deep), URL0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.truncated).toBe(true);
    expect(result.doc.title).toBe("Deep");
    expect(result.doc.links.map((l) => l.href)).toEqual(["/before"]);
  });

  test("nesting just under the depth limit is read in full", () => {
    const levels = MAX_DEPTH - 10;
    const body = `${"<div>".repeat(levels)}<a href="/inside">inside</a>${"</div>".repeat(levels)}<a href="/after">after</a>`;
    const result = extractWithStatus(html("", body), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.links.map((l) => l.href)).toEqual(["/inside", "/after"]);
    expect(result.doc.wordCount).toBe(2);
    expect(extractWithStatus(html("", "<div>".repeat(MAX_DEPTH + 10)), URL0).truncated).toBe(true);
  });

  test("many unclosed paragraphs and list items are not mistaken for deep nesting", () => {
    const body = `<ul>${"<li>item ".repeat(5000)}</ul>${"<p>para ".repeat(5000)}<a href="/end">end</a>`;
    const result = extractWithStatus(html("", body), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.links.map((l) => l.href)).toEqual(["/end"]);
  });

  test("a 100-item list of unclosed items holding unclosed paragraphs is read in full", () => {
    const body = `<ul>${"<li><p>item".repeat(100)}</ul><a href="/end">end</a>`;
    const result = extractWithStatus(html("", body), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.wordCount).toBe(101);
    expect(result.doc.links.map((l) => l.href)).toEqual(["/end"]);
  });

  test("100 unclosed bold tags across a run of paragraphs are read in full", () => {
    const body = `${"<p>plain <b>bold".repeat(100)}<a href="/end">end</a>`;
    const result = extractWithStatus(html("", body), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.wordCount).toBe(201);
    expect(result.doc.links.map((l) => l.href)).toEqual(["/end"]);
  });

  test("tags written inside script text or comments are not elements", () => {
    const script = `<script>var s = "${"<div>".repeat(3000)}";</script><!-- ${"<div>".repeat(3000)} -->`;
    const result = extractWithStatus(html("", `${script}<a href="/ok">ok</a>`), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.links.map((l) => l.href)).toEqual(["/ok"]);
  });

  test.each(["div", "span", "section", "a"])("<%s/> opens an element in html", (tag) => {
    const markup = `<a href="/before">before</a>${`<${tag}/>`.repeat(100000)}<a href="/after">after</a>`;
    const started = Date.now();
    const result = extractWithStatus(html("", markup), URL0);
    expect(Date.now() - started).toBeLessThan(RUNAWAY_MS);
    expect(result.truncated).toBe(true);
    expect(result.doc.links.map((l) => l.href)).toEqual(["/before"]);
  });

  test("thousands of leaf svg elements in each valid spelling are not truncated", () => {
    const spellings = [
      '<path d="M0 0"/>',
      '<path d="M0 0" />',
      "<path/>",
      "<path />",
      "<path d='M0 0'/>",
      "<path d=a />",
    ];
    for (const leaf of spellings) {
      const markup = `<svg viewBox="0 0 1 1"><g>${leaf.repeat(20000)}</g><circle r="1"/></svg><svg/><math><mi/></math><a href="/after">after</a>`;
      const result = extractWithStatus(html("", markup), URL0);
      expect(result.truncated, leaf).toBe(false);
      expect(result.doc.links.map((l) => l.href)).toEqual(["/after"]);
    }
  });

  test("a page with many inline svg icons is not truncated", () => {
    const icon = '<svg width="1" height="1"><g><path d="M0 0"/><circle r="1"/></g></svg>';
    const markup = `<ul>${`<li><a href="/x">${icon}label</a>`.repeat(5000)}</ul>`;
    const result = extractWithStatus(html("", markup), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.links).toHaveLength(5000);
  });

  test("an end tag closes the phrasing elements left open inside it", () => {
    const result = extractWithStatus(html("", "<div><span><b>x</div>".repeat(5000)), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.wordCount).toBe(5000);
  });

  test("text reads stay flat when named elements are nested around large text", () => {
    const text = "word ".repeat(120000);
    const levels = MAX_DEPTH - 10;
    const buttons = `${'<div role="button">'.repeat(levels)}${text}`;
    const headings = `${"<h1><div>".repeat(levels / 2)}${text}`;
    for (const body of [buttons, headings]) {
      const started = Date.now();
      const result = extractWithStatus(html("", body), URL0);
      expect(Date.now() - started).toBeLessThan(RUNAWAY_MS);
      expect(result.truncated).toBe(false);
      expect(result.doc.wordCount).toBe(120000);
    }
    const doc = extractDocument(html("", buttons), URL0);
    expect(doc.buttons).toHaveLength(levels);
    expect(doc.buttons.every((b) => b.hasName)).toBe(true);
  });

  test("link and heading text is a bounded preview of long text", () => {
    const long = "abc ".repeat(5000);
    const doc = extractDocument(html("", `<h2>${long}</h2><a href="/x">${long}</a>`), URL0);
    expect(doc.headings[0]?.text.startsWith("abc abc abc")).toBe(true);
    expect(doc.headings[0]?.text.length).toBeLessThanOrEqual(2000);
    expect(doc.links[0]?.text.length).toBeLessThanOrEqual(2000);
  });

  test("an image with alt deep inside an otherwise empty link names it", () => {
    const body = `<a href="/x">${"<span>".repeat(100)}<img src="/i.png" alt="Logo">${"</span>".repeat(100)}</a>`;
    expect(extractDocument(html("", body), URL0).links[0]?.hasAccessibleName).toBe(true);
  });

  test("an element boundary breaks a word, inline elements included", () => {
    const doc = extractDocument(html("", "<p>one<b>two</b> three four</p>"), URL0);
    expect(doc.wordCount).toBe(4);
  });

  // Hostile inputs. Each must finish fast, and is reported truncated when the parsed tree would
  // otherwise be deeper than the limit.
  const wrappedBlock = `${'<div role="button">'.repeat(900)}${"<b> </b>".repeat(20000)}${"</div>".repeat(900)}`;
  const words = "word ".repeat(120000);
  const hostileCases: [string, string, boolean][] = [
    ["<div> x16000", "<div>".repeat(16000), true],
    ["<div> x48000", "<div>".repeat(48000), true],
    ["<div> x100000", "<div>".repeat(100000), true],
    ["<div/> x16000", "<div/>".repeat(16000), true],
    ["<div/> x48000", "<div/>".repeat(48000), true],
    ["<div/> x100000", "<div/>".repeat(100000), true],
    ["svg path with a solidus and a space", `<svg>${"<path / >".repeat(48000)}`, false],
    [
      "svg path with an unquoted value ending in a solidus",
      `<svg>${"<path d=a/>".repeat(48000)}`,
      true,
    ],
    ["foreignObject section", `<svg><foreignObject>${"<section/>".repeat(48000)}`, true],
    ["svg desc section", `<svg><desc>${"<section/>".repeat(48000)}`, true],
    ["math annotation-xml section", `<math><annotation-xml>${"<section/>".repeat(48000)}`, true],
    ["div closed through foreignObject", "<div><svg><foreignObject></div>".repeat(48000), true],
    ["a quote inside an unquoted value", `<div a=b=">${"<div>".repeat(48000)}">`, true],
    ["xmp holding a comment opener", `<xmp><!--</xmp>${"<div>".repeat(48000)}`, true],
    ["noscript holding a title", `<noscript><title></noscript>${"<div>".repeat(48000)}`, false],
    ["iframe holding a title", `<iframe><title></iframe>${"<div>".repeat(48000)}`, false],
    ["900 nested buttons around 20000 bold spaces, 8 times", wrappedBlock.repeat(8), true],
    [
      "900 nested buttons around 600 KB of words",
      `${'<div role="button">'.repeat(900)}${words}`,
      true,
    ],
    ["450 nested headings around 600 KB of words", `${"<h1><div>".repeat(450)}${words}`, true],
    ["nested tables", "<table><tr><td>".repeat(20000), true],
    ["nested lists", "<ul><li>".repeat(20000), true],
    ["unclosed links", "<a href=x>".repeat(48000), true],
    ["stray closers x48000", "<div></x>".repeat(48000), true],
    ["stray closers x100000", "<div></x>".repeat(100000), true],
    ["999 opens then 500000 stray closers", `${"<div>".repeat(999)}${"</x>".repeat(500000)}`, true],
    ["self-closed svg roots", "<svg/>".repeat(48000), true],
  ];

  test.each(hostileCases)("hostile input stays fast: %s", (_name, markup, truncated) => {
    const page = html("", `<a href="/before">before</a>${markup}`);
    const started = Date.now();
    const result = extractWithStatus(page, URL0);
    expect(Date.now() - started).toBeLessThan(RUNAWAY_MS);
    expect(result.truncated).toBe(truncated);
    expect(result.doc.links[0]?.href).toBe("/before");
    expect(elementDepth(parseBounded(page).root)).toBeLessThanOrEqual(MAX_DEPTH);
  });

  test("stray end tags at the deepest allowed nesting stay fast up to 5 MB", () => {
    const opens = "<y>".repeat(MAX_DEPTH - 1);
    for (const stray of ["</x>", "</z>", "</dib>"]) {
      const page = opens + stray.repeat(Math.floor((5_000_000 - opens.length) / stray.length));
      const started = Date.now();
      const result = extractWithStatus(page, URL0);
      expect(Date.now() - started, stray).toBeLessThan(RUNAWAY_MS);
      expect(result.truncated).toBe(false);
    }
  }, 30000);

  test("the node cap stops a 5 MB page of empty elements", () => {
    const page = "<br>".repeat(1_250_000);
    const started = Date.now();
    const result = extractWithStatus(page, URL0);
    expect(Date.now() - started).toBeLessThan(RUNAWAY_MS);
    expect(result.truncated).toBe(true);
    expect(parseBounded(page).root.children).toHaveLength(MAX_NODES);
  }, 20000);

  test("a shared budget bounds repeated wrapper reads and reports the page as truncated", () => {
    const block = `${'<div role="button">'.repeat(100)}${"<b> </b>".repeat(20000)}${"</div>".repeat(100)}`;
    const page = html("", block.repeat(8));
    expect(parseBounded(page).truncated).toBe(false);
    const started = Date.now();
    const result = extractWithStatus(page, URL0);
    expect(Date.now() - started).toBeLessThan(RUNAWAY_MS);
    expect(result.truncated).toBe(true);
  });

  test("a document that stays inside the budget is not reported as truncated", () => {
    const body = `<h1>Title</h1><a href="/x">link</a><button>go</button><p>${"word ".repeat(500)}</p>`;
    const result = extractWithStatus(html("", body), URL0);
    expect(result.truncated).toBe(false);
    expect(result.doc.links[0]?.hasAccessibleName).toBe(true);
  });

  test("many nested labels around many controls stay fast", () => {
    const markup = `${"<label>".repeat(MAX_DEPTH - 10)}${'<input type="text">'.repeat(30000)}`;
    const started = Date.now();
    const result = extractWithStatus(html("", markup), URL0);
    expect(Date.now() - started).toBeLessThan(RUNAWAY_MS);
    // 30000 controls pass the per-page cap, so the first 5000 are kept and the page is flagged.
    expect(result.truncated).toBe(true);
    expect(result.doc.formControls).toHaveLength(5000);
    expect(result.doc.formControls.every((c) => c.labelled)).toBe(true);
  });

  test("an unparseable page url does not throw", () => {
    expect(() => extractDocument(html("", `<a href="/x">x</a>`), "not a url")).not.toThrow();
  });

  test("whitespace-heavy input stays fast", () => {
    const big = `<p>${" \t\n".repeat(200000)}x</p><a href="/x">${" ".repeat(200000)}</a>`;
    const started = Date.now();
    const doc = extractDocument(html("", big), URL0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(doc.wordCount).toBe(1);
  });
});

describe("per-page caps on collected items", () => {
  test("more than 5000 images keeps the first 5000 and flags the page truncated", () => {
    const result = extractWithStatus(html("", '<img src="/i.png" alt="i">'.repeat(5001)), URL0);
    expect(result.doc.images).toHaveLength(5000);
    expect(result.truncated).toBe(true);
  });

  test("exactly 5000 images is not truncated", () => {
    const result = extractWithStatus(html("", '<img src="/i.png" alt="i">'.repeat(5000)), URL0);
    expect(result.doc.images).toHaveLength(5000);
    expect(result.truncated).toBe(false);
  });
});
