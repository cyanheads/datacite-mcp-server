/**
 * @fileoverview Render-time helpers for depositor- and caller-supplied text in
 * `format()`: inline slots flatten line breaks, table cells also escape `|`,
 * multi-line fields become blockquotes, and machine payloads get a fence longer
 * than any backtick run inside them. `structuredContent` keeps the verbatim text.
 * @module mcp-server/tools/definitions/_text
 */

const LINE_BREAK_RE = /[\r\n\p{Zl}\p{Zp}]+/gu;

/** Collapses every line break to a space so the value stays in its inline slot. */
export const flattenInline = (value: string): string => value.replace(LINE_BREAK_RE, ' ').trim();

/** An inline value for a Markdown table cell: flattened, with `|` escaped. */
export const tableCell = (value: string): string => flattenInline(value).replace(/\|/g, '\\|');

/** The value as a Markdown blockquote, one `>` per line. */
export function blockquote(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

/** A fenced code block whose fence outruns every backtick run in the payload. */
export function fenced(payload: string, language = ''): string {
  const longestRun = Math.max(0, ...(payload.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${payload.replace(/\s+$/, '')}\n${fence}`;
}

/** `value`, flattened, or the explicit marker for an absent field. */
export const orNA = (value: string | number | undefined): string =>
  value === undefined ? 'Not available' : flattenInline(String(value));

/** Thousands-grouped integer. */
export const num = (value: number): string => value.toLocaleString('en-US');

/** A thousands-grouped count, or the explicit marker when it was not reported. */
export const numOrNA = (value: number | undefined): string =>
  value === undefined ? 'Not available' : num(value);
