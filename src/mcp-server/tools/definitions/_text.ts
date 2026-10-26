/**
 * @fileoverview Render-time helpers for depositor- and caller-supplied text in
 * `format()`: inline slots flatten line breaks and escape literal Markdown,
 * multi-line fields become blockquotes, and machine payloads get a fence longer
 * than any backtick run inside them. A line break is every character a reader
 * may split a line on (`normalizeLineBreaks`), not just CR and LF, so none can
 * end a slot early. Titles and snippets arrive normalized; descriptions and
 * other deposited fields retain their original text in `structuredContent`.
 * @module mcp-server/tools/definitions/_text
 */

import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { htmlToDescriptionBlocks } from '@/services/datacite/html-text.js';
import { normalizeLineBreaks, singleLine } from '@/services/datacite/query-builder.js';

/** Flattens line breaks and encodes literal text for one inline Markdown slot. */
export const flattenInline = (value: string): string => escapeMarkdownInline(singleLine(value));

/**
 * A table cell uses the same literal encoder as every other inline slot.
 */
export const tableCell = flattenInline;

/** A URL as a link, without changing its destination bytes or flattening malformed values. */
export const urlLink = (value: string): string => {
  const url = URL.parse(value);
  return url &&
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    !normalizeLineBreaks(value).includes('\n')
    ? markdownLink(value, value)
    : flattenInline(value);
};

/** The value as a Markdown blockquote, one `>` per line. */
export function blockquote(value: string): string {
  const lines = normalizeLineBreaks(value).trim().split('\n');
  return lines
    .map((line, index) =>
      line.trim() === ''
        ? '>'
        : `> ${escapeMarkdownInline(line)}${lines[index + 1]?.trim() ? '\\' : ''}`,
    )
    .join('\n');
}

/** Description layout is authored here; every depositor value remains literal. */
export function descriptionQuote(value: string): string {
  return htmlToDescriptionBlocks(value)
    .map((block) =>
      block.kind === 'pre'
        ? fenced(block.text)
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : blockquote(block.text),
    )
    .join('\n>\n');
}

/**
 * A fenced code block whose fence outruns every backtick run in the payload.
 * Linear in the payload: the runs are folded, never spread into an argument
 * list. Payload whitespace is preserved, including its terminal line breaks.
 */
export function fenced(payload: string, language = ''): string {
  const longestRun = (payload.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${payload}${payload.endsWith('\n') ? '' : '\n'}${fence}`;
}

/** `value`, flattened, or the explicit marker for an absent field. */
export const orNA = (value: string | number | undefined): string =>
  value === undefined ? 'Not available' : flattenInline(String(value));

/** Thousands-grouped integer. */
export const num = (value: number): string => value.toLocaleString('en-US');

/** A thousands-grouped count, or the explicit marker when it was not reported. */
export const numOrNA = (value: number | undefined): string =>
  value === undefined ? 'Not available' : num(value);
