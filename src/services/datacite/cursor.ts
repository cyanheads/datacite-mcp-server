/**
 * @fileoverview The server-owned work-search cursor: base64url JSON wrapping
 * DataCite's cursor token verbatim, the fingerprint of the query it belongs to,
 * the `created` instant of the page's last row, and the rows the walk has
 * delivered. Validation never parses the upstream token, whose format is
 * undocumented.
 * @module services/datacite/cursor
 */

import { base64ToString, stringToBase64 } from '@cyanheads/mcp-ts-core/utils';

/** The decoded envelope. */
export interface WorkCursor {
  /** Epoch ms of the last row's `created` on the page that issued the cursor. */
  c: number;
  /** Rows the walk delivered through the page that issued the cursor. */
  n: number;
  /** Fingerprint of the composed query and filters. */
  q: string;
  /** DataCite's `page[cursor]` token, verbatim. */
  t: string;
  v: 1;
}

/**
 * A non-negative safe integer — the only form an issued `c` or `n` takes. JSON
 * alone admits negatives, fractions, and `1e400`, which parses as `Infinity`.
 */
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Encodes an envelope as base64url. */
export function encodeCursor(cursor: Omit<WorkCursor, 'v'>): string {
  return stringToBase64(JSON.stringify({ v: 1, ...cursor }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decodes a cursor this server issued, or `undefined` for anything else. The
 * token stays opaque: any non-empty string passes, as DataCite may issue it.
 */
export function decodeCursor(value: string): WorkCursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(
      base64ToString(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')),
    );
    if (typeof parsed !== 'object' || parsed === null) return;
    const { v, t, q, c, n } = parsed as Record<string, unknown>;
    if (
      v !== 1 ||
      typeof t !== 'string' ||
      t === '' ||
      typeof q !== 'string' ||
      !isCount(c) ||
      !isCount(n)
    ) {
      return;
    }
    return { v, t, q, c, n };
  } catch {
    return;
  }
}

/** DataCite's cursor token from a `links.next` URL, if the page has a successor. */
export function upstreamCursorToken(nextLink: string | null | undefined): string | undefined {
  if (!nextLink) return;
  try {
    return new URL(nextLink).searchParams.get('page[cursor]') ?? undefined;
  } catch {
    return;
  }
}
