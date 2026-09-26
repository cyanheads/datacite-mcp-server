/**
 * @fileoverview Tests for the guidance a `found: false` answer carries per miss
 * reason, and the miss-arm output fields both tools share.
 * @module tests/mcp-server/tools/definitions/_miss.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { MISS_REASONS, missFields, missGuidance } from '@/mcp-server/tools/definitions/_miss.js';

const DOI = '10.1038/nature12373';

describe('missGuidance', () => {
  it('routes another agency’s DOI to trace_relations for a record lookup', () => {
    expect(
      missGuidance(DOI, { missReason: 'other_agency', registrationAgency: 'Crossref' }, 'record'),
    ).toBe(
      '10.1038/nature12373 is registered with Crossref, not DataCite, so DataCite holds no deposited metadata for it. To find DataCite datasets or software linked to it, call datacite_trace_relations with this DOI.',
    );
  });

  it('points a citation request at the other agency’s own content negotiation', () => {
    const text = missGuidance(
      DOI,
      { missReason: 'other_agency', registrationAgency: 'Crossref' },
      'citation',
    );
    expect(text).toContain(
      "Request it from Crossref's own content negotiation at https://doi.org/10.1038/nature12373",
    );
    expect(text).toContain('Accept: text/x-bibliography');
    expect(text).toContain('datacite_trace_relations');
  });

  it.each([
    { missReason: 'does_not_exist', expected: 'No agency has registered 10.1038/nature12373.' },
    { missReason: 'not_public', expected: 'is a DataCite DOI without public (Findable) metadata' },
    { missReason: 'unclassified', expected: 'the registration-agency lookup did not answer' },
  ] as const)(
    'names the next step for $missReason, whatever the purpose',
    ({ missReason, expected }) => {
      const record = missGuidance(DOI, { missReason }, 'record');
      expect(record).toContain(expected);
      expect(record).toContain('datacite_search_works');
      expect(missGuidance(DOI, { missReason }, 'citation')).toBe(record);
    },
  );
});

describe('missFields', () => {
  const schema = z.object(missFields);

  it('lists the four miss reasons', () => {
    expect(MISS_REASONS).toEqual(['other_agency', 'does_not_exist', 'not_public', 'unclassified']);
  });

  it('accepts a miss arm, an empty found arm, and rejects an unknown reason', () => {
    expect(
      schema.parse({ registrationAgency: 'Crossref', missReason: 'other_agency', guidance: 'g' }),
    ).toEqual({ registrationAgency: 'Crossref', missReason: 'other_agency', guidance: 'g' });
    expect(schema.parse({})).toEqual({});
    expect(schema.safeParse({ missReason: 'gone' }).success).toBe(false);
  });
});
