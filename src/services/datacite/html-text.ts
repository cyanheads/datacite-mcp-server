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

const tagName = (body: string): string | undefined =>
  /^\/?([a-z][a-z0-9]*)(?=[\s/]|$)/i.exec(body)?.[1]?.toLowerCase();

const decodeText = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity);

/**
 * The visible text of an HTML fragment. A tag cannot contain `<`, which keeps
 * the strip linear on a run of unclosed brackets and leaves a stray `<` as text.
 * Strip before decoding so escaped literal tags survive as text.
 */
export function htmlToText(html: string): string {
  const visible = decodeText(
    html.replace(/<([^<>]*)>/g, (tag, body: string) => {
      const name = tagName(body);
      return name && BLOCK_TAGS.has(name) ? ' ' : name && INLINE_TAGS.has(name) ? '' : tag;
    }),
  );
  return normalizeLineBreaks(visible).replace(/\s+/g, ' ').trim();
}

/** Description blocks separate literal prose from whitespace-sensitive pre/table content. */
export type DescriptionBlock = { kind: 'text' | 'pre'; text: string };

/** Keeps description layout while retaining compact conversion's strip-before-single-decode rule. */
export function htmlToDescriptionBlocks(html: string): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  let kind: DescriptionBlock['kind'] = 'text';
  let chunks: string[] = [];
  let listDepth = 0;
  const flush = () => {
    const decoded = normalizeLineBreaks(decodeText(chunks.join('')));
    const text = kind === 'pre' ? decoded : decoded.trim();
    if (text) blocks.push({ kind, text });
    chunks = [];
  };
  let end = 0;
  for (const match of html.matchAll(/<([^<>]*)>/g)) {
    const preceding = html.slice(end, match.index);
    if (preceding) chunks.push(preceding);
    end = match.index + match[0].length;
    const body = match[0].slice(1, -1);
    const name = tagName(body);
    const closing = body.startsWith('/');
    if (!name || (!BLOCK_TAGS.has(name) && !INLINE_TAGS.has(name))) {
      chunks.push(match[0]);
    } else if (name === 'pre' || name === 'table') {
      flush();
      kind = closing ? 'text' : 'pre';
    } else if (kind === 'pre') {
      if (closing && (name === 'td' || name === 'th')) chunks.push('\t');
      else if (closing && name === 'tr') chunks.push('\n');
      else if (name === 'br') chunks.push('\n');
    } else if (name === 'ul' || name === 'ol') {
      listDepth += closing ? -1 : 1;
      chunks.push('\n');
    } else if (name === 'li') {
      chunks.push(closing ? '\n' : `\n${'  '.repeat(Math.max(0, listDepth - 1))}• `);
    } else if (BLOCK_TAGS.has(name)) {
      if (name === 'br' || !chunks.at(-1)?.endsWith('\n'))
        chunks.push(name === 'br' ? '\n' : '\n\n');
    }
  }
  chunks.push(html.slice(end));
  flush();
  return blocks;
}
