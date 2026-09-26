/**
 * @fileoverview Tests for the shared input-schema blocks: blank-as-unset for
 * form clients, canonicalizing enums, blank-entry-tolerant arrays, and the
 * identifier patterns that admit every raw form a handler normalizes.
 * @module tests/mcp-server/tools/definitions/_schemas.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  blankAsUnset,
  doiString,
  enumish,
  optionalArray,
  optionalString,
  providerIdString,
  repositoryIdString,
} from '@/mcp-server/tools/definitions/_schemas.js';
import { RESOURCE_TYPE_IDS, resolveResourceType } from '@/services/reference/vocabularies.js';

const issues = (result: { error?: z.ZodError; success: boolean }) =>
  result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? []);

describe('blankAsUnset', () => {
  const schema = blankAsUnset(z.number().int().min(1).max(100).default(20));

  it('treats a blank or whitespace-only string as unset, so the default applies', () => {
    expect(schema.parse('')).toBe(20);
    expect(schema.parse('   ')).toBe(20);
    expect(schema.parse(undefined)).toBe(20);
  });

  it('passes every other value to the inner schema unchanged', () => {
    expect(schema.parse(7)).toBe(7);
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse('7').success).toBe(false);
  });
});

describe('optionalString', () => {
  it('trims, and treats blank as unset', () => {
    const schema = optionalString();
    expect(schema.parse('  glacier  ')).toBe('glacier');
    expect(schema.parse('')).toBeUndefined();
    expect(schema.parse(' \t ')).toBeUndefined();
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.safeParse(5).success).toBe(false);
  });

  it('runs the inner check on the trimmed value', () => {
    const schema = optionalString(z.string().regex(/^[a-z]+$/));
    expect(schema.parse(' abc ')).toBe('abc');
    expect(schema.safeParse('ab c').success).toBe(false);
  });
});

describe('doiString', () => {
  const schema = doiString();

  it.each([
    ['10.5061/dryad.234', '10.5061/dryad.234'],
    ['  10.5061/DRYAD.234  ', '10.5061/DRYAD.234'],
    ['doi:10.5061/dryad.234', 'doi:10.5061/dryad.234'],
    ['DOI: 10.5061/dryad.234', 'DOI: 10.5061/dryad.234'],
    ['info:doi/10.5061/dryad.234', 'info:doi/10.5061/dryad.234'],
    ['INFO:DOI/10.5061/dryad.234', 'INFO:DOI/10.5061/dryad.234'],
    ['https://doi.org/10.5061/dryad.234', 'https://doi.org/10.5061/dryad.234'],
    ['HTTP://DX.DOI.ORG/10.5061/dryad.234', 'HTTP://DX.DOI.ORG/10.5061/dryad.234'],
    ['10.5061%2Fdryad.234', '10.5061%2Fdryad.234'],
  ])('admits %j (trimmed to %j) for the handler to normalize', (input, parsed) => {
    expect(schema.parse(input)).toBe(parsed);
  });

  it('lets a near-miss DOI through, so the handler can answer it with invalid_doi', () => {
    expect(schema.safeParse('10.12/x').success).toBe(true);
    expect(schema.safeParse('10.5061/').success).toBe(true);
  });

  it.each(['', 'dryad.234', 'urn:doi:10.5061/x', 'https://example.org/10.5061/x', '10.5061/a b'])(
    'rejects %j naming the accepted forms',
    (input) => {
      const messages = issues(schema.safeParse(input));
      expect(messages).toEqual([
        expect.stringContaining('Expected a DOI such as 10.5061/dryad.234'),
      ]);
      expect(messages[0]).toContain('datacite_search_works');
    },
  );
});

describe('repository and provider id patterns', () => {
  it('admits a provider.repository id in any case, trimmed', () => {
    expect(repositoryIdString().parse(' ETHZ.WGMS ')).toBe('ETHZ.WGMS');
    expect(repositoryIdString().parse('cern.zenodo-2')).toBe('cern.zenodo-2');
  });

  it.each(['dryad', 'a.b.c', 'a_b.c', '.x', ''])('rejects the repository id %j', (input) => {
    expect(issues(repositoryIdString().safeParse(input))).toEqual([
      expect.stringContaining('Expected a repository id shaped provider.repository'),
    ]);
  });

  it('admits a provider id of letters, digits, and hyphens, and rejects anything else', () => {
    expect(providerIdString().parse(' KADQ ')).toBe('KADQ');
    expect(issues(providerIdString().safeParse('ethz.wgms'))).toEqual([
      expect.stringContaining('Expected a provider id of letters, digits, and hyphens'),
    ]);
  });
});

describe('enumish', () => {
  const schema = enumish(RESOURCE_TYPE_IDS, resolveResourceType);

  it('canonicalizes case, punctuation, and spaced labels before the enum check', () => {
    for (const input of [
      'journal-article',
      'JournalArticle',
      'journal_article',
      ' Journal Article ',
    ]) {
      expect(schema.parse(input)).toBe('journal-article');
    }
  });

  it('rejects an unknown value through the advertised enum', () => {
    const result = schema.safeParse('podcast');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('invalid_value');
    expect(schema.safeParse(3).success).toBe(false);
  });
});

describe('optionalArray', () => {
  const schema = optionalArray(z.string(), 2);

  it('drops blank entries before the length check', () => {
    expect(schema.parse(['a', '', '  ', 'b'])).toEqual(['a', 'b']);
  });

  it('treats an empty or all-blank array as unset', () => {
    expect(schema.parse([])).toBeUndefined();
    expect(schema.parse(['', ' '])).toBeUndefined();
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it('enforces the maximum on the kept entries and rejects a non-array', () => {
    expect(schema.safeParse(['a', 'b', 'c']).success).toBe(false);
    expect(schema.safeParse('a').success).toBe(false);
  });
});
