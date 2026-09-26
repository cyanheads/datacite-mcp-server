/**
 * @fileoverview Tests for the server-owned work-search cursor envelope: base64url
 * round trip, rejection of anything this server did not issue, and extraction of
 * DataCite's token from `links.next` without parsing it.
 * @module tests/services/datacite/cursor.test
 */

import { stringToBase64 } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, upstreamCursorToken } from '@/services/datacite/cursor.js';
import type { RawDoiList } from '@/services/datacite/types.js';
import { fixtureJson } from '../../helpers/fixtures.js';

/** An arbitrary JSON value encoded the way the server encodes envelopes. */
const encodeRaw = (value: unknown): string =>
  stringToBase64(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('encodeCursor / decodeCursor', () => {
  it('round-trips an envelope through URL-safe base64 without padding', () => {
    const cursor = {
      t: 'MTMxNDc4NTc3OTAwMCwxMC4xNTk0L3dkY2MvbWJfaHNnXzIwMDdfMjAxMA',
      q: 'abc123',
      c: 1314785779000,
    };
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual({ v: 1, ...cursor });
  });

  it('survives tokens whose base64 needs the URL-safe alphabet and padding', () => {
    for (const t of ['?>?', 'a', 'ab', 'abc', 'ü~~~']) {
      expect(decodeCursor(encodeCursor({ t, q: 'q', c: 0 }))?.t).toBe(t);
    }
  });

  it.each([
    { name: 'the "*" start marker', value: '*' },
    { name: 'standard base64 characters', value: `${encodeCursor({ t: 'x', q: 'q', c: 1 })}+/=` },
    { name: 'garbage', value: 'notavalidtoken' },
    { name: 'the empty string', value: '' },
    { name: 'non-JSON base64', value: encodeRaw('x').slice(0, 2) },
    { name: 'a JSON string', value: encodeRaw('cursor') },
    { name: 'JSON null', value: encodeRaw(null) },
    { name: 'another envelope version', value: encodeRaw({ v: 2, t: 'x', q: 'q', c: 1 }) },
    { name: 'an empty token', value: encodeRaw({ v: 1, t: '', q: 'q', c: 1 }) },
    { name: 'a missing query hash', value: encodeRaw({ v: 1, t: 'x', c: 1 }) },
    { name: 'a string created instant', value: encodeRaw({ v: 1, t: 'x', q: 'q', c: '1' }) },
  ])('rejects $name', ({ value }) => {
    expect(decodeCursor(value)).toBeUndefined();
  });
});

describe('upstreamCursorToken', () => {
  it("reads DataCite's page[cursor] token verbatim from links.next", () => {
    const page = fixtureJson<RawDoiList>('datacite/works/cursor-first.json');
    expect(upstreamCursorToken(page.links?.next)).toBe(
      'MTMxNDc4NTc3OTAwMCwxMC4xNTk0L3dkY2MvbWJfaHNnXzIwMDdfMjAxMA',
    );
  });

  it('returns undefined on the last page, a link without a cursor, or a malformed link', () => {
    expect(upstreamCursorToken(undefined)).toBeUndefined();
    expect(upstreamCursorToken(null)).toBeUndefined();
    expect(upstreamCursorToken('')).toBeUndefined();
    expect(upstreamCursorToken('https://api.datacite.org/dois?page%5Bnumber%5D=2')).toBeUndefined();
    expect(upstreamCursorToken('not a url')).toBeUndefined();
  });
});
