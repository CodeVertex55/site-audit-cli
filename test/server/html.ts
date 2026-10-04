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
function filler(count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(WORDS[i % WORDS.length] ?? "word");
  return out.join(" ");
}

/**
 * Builds a fixture HTML page. Defaults produce a valid page: lang="en", viewport, title,
 * description, one h1 and 200 words of body text. Passing `null` for an option omits that
 * element. Option values are inserted as given, so tests can pass odd markup on purpose.
 */
export function page(
  opts: {
    title?: string | null;
    description?: string | null;
    lang?: string | null;
    viewport?: boolean;
    canonical?: string | null;
    head?: string;
    body?: string;
    h1?: string | null;
  } = {},
): string {
  const title = opts.title === undefined ? "Fixture page for the site audit" : opts.title;
  const description =
    opts.description === undefined
      ? "A fixture page used to test the site audit tool, with a title, a description, one heading and plain body text."
      : opts.description;
  const lang = opts.lang === undefined ? "en" : opts.lang;
  const viewport = opts.viewport ?? true;
  const h1 = opts.h1 === undefined ? "Fixture heading" : opts.h1;
  const body = opts.body ?? `<p>${filler(200)}</p>`;

  const head: string[] = ['<meta charset="utf-8">'];
  if (viewport) head.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  if (title !== null) head.push(`<title>${title}</title>`);
  if (description !== null) head.push(`<meta name="description" content="${description}">`);
  if (opts.canonical) head.push(`<link rel="canonical" href="${opts.canonical}">`);
  if (opts.head) head.push(opts.head);

  const htmlAttrs = lang === null ? "" : ` lang="${lang}"`;
  const heading = h1 === null ? "" : `<h1>${h1}</h1>\n`;
  return `<!doctype html>\n<html${htmlAttrs}>\n<head>\n${head.join("\n")}\n</head>\n<body>\n${heading}${body}\n</body>\n</html>\n`;
}
