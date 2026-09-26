/**
 * @fileoverview Tests for query-string composition: literal escaping for plain
 * text, phrases, the clause each filter becomes, the DOI forms a reverse lookup
 * ORs together, the cursor fingerprint — and, through `datacite_search_works`,
 * that fields of science reach DataCite only as `subjects.subject` phrases.
 * @module tests/services/datacite/query-builder.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { searchWorksTool } from '@/mcp-server/tools/definitions/search-works.tool.js';
import {
  affiliationNameClause,
  anyPhrase,
  composeQuery,
  doiForms,
  doiQuery,
  escapeQueryText,
  funderIdClause,
  nameTokensClause,
  orcidClause,
  phrase,
  reverseRelationQuery,
  singleLine,
  stableHash,
  yearRangeClause,
} from '@/services/datacite/query-builder.js';
import {
  FIELD_OF_SCIENCE_IDS,
  FIELDS_OF_SCIENCE,
  fieldOfScienceLabels,
  resolveFieldOfScience,
} from '@/services/reference/fields-of-science.js';
import { emptyDoiList } from '../../helpers/fixtures.js';
import {
  dataCite,
  initServices,
  json,
  requestUrl,
  teardownServices,
} from '../../helpers/harness.js';

describe('escapeQueryText', () => {
  it('escapes the colon that would otherwise turn a word into a field name', () => {
    expect(escapeQueryText('Climate change: impacts')).toBe('Climate change\\: impacts');
  });

  it('escapes every reserved character', () => {
    expect(escapeQueryText('+-=&|!(){}[]^"~*?:\\/')).toBe(
      '\\+\\-\\=\\&\\|\\!\\(\\)\\{\\}\\[\\]\\^\\"\\~\\*\\?\\:\\\\\\/',
    );
  });

  it('lowercases standalone boolean operators only', () => {
    expect(escapeQueryText('salt AND pepper OR NOT ANDROID NOTE')).toBe(
      'salt and pepper or not ANDROID NOTE',
    );
  });

  it('drops the unescapable < and > and collapses whitespace and line breaks', () => {
    expect(escapeQueryText('  a <b>\r\n c d  ')).toBe('a b c d');
  });
});

describe('phrases and clauses', () => {
  it('quotes a phrase, escaping quotes and backslashes', () => {
    expect(phrase('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  });

  it('ORs phrases within one field', () => {
    expect(anyPhrase('doi', ['a', 'b"c'])).toBe('doi:("a" OR "b\\"c")');
  });

  it('matches a name token by token within one field, splitting on commas', () => {
    expect(nameTokensClause('creators.name', 'Carberry, Josiah')).toBe(
      'creators.name:(Carberry AND Josiah)',
    );
    expect(nameTokensClause('fundingReferences.funderName', 'Wellcome (UK)')).toBe(
      'fundingReferences.funderName:(Wellcome AND \\(UK\\))',
    );
  });

  it('matches both stored forms of an ORCID iD and of a Crossref Funder ID', () => {
    expect(orcidClause('0000-0002-1825-0097')).toBe(
      'creators.nameIdentifiers.nameIdentifier:("0000-0002-1825-0097" OR "https://orcid.org/0000-0002-1825-0097")',
    );
    expect(funderIdClause('10.13039/100000001')).toBe(
      'fundingReferences.funderIdentifier:("10.13039/100000001" OR "https://doi.org/10.13039/100000001")',
    );
  });

  it('matches an affiliation name on creators and contributors', () => {
    expect(affiliationNameClause('ETH "Zürich"')).toBe(
      '(creators.affiliation.name:"ETH \\"Zürich\\"" OR contributors.affiliation.name:"ETH \\"Zürich\\"")',
    );
  });

  it('leaves an absent year bound open', () => {
    expect(yearRangeClause(2020, 2022)).toBe('publicationYear:[2020 TO 2022]');
    expect(yearRangeClause(2020)).toBe('publicationYear:[2020 TO *]');
    expect(yearRangeClause(undefined, 2022)).toBe('publicationYear:[* TO 2022]');
  });

  it('builds the exact-DOI query', () => {
    expect(doiQuery('10.5061/dryad.234')).toBe('doi:"10.5061/dryad.234"');
  });

  it('ANDs clauses, and sends * when there are none', () => {
    expect(composeQuery([])).toBe('*');
    expect(composeQuery(['a:1', 'b:2'])).toBe('a:1 AND b:2');
  });

  it('flattens every kind of line break to a space', () => {
    expect(singleLine(' a\nb\r\nc d ')).toBe('a b c d');
  });
});

describe('reverse relation lookups', () => {
  it('lists a DOI in its bare and four doi.org URL forms', () => {
    expect(doiForms('10.5061/dryad.8515')).toEqual([
      '10.5061/dryad.8515',
      'https://doi.org/10.5061/dryad.8515',
      'http://doi.org/10.5061/dryad.8515',
      'https://dx.doi.org/10.5061/dryad.8515',
      'http://dx.doi.org/10.5061/dryad.8515',
    ]);
  });

  it('ORs every form of every DOI, then narrows by relation type when asked', () => {
    const base = reverseRelationQuery(['10.1/a', '10.1/b']);
    expect(base).toBe(
      `relatedIdentifiers.relatedIdentifier:(${[...doiForms('10.1/a'), ...doiForms('10.1/b')]
        .map((form) => `"${form}"`)
        .join(' OR ')})`,
    );
    expect(reverseRelationQuery(['10.1/a'], [])).toBe(reverseRelationQuery(['10.1/a']));
    expect(reverseRelationQuery(['10.1/a'], ['IsCitedBy', 'Cites'])).toBe(
      `${reverseRelationQuery(['10.1/a'])} AND relatedIdentifiers.relationType:(IsCitedBy OR Cites)`,
    );
  });
});

describe('stableHash', () => {
  it('is deterministic and distinguishes near-identical queries', () => {
    expect(stableHash('glacier')).toBe(stableHash('glacier'));
    expect(stableHash('glacier')).not.toBe(stableHash('glaciers'));
    expect(stableHash('')).toMatch(/^[0-9a-z]+$/);
  });
});

describe('fields of science', () => {
  const COMMA_FIELDS = [
    'agriculture_forestry_and_fisheries',
    'electrical_engineering_electronic_engineering_information_engineering',
    'philosophy_ethics_and_religion',
    'arts_arts_history_of_arts_performing_arts_music',
  ] as const;

  it('covers the 6 areas and 42 fields, each resolvable from its id, label, and FOS: label', () => {
    expect(FIELD_OF_SCIENCE_IDS).toHaveLength(48);
    for (const [id, field] of FIELDS_OF_SCIENCE) {
      expect(resolveFieldOfScience(id)).toBe(id);
      expect(resolveFieldOfScience(field.label)).toBe(id);
      expect(resolveFieldOfScience(`FOS: ${field.label}`)).toBe(id);
    }
  });

  it('searches nanotechnology under its label and its stored spelling variant', () => {
    expect(fieldOfScienceLabels('nanotechnology')).toEqual(['Nanotechnology', 'Nano-technology']);
    expect(resolveFieldOfScience('fos:nano-technology')).toBe('nanotechnology');
  });

  it('keeps the commas and parentheses of the four labels that carry them', () => {
    expect(COMMA_FIELDS.map((id) => fieldOfScienceLabels(id))).toEqual([
      ['Agriculture, forestry, and fisheries'],
      ['Electrical engineering, electronic engineering, information engineering'],
      ['Philosophy, ethics and religion'],
      ['Arts (arts, history of arts, performing arts, music)'],
    ]);
  });

  describe('in datacite_search_works', () => {
    afterEach(teardownServices);

    it('sends fields of science only as subjects.subject "FOS: …" phrases, never field-of-science', async () => {
      const { http } = initServices([{ match: dataCite('/dois'), respond: json(emptyDoiList()) }]);
      const result = await runToolContract(searchWorksTool, {
        fields_of_science: ['FOS: Nano-technology', 'nanotechnology', ...COMMA_FIELDS],
      });
      expect(result.isError).toBeFalsy();
      const url = requestUrl(http);
      expect(url.searchParams.get('query')).toBe(
        'subjects.subject:("FOS: Nanotechnology" OR "FOS: Nano-technology" OR ' +
          '"FOS: Agriculture, forestry, and fisheries" OR ' +
          '"FOS: Electrical engineering, electronic engineering, information engineering" OR ' +
          '"FOS: Philosophy, ethics and religion" OR ' +
          '"FOS: Arts (arts, history of arts, performing arts, music)")',
      );
      expect([...url.searchParams.keys()].filter((key) => /field|fos/i.test(key))).toEqual([
        'fields[dois]',
      ]);
    });
  });
});
