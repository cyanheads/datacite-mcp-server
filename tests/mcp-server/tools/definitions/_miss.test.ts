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

  it.each([
    ['text', 'text/x-bibliography'],
    ['csl_json', 'application/vnd.citationstyles.csl+json'],
    ['bibtex', 'application/x-bibtex'],
    ['ris', 'application/x-research-info-systems'],
  ] as const)(
    'points a %s request at the other agency’s own content negotiation for %s',
    (format, mime) => {
      const text = missGuidance(
        DOI,
        { missReason: 'other_agency', registrationAgency: 'Crossref' },
        format,
      );
      expect(text).toBe(
        `10.1038/nature12373 is registered with Crossref, not DataCite, so DataCite cannot format it. Request it from Crossref's own content negotiation at https://doi.org/10.1038/nature12373 (for example with Accept: ${mime}), or call datacite_trace_relations to find DataCite works linked to it.`,
      );
    },
  );

  it.each([
    ['datacite_json', 'DataCite JSON'],
    ['datacite_xml', 'DataCite XML'],
    ['schema_org', 'Schema.org JSON-LD'],
    ['codemeta', 'Codemeta JSON-LD'],
    ['jats', 'JATS XML'],
  ] as const)(
    'says only DataCite serves %s and points at a common format the other agency serves',
    (format, label) => {
      const text = missGuidance(
        DOI,
        { missReason: 'other_agency', registrationAgency: 'Crossref' },
        format,
      );
      expect(text).toBe(
        `10.1038/nature12373 is registered with Crossref, not DataCite, so DataCite cannot format it, and only DataCite's content negotiation serves ${label}. Request CSL JSON or BibTeX from Crossref's own content negotiation at https://doi.org/10.1038/nature12373 (for example with Accept: application/vnd.citationstyles.csl+json), or call datacite_trace_relations to find DataCite works linked to it.`,
      );
    },
  );

  it('percent-encodes the doi.org link to another agency’s DOI, keeping the DOI itself as written', () => {
    const doi = '10.1002/(sici)1097-4636(199706)35:4<460::aid-jbm6>3.0.co;2-6';
    const text = missGuidance(
      doi,
      { missReason: 'other_agency', registrationAgency: 'Crossref' },
      'text',
    );
    expect(text.startsWith(`${doi} is registered with Crossref`)).toBe(true);
    expect(text).toContain(
      'content negotiation at https://doi.org/10.1002/(sici)1097-4636(199706)35:4%3C460::aid-jbm6%3E3.0.co;2-6 (for example',
    );
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
      expect(missGuidance(DOI, { missReason }, 'bibtex')).toBe(record);
      expect(missGuidance(DOI, { missReason }, 'jats')).toBe(record);
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
