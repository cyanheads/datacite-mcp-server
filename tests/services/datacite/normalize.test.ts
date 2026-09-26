/**
 * @fileoverview Tests for the input-edge identifier normalizers: every accepted
 * form reaches its canonical shape, and anything uncertain is reported as
 * `undefined` for the caller's typed reason.
 * @module tests/services/datacite/normalize.test
 */

import { describe, expect, it } from 'vitest';
import {
  doiFromUrl,
  looksLikeFunderId,
  looksLikeOrcid,
  looksLikeRor,
  normalizeDoi,
  normalizeFunderId,
  normalizeLanguage,
  normalizeOrcid,
  normalizeRor,
} from '@/services/datacite/normalize.js';

describe('normalizeDoi', () => {
  it.each([
    '10.5061/dryad.234',
    '10.5061/DRYAD.234',
    '  10.5061/dryad.234  ',
    'doi:10.5061/dryad.234',
    'DOI: 10.5061/dryad.234',
    'info:doi/10.5061/dryad.234',
    'https://doi.org/10.5061/dryad.234',
    'http://doi.org/10.5061/dryad.234',
    'https://dx.doi.org/10.5061/Dryad.234',
    'HTTP://DX.DOI.ORG/10.5061/dryad.234',
    '10.5061%2Fdryad.234',
    'https://doi.org/10.5061%2Fdryad.234',
  ])('normalizes %j to the bare lowercase DOI', (input) => {
    expect(normalizeDoi(input)).toBe('10.5061/dryad.234');
  });

  it('keeps DOI suffix punctuation', () => {
    expect(normalizeDoi('10.1002/(SICI)1097-4636(199706)35:4<460::AID-JBM6>3.0.CO;2-6')).toBe(
      '10.1002/(sici)1097-4636(199706)35:4<460::aid-jbm6>3.0.co;2-6',
    );
    expect(normalizeDoi('10.5061/a,b')).toBe('10.5061/a,b');
  });

  it.each([
    '',
    'dryad.234',
    '10.123/too-short-registrant',
    '10.1234567890/too-long-registrant',
    '10.5061/',
    '10.5061/has space',
    'https://example.org/10.5061/dryad.234',
    'urn:doi:10.5061/dryad.234',
    '11.5061/dryad.234',
  ])('rejects %j', (input) => {
    expect(normalizeDoi(input)).toBeUndefined();
  });

  it('keeps an undecodable percent sequence verbatim rather than guessing', () => {
    expect(normalizeDoi('10.5061/100%zz')).toBe('10.5061/100%zz');
  });
});

describe('doiFromUrl', () => {
  it('reduces doi.org and dx.doi.org URLs to the DOI', () => {
    expect(doiFromUrl('https://doi.org/10.5061/DRYAD.8515')).toBe('10.5061/dryad.8515');
    expect(doiFromUrl('http://dx.doi.org/10.5061/dryad.8515')).toBe('10.5061/dryad.8515');
  });

  it('returns undefined for a bare DOI, another host, or a doi.org URL that is not a DOI', () => {
    expect(doiFromUrl('10.5061/dryad.8515')).toBeUndefined();
    expect(doiFromUrl('https://datadryad.org/10.5061/dryad.8515')).toBeUndefined();
    expect(doiFromUrl('https://doi.org/not-a-doi')).toBeUndefined();
  });
});

describe('ORCID iDs', () => {
  it.each([
    '0000-0002-1825-0097',
    '0000000218250097',
    'https://orcid.org/0000-0002-1825-0097',
    'http://www.orcid.org/0000-0002-1825-0097',
    'orcid.org/0000-0002-1825-0097',
    ' 0000-0002-1825-0097 ',
  ])('normalizes %j with a valid checksum', (input) => {
    expect(looksLikeOrcid(input)).toBe(true);
    expect(normalizeOrcid(input)).toBe('0000-0002-1825-0097');
  });

  it('accepts and uppercases an X check character', () => {
    expect(normalizeOrcid('0000-0002-1694-233x')).toBe('0000-0002-1694-233X');
  });

  it('rejects a failed checksum while still recognizing the shape', () => {
    expect(looksLikeOrcid('0000-0002-1825-0098')).toBe(true);
    expect(normalizeOrcid('0000-0002-1825-0098')).toBeUndefined();
  });

  it('does not take a name for an ORCID iD', () => {
    expect(looksLikeOrcid('Josiah Carberry')).toBe(false);
    expect(normalizeOrcid('0000-0002-1825')).toBeUndefined();
  });
});

describe('ROR IDs', () => {
  it.each([
    '021nxhr62',
    '021NXHR62',
    'ror.org/021nxhr62',
    'https://ror.org/021nxhr62',
    'https://www.ror.org/021nxhr62/',
  ])('normalizes %j to the lowercase bare id', (input) => {
    expect(looksLikeRor(input)).toBe(true);
    expect(normalizeRor(input)).toBe('021nxhr62');
  });

  it('recognizes a ror.org prefix on a malformed id and rejects it', () => {
    expect(looksLikeRor('https://ror.org/not-a-ror')).toBe(true);
    expect(normalizeRor('https://ror.org/not-a-ror')).toBeUndefined();
  });

  it('does not take a name or a 9-digit number for a ROR ID', () => {
    expect(looksLikeRor('National Science Foundation')).toBe(false);
    expect(looksLikeRor('100000001')).toBe(false);
  });
});

describe('Crossref Funder IDs', () => {
  it.each([
    '10.13039/100000001',
    'https://doi.org/10.13039/100000001',
    'http://dx.doi.org/10.13039/100000001',
    '100000001',
  ])('normalizes %j to 10.13039/<digits>', (input) => {
    expect(looksLikeFunderId(input)).toBe(true);
    expect(normalizeFunderId(input)).toBe('10.13039/100000001');
  });

  it('recognizes the prefix on a malformed id and rejects it', () => {
    expect(looksLikeFunderId('10.13039/abc')).toBe(true);
    expect(normalizeFunderId('10.13039/abc')).toBeUndefined();
  });

  it('does not take digits with a leading zero or a name for a funder id', () => {
    expect(looksLikeFunderId('0100000001')).toBe(false);
    expect(looksLikeFunderId('Wellcome Trust')).toBe(false);
  });
});

describe('normalizeLanguage', () => {
  it('lowercases an ISO 639-1 code and rejects other forms', () => {
    expect(normalizeLanguage('EN')).toBe('en');
    expect(normalizeLanguage('eng')).toBeUndefined();
    expect(normalizeLanguage('xx')).toBeUndefined();
    expect(normalizeLanguage('en-US')).toBeUndefined();
  });
});
