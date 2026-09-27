/**
 * @fileoverview Tests for `unknownFieldPrefix`, which names the first `word:`
 * prefix in a caller query that is not a DataCite field.
 * @module tests/services/reference/query-syntax.test
 */

import { describe, expect, it } from 'vitest';
import {
  KNOWN_QUERY_FIELDS,
  unknownFieldPrefix,
  VERIFIED_QUERY_FIELDS,
} from '@/services/reference/query-syntax.js';

describe('unknownFieldPrefix', () => {
  it('names a word the upstream would read as a nonexistent field', () => {
    expect(unknownFieldPrefix('Climate change: impacts')).toBe('change');
    expect(unknownFieldPrefix('titles.title:glacier AND bogus:x OR other:y')).toBe('bogus');
  });

  it('accepts every verified and known field path', () => {
    for (const { value } of VERIFIED_QUERY_FIELDS) {
      expect(unknownFieldPrefix(`${value}:x`)).toBeUndefined();
    }
    for (const field of KNOWN_QUERY_FIELDS) {
      expect(unknownFieldPrefix(`(${field}:x)`)).toBeUndefined();
    }
  });

  it('finds a prefix after a parenthesis, +, -, or !', () => {
    for (const lead of ['(', '+', '-', '!']) {
      expect(unknownFieldPrefix(`titles.title:a AND ${lead}nope:b`)).toBe('nope');
    }
  });

  it('ignores colons inside quoted phrases, escaped colons, and URL schemes', () => {
    expect(unknownFieldPrefix('titles.title:"Climate change: impacts"')).toBeUndefined();
    expect(unknownFieldPrefix('"a \\"quoted\\" word: here"')).toBeUndefined();
    expect(unknownFieldPrefix('change\\: impacts')).toBeUndefined();
    expect(unknownFieldPrefix('url:https://example.org')).toBeUndefined();
    expect(unknownFieldPrefix('https://doi.org/10.5061/dryad.234')).toBeUndefined();
  });

  it('reads past an unterminated quote and honors escaped backslashes before a closing one', () => {
    expect(unknownFieldPrefix('"no closing quote bogus:x')).toBe('bogus');
    expect(unknownFieldPrefix('"closed" "open nope:x')).toBe('nope');
    expect(unknownFieldPrefix('"a\\\\" bogus:x')).toBe('bogus');
    expect(unknownFieldPrefix('"a\\\\" "b: c"')).toBeUndefined();
  });

  it('scans a long unterminated run of escaped quotes in linear time', () => {
    const start = performance.now();
    expect(unknownFieldPrefix(`"${'\\"'.repeat(50_000)} bogus:x`)).toBe('bogus');
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('returns undefined for a query with no field prefix at all', () => {
    expect(unknownFieldPrefix('glacier mass balance')).toBeUndefined();
    expect(unknownFieldPrefix('')).toBeUndefined();
  });
});
