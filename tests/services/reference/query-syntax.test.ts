/**
 * @fileoverview Tests for the verified field paths `datacite_list_reference`
 * lists — the place and deposited-coordinate entries — and `unknownFieldPrefix`,
 * which names the first `word:` prefix in a caller query that is not a DataCite field.
 * @module tests/services/reference/query-syntax.test
 */

import { describe, expect, it } from 'vitest';
import { reverseRelationQuery } from '@/services/datacite/query-builder.js';
import {
  KNOWN_QUERY_FIELDS,
  unknownFieldPrefix,
  VERIFIED_QUERY_FIELDS,
} from '@/services/reference/query-syntax.js';

/** The verified entry for the place field, as datacite_list_reference lists it. */
const PLACE_FIELD_DESCRIPTION =
  'Place name exactly as deposited, case-sensitive: "Svalbard" matches neither "svalbard" nor "Svalbard, Norway". Wildcards match a substring, with spaces escaped (geoLocations.geoLocationPlace:*Gulf\\ of\\ Mexico*).';

describe('VERIFIED_QUERY_FIELDS', () => {
  it('describes geoLocations.geoLocationPlace as an exact, case-sensitive name with wildcards for substrings', () => {
    expect(
      VERIFIED_QUERY_FIELDS.find((field) => field.value === 'geoLocations.geoLocationPlace'),
    ).toEqual({ value: 'geoLocations.geoLocationPlace', description: PLACE_FIELD_DESCRIPTION });
  });

  describe('deposited coordinates', () => {
    /** The eight paths, each verified live as a numeric range field. */
    const COORDINATE_PATHS = [
      'geoLocations.geoLocationPoint.pointLatitude',
      'geoLocations.geoLocationPoint.pointLongitude',
      'geoLocations.geoLocationBox.westBoundLongitude',
      'geoLocations.geoLocationBox.eastBoundLongitude',
      'geoLocations.geoLocationBox.southBoundLatitude',
      'geoLocations.geoLocationBox.northBoundLatitude',
      'geoLocations.geoLocationPolygon.polygonPoint.pointLatitude',
      'geoLocations.geoLocationPolygon.polygonPoint.pointLongitude',
    ];
    const coordinateFields = VERIFIED_QUERY_FIELDS.filter((field) =>
      COORDINATE_PATHS.includes(field.value),
    );

    it('lists all eight coordinate paths, after the place field', () => {
      expect(coordinateFields.map((field) => field.value)).toEqual(COORDINATE_PATHS);
      const values = VERIFIED_QUERY_FIELDS.map((field) => field.value);
      expect(values.indexOf(COORDINATE_PATHS[0] as string)).toBe(
        values.indexOf('geoLocations.geoLocationPlace') + 1,
      );
    });

    it.each(COORDINATE_PATHS)(
      'describes %s as numeric, ranged with a bare negative bound, and pooled across locations',
      (path) => {
        const description = coordinateFields.find((field) => field.value === path)?.description;
        expect(description).toContain('in decimal degrees, numeric');
        expect(description).toMatch(new RegExp(`${path.replaceAll('.', '\\.')}:\\[[^\\]]*-\\d`));
        expect(description).not.toContain('\\-');
        expect(description).toContain(
          "A work's locations are indexed as one flat list, so clauses ANDed on two coordinate paths can each match a different location or polygon vertex; datacite_search_works bbox flags such works with inBbox false.",
        );
      },
    );

    it('treats every coordinate path as a known field, so a zero-hit range on one names no unknown field', () => {
      for (const path of COORDINATE_PATHS) {
        expect(KNOWN_QUERY_FIELDS.has(path)).toBe(true);
        expect(unknownFieldPrefix(`${path}:[-90 TO -89]`)).toBeUndefined();
      }
    });
  });
});

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
    const start = process.threadCpuUsage();
    expect(unknownFieldPrefix(`"${'\\"'.repeat(50_000)} bogus:x`)).toBe('bogus');
    const cpu = process.threadCpuUsage(start);
    expect(cpu.user + cpu.system).toBeLessThan(250_000);
  });

  it('returns undefined for a query with no field prefix at all', () => {
    expect(unknownFieldPrefix('glacier mass balance')).toBeUndefined();
    expect(unknownFieldPrefix('')).toBeUndefined();
  });
});

describe('rights URIs, _exists_, and the related-item paths the server queries', () => {
  it('lists rightsList.rightsUri as a case-sensitive field that a wildcard reaches in every URI form', () => {
    expect(VERIFIED_QUERY_FIELDS.find((field) => field.value === 'rightsList.rightsUri')).toEqual({
      value: 'rightsList.rightsUri',
      description:
        'License or rights URI exactly as deposited, case-sensitive; the licenses filter reads only rightsIdentifier. Wildcards match a substring, so one path covers http and https, deed and legalcode forms (rightsList.rightsUri:*creativecommons.org/licenses/by/4.0*).',
    });
  });

  it.each([
    'rightsList.rightsUri:*creativecommons.org/licenses/by/4.0*',
    'doi:"10.5281/zenodo.24415496" AND rightsList.rightsUri:"https://creativecommons.org/licenses/by-nc/4.0/"',
    '_exists_:rightsList.bogusField',
    'rightsList.rightsUri:*creativecommons.org* AND NOT _exists_:rightsList.rightsIdentifier',
    'relatedItems.relationType:IsPublishedIn',
    'relatedItems.relatedItemIdentifier.relatedItemIdentifier:"10.5555/x"',
  ])('names no unknown field in %j', (query) => {
    expect(unknownFieldPrefix(query)).toBeUndefined();
  });

  it('knows every field path of the reverse-relation query the server builds', () => {
    expect(unknownFieldPrefix(reverseRelationQuery(['10.5555/x'], ['IsCitedBy']))).toBeUndefined();
  });
});
