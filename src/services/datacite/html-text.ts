/**
 * @fileoverview Plain text from the small HTML subset a formatted citation
 * carries (`<i>`, `<b>`, small-caps `<span>`, entities): tags stripped, entities
 * decoded, whitespace collapsed.
 * @module services/datacite/html-text
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: String.fromCodePoint(0xa0),
  ndash: String.fromCodePoint(0x2013),
  mdash: String.fromCodePoint(0x2014),
  lsquo: String.fromCodePoint(0x2018),
  rsquo: String.fromCodePoint(0x2019),
  ldquo: String.fromCodePoint(0x201c),
  rdquo: String.fromCodePoint(0x201d),
  hellip: String.fromCodePoint(0x2026),
  thinsp: String.fromCodePoint(0x2009),
};

function decodeEntity(entity: string, body: string): string {
  if (body.startsWith('#')) {
    const codePoint =
      body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number(body.slice(1));
    return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  }
  return Object.hasOwn(NAMED_ENTITIES, body) ? (NAMED_ENTITIES[body] as string) : entity;
}

/** The visible text of an HTML fragment. */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim();
}
