import { describe, expect, test } from "vitest";
import { exceedsNestingLimit, extractDocument } from "../src/crawl/extract.js";

const URL0 = "https://site.example/dir/page";

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
      expect(block.error).toEqual(expect.any(String));
      expect((block.error ?? "").length).toBeLessThanOrEqual(120);
    }
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

  test("very deep nesting is bounded and keeps the content before the cap", () => {
    const deep = `<title>Deep</title><a href="/before">before</a>${"<div>".repeat(300000)}<a href="/after">after</a>`;
    const started = Date.now();
    const doc = extractDocument(html(deep), URL0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(doc.title).toBe("Deep");
    expect(doc.links.map((l) => l.href)).toEqual(["/before"]);
  });

  test("exceedsNestingLimit tells when the nesting guard would cut the page", () => {
    expect(exceedsNestingLimit(html("", "<div>".repeat(3000)))).toBe(true);
    expect(exceedsNestingLimit(html("", "<div>".repeat(900)))).toBe(false);
    expect(exceedsNestingLimit(html("", "<li>item ".repeat(5000)))).toBe(false);
    expect(exceedsNestingLimit("")).toBe(false);
  });

  test("moderately deep nesting is read in full", () => {
    const body = `${"<div>".repeat(900)}<a href="/inside">inside</a>${"</div>".repeat(900)}`;
    const doc = extractDocument(html("", body), URL0);
    expect(doc.links).toHaveLength(1);
    expect(doc.wordCount).toBe(1);
  });

  test("many unclosed paragraphs and list items are not mistaken for deep nesting", () => {
    const body = `<ul>${"<li>item ".repeat(5000)}</ul><a href="/end">end</a>`;
    const doc = extractDocument(html("", body), URL0);
    expect(doc.links.map((l) => l.href)).toEqual(["/end"]);
  });

  test("tags written inside script text or comments do not count toward depth", () => {
    const script = `<script>var s = "${"<div>".repeat(3000)}";</script><!-- ${"<div>".repeat(3000)} -->`;
    const doc = extractDocument(html("", `${script}<a href="/ok">ok</a>`), URL0);
    expect(doc.links.map((l) => l.href)).toEqual(["/ok"]);
  });

  test.each(["div", "span", "section", "a"])(
    "<%s/> opens an element and counts toward depth",
    (tag) => {
      const markup = `<a href="/before">before</a>${`<${tag}/>`.repeat(100000)}<a href="/after">after</a>`;
      const started = Date.now();
      const doc = extractDocument(html("", markup), URL0);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(exceedsNestingLimit(html("", markup))).toBe(true);
      expect(doc.links.map((l) => l.href)).toEqual(["/before"]);
    },
  );

  test("a script written as a self-closing tag still opens raw text in HTML", () => {
    const divs = "<div>".repeat(3000);
    expect(exceedsNestingLimit(html("", `<script/>${divs}</script>`))).toBe(false);
    expect(exceedsNestingLimit(html("", `<script/></script>${divs}`))).toBe(true);
  });

  test("thousands of self-closing svg elements are not flagged or truncated", () => {
    const paths = '<path d="M0 0"/>'.repeat(20000);
    const markup = `<svg viewBox="0 0 1 1"><g>${paths}</g><circle r="1"/></svg><svg/><math><mi/></math><a href="/after">after</a>`;
    expect(exceedsNestingLimit(html("", markup))).toBe(false);
    const doc = extractDocument(html("", markup), URL0);
    expect(doc.links.map((l) => l.href)).toEqual(["/after"]);
  });

  test("html tags that break out of svg count as real elements even when self-closed", () => {
    const markup = `<svg>${"<div/>".repeat(3000)}</svg><a href="/after">after</a>`;
    expect(exceedsNestingLimit(html("", markup))).toBe(true);
    const inMath = `<math>${"<span/>".repeat(3000)}</math>`;
    expect(exceedsNestingLimit(html("", inMath))).toBe(true);
  });

  test("tags inside a foreign script are markup and count toward depth", () => {
    const markup = `<svg><script>${"<div>".repeat(3000)}</script></svg>`;
    expect(exceedsNestingLimit(html("", markup))).toBe(true);
  });

  test("text reads stay flat when named elements are nested around large text", () => {
    const text = "word ".repeat(120000);
    const buttons = `${'<div role="button">'.repeat(900)}${text}`;
    const headings = `${"<h1><div>".repeat(450)}${text}`;
    for (const body of [buttons, headings]) {
      const started = Date.now();
      const doc = extractDocument(html("", body), URL0);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(doc.wordCount).toBe(120000);
    }
    const doc = extractDocument(html("", buttons), URL0);
    expect(doc.buttons).toHaveLength(900);
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
    const body = `<a href="/x">${"<span>".repeat(200)}<img src="/i.png" alt="Logo">${"</span>".repeat(200)}</a>`;
    expect(extractDocument(html("", body), URL0).links[0]?.hasAccessibleName).toBe(true);
  });

  test("words split across inline elements count as in the rendered text", () => {
    const doc = extractDocument(html("", "<p>one<b>two</b> three four</p>"), URL0);
    expect(doc.wordCount).toBe(3);
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
