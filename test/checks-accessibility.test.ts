import { describe, expect, test } from "vitest";
import { A11Y_NOTICE, ACCESSIBILITY_CHECKS } from "../src/checks/accessibility.js";
import { runChecks } from "../src/checks/registry.js";
import type { ParsedDocument, SiteContext } from "../src/types.js";
import { makeContext, makePage } from "./helpers/context.js";

type Image = ParsedDocument["images"][number];
type Link = ParsedDocument["links"][number];

function ctxWith(doc: Partial<ParsedDocument>): SiteContext {
  return makeContext({ pages: [makePage({ doc })] });
}

function only(id: string, ctx: SiteContext) {
  const outcome = runChecks(ctx, ["accessibility"]).find((c) => c.id === id);
  if (outcome === undefined) throw new Error(`no check ${id} in the registry`);
  return outcome;
}

function image(over: Partial<Image> = {}): Image {
  return {
    src: "/a.png",
    url: "https://site.example/a.png",
    hasAlt: true,
    alt: "A chair",
    width: true,
    height: true,
    loading: null,
    index: 0,
    decorative: false,
    ...over,
  };
}

function link(over: Partial<Link> = {}): Link {
  return {
    href: "/about",
    url: "https://site.example/about",
    text: "About us",
    internal: true,
    rel: [],
    hasAccessibleName: true,
    ...over,
  };
}

function levels(list: number[]): ParsedDocument["headings"] {
  return list.map((level) => ({ level, text: `Heading ${level}` }));
}

describe("accessibility notice and registry", () => {
  test("the notice is the fixed sentence from the spec", () => {
    expect(A11Y_NOTICE).toBe(
      "Static checks only. This is not an accessibility audit: contrast, keyboard use, focus order and screen reader behaviour are not tested.",
    );
  });

  test("the group has seven checks, all registered under accessibility", () => {
    expect(ACCESSIBILITY_CHECKS.map((c) => c.id)).toEqual([
      "A11Y-ALT-001",
      "A11Y-LABEL-010",
      "A11Y-LINK-020",
      "A11Y-LINK-021",
      "A11Y-BTN-030",
      "A11Y-HEAD-040",
      "A11Y-FRAME-050",
    ]);
    const outcomes = runChecks(makeContext(), ["accessibility"]);
    expect(outcomes).toHaveLength(7);
    expect(outcomes.every((c) => c.group === "accessibility")).toBe(true);
    expect(outcomes.every((c) => c.status === "pass")).toBe(true);
  });

  test("severities follow the spec", () => {
    const severity = Object.fromEntries(
      runChecks(makeContext(), ["accessibility"]).map((c) => [c.id, c.severity]),
    );
    expect(severity).toEqual({
      "A11Y-ALT-001": "warning",
      "A11Y-LABEL-010": "warning",
      "A11Y-LINK-020": "warning",
      "A11Y-LINK-021": "info",
      "A11Y-BTN-030": "warning",
      "A11Y-HEAD-040": "info",
      "A11Y-FRAME-050": "info",
    });
  });

  test("a site with no loaded HTML page is not applicable", () => {
    const outcomes = runChecks(makeContext({ pages: [makePage({ status: 404, doc: null })] }), [
      "accessibility",
    ]);
    expect(outcomes.every((c) => c.status === "not-applicable")).toBe(true);
  });
});

describe("A11Y-ALT-001", () => {
  test("images hidden with aria-hidden or role presentation are not counted", () => {
    const hidden = image({ hasAlt: false, alt: null, decorative: true });
    expect(only("A11Y-ALT-001", ctxWith({ images: [hidden] })).status).toBe("pass");
  });

  test("an image without alt fails, with the count and up to five image URLs", () => {
    const images = Array.from({ length: 7 }, (_, i) =>
      image({
        hasAlt: false,
        alt: null,
        url: `https://site.example/img-${i}.png`,
        index: i,
      }),
    );
    const out = only("A11Y-ALT-001", ctxWith({ images }));
    expect(out.status).toBe("fail");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toContain("7");
    expect(out.findings[0]?.evidence).toHaveLength(5);
    expect(out.findings[0]?.evidence?.[0]).toBe("https://site.example/img-0.png");
  });

  test("an empty alt is a valid decorative image and passes", () => {
    const out = only(
      "A11Y-ALT-001",
      ctxWith({ images: [image({ hasAlt: true, alt: "", decorative: true })] }),
    );
    expect(out.status).toBe("pass");
  });

  test("it also runs on noindex pages", () => {
    const ctx = ctxWith({ metaRobots: ["noindex"], images: [image({ hasAlt: false, alt: null })] });
    expect(only("A11Y-ALT-001", ctx).status).toBe("fail");
  });

  test("an image with no resolvable URL falls back to its src as evidence", () => {
    const out = only(
      "A11Y-ALT-001",
      ctxWith({ images: [image({ hasAlt: false, alt: null, url: null, src: "data:broken" })] }),
    );
    expect(out.findings[0]?.evidence).toEqual(["data:broken"]);
  });
});

describe("A11Y-LABEL-010", () => {
  test("an unlabelled control fails and names it", () => {
    const out = only(
      "A11Y-LABEL-010",
      ctxWith({
        formControls: [{ tag: "input", type: "text", labelled: false, describe: 'input name="q"' }],
      }),
    );
    expect(out.status).toBe("fail");
    expect(out.findings[0]?.evidence).toEqual(['input name="q"']);
  });

  test("a labelled control passes", () => {
    const out = only(
      "A11Y-LABEL-010",
      ctxWith({
        formControls: [{ tag: "input", type: "text", labelled: true, describe: 'input name="q"' }],
      }),
    );
    expect(out.status).toBe("pass");
  });
});

describe("A11Y-LINK-020", () => {
  test("an internal link with no accessible name fails", () => {
    const out = only(
      "A11Y-LINK-020",
      ctxWith({ links: [link({ text: "", hasAccessibleName: false, href: "/cart" })] }),
    );
    expect(out.status).toBe("fail");
    expect(out.findings[0]?.evidence).toEqual(["/cart"]);
  });

  test("a link with an accessible name passes", () => {
    expect(only("A11Y-LINK-020", ctxWith({ links: [link()] })).status).toBe("pass");
  });
});

describe("A11Y-LINK-021", () => {
  test("generic text fails, ignoring case, spaces and trailing punctuation", () => {
    const out = only(
      "A11Y-LINK-021",
      ctxWith({ links: [link({ text: "Click here.", href: "/offer" })] }),
    );
    expect(out.status).toBe("fail");
    expect(out.findings[0]?.evidence).toEqual(["/offer"]);
  });

  test.each(["here", "read more", "More", "learn more...", "link", "this", "  Here!  "])(
    "%j is generic",
    (text) => {
      expect(only("A11Y-LINK-021", ctxWith({ links: [link({ text })] })).status).toBe("fail");
    },
  );

  test.each(["Read our pricing guide", "Learn more about drainage", "Here we go", ""])(
    "%j is not generic",
    (text) => {
      expect(only("A11Y-LINK-021", ctxWith({ links: [link({ text })] })).status).toBe("pass");
    },
  );
});

describe("A11Y-BTN-030", () => {
  test("a button with no name fails", () => {
    const out = only(
      "A11Y-BTN-030",
      ctxWith({ buttons: [{ hasName: false, describe: 'button class="x"' }] }),
    );
    expect(out.status).toBe("fail");
    expect(out.findings[0]?.evidence).toEqual(['button class="x"']);
  });

  test("a named button passes", () => {
    const out = only(
      "A11Y-BTN-030",
      ctxWith({ buttons: [{ hasName: true, describe: "button Save" }] }),
    );
    expect(out.status).toBe("pass");
  });
});

describe("A11Y-HEAD-040", () => {
  test("levels 1 then 3 fail", () => {
    const out = only("A11Y-HEAD-040", ctxWith({ headings: levels([1, 3]) }));
    expect(out.status).toBe("fail");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.detail).toContain("1");
  });

  test("levels 1, 2, 2, 3, 1, 2 pass", () => {
    expect(only("A11Y-HEAD-040", ctxWith({ headings: levels([1, 2, 2, 3, 1, 2]) })).status).toBe(
      "pass",
    );
  });

  test("going back up several levels is fine", () => {
    expect(only("A11Y-HEAD-040", ctxWith({ headings: levels([1, 2, 3, 4, 1]) })).status).toBe(
      "pass",
    );
  });

  test("a page with no headings passes", () => {
    expect(only("A11Y-HEAD-040", ctxWith({ headings: [] })).status).toBe("pass");
  });
});

describe("A11Y-FRAME-050", () => {
  test("an iframe without a title fails", () => {
    const out = only(
      "A11Y-FRAME-050",
      ctxWith({ iframes: [{ hasTitle: false, src: "https://maps.example/embed" }] }),
    );
    expect(out.status).toBe("fail");
    expect(out.findings[0]?.evidence).toEqual(["https://maps.example/embed"]);
  });

  test("an iframe with a title passes", () => {
    const out = only(
      "A11Y-FRAME-050",
      ctxWith({ iframes: [{ hasTitle: true, src: "https://maps.example/embed" }] }),
    );
    expect(out.status).toBe("pass");
  });
});
