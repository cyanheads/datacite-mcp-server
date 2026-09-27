/**
 * @fileoverview Render-time helpers for depositor- and caller-supplied text in
 * `format()`: inline slots flatten line breaks, table cells also escape `|`,
 * multi-line fields become blockquotes, and machine payloads get a fence longer
 * than any backtick run inside them. A line break is every character a reader
 * may split a line on (`normalizeLineBreaks`), not just CR and LF, so none can
 * end a slot early. `structuredContent` keeps the verbatim text.
 * @module mcp-server/tools/definitions/_text
 */

import { normalizeLineBreaks, singleLine } from '@/services/datacite/query-builder.js';

/** Collapses each run of line breaks to one space so the value stays in its inline slot. */
export const flattenInline = singleLine;

/**
 * An inline value for a Markdown table cell: flattened, with `\` and `|` escaped.
 * Backslashes go first, so one before a pipe cannot cancel the pipe's escape.
 */
export const tableCell = (value: string): string =>
  flattenInline(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/** The value as a Markdown blockquote, one `>` per line. */
export function blockquote(value: string): string {
  return normalizeLineBreaks(value)
    .trim()
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * A fenced code block whose fence outruns every backtick run in the payload.
 * Linear in the payload: the runs are folded, never spread into an argument
 * list, and trailing whitespace goes through `trimEnd`, not a backtracking regex.
 */
export function fenced(payload: string, language = ''): string {
  const longestRun = (payload.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${payload.trimEnd()}\n${fence}`;
}

/** `value`, flattened, or the explicit marker for an absent field. */
export const orNA = (value: string | number | undefined): string =>
  value === undefined ? 'Not available' : flattenInline(String(value));

/** Thousands-grouped integer. */
export const num = (value: number): string => value.toLocaleString('en-US');

/** A thousands-grouped count, or the explicit marker when it was not reported. */
export const numOrNA = (value: number | undefined): string =>
  value === undefined ? 'Not available' : num(value);
