/**
 * @fileoverview Plain text from deposited metadata and formatted citations:
 * recognized formatting tags stripped, block boundaries separated, entities
 * decoded once, whitespace collapsed, and scientific comparisons preserved.
 * @module services/datacite/html-text
 */

import { normalizeLineBreaks } from './query-builder.js';

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

const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'del',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);

/**
 * The visible text of an HTML fragment. A tag cannot contain `<`, which keeps
 * the strip linear on a run of unclosed brackets and leaves a stray `<` as text.
 * Strip before decoding so escaped literal tags survive as text.
 */
export function htmlToText(html: string): string {
  const visible = html
    .replace(/<([^<>]*)>/g, (tag, body: string) => {
      const name = /^\/?([a-z][a-z0-9]*)(?=[\s/]|$)/i.exec(body)?.[1]?.toLowerCase();
      return name && BLOCK_TAGS.has(name) ? ' ' : name && INLINE_TAGS.has(name) ? '' : tag;
    })
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity);
  return normalizeLineBreaks(visible).replace(/\s+/g, ' ').trim();
}
