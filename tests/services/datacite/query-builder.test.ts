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
  NAME_PROXIMITY_SLOP,
  nameProximityClause,
  orcidClause,
  PLACE_SUBSTRING_MAX_CHARS,
  phrase,
  placeClause,
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
  OTHER_LINE_BREAKS,
  requestUrl,
  teardownServices,
} from '../../helpers/harness.js';

describe('escapeQueryText', () => {
  it('escapes the colon that would otherwise turn a word into a field name', () => {
    expect(escapeQueryText('Climate change: impacts')).toBe('Climate change\\: impacts');
  });

  it('escapes every reserved character', () => {
    expect(escapeQueryText('+-=&|!(){}[]^"~*?:\\')).toBe(
      '\\+\\-\\=\\&\\|\\!\\(\\)\\{\\}\\[\\]\\^\\"\\~\\*\\?\\:\\\\',
    );
  });

  it('leaves / bare, since DataCite escapes it itself and a pre-escaped \\/ fails to parse', () => {
    expect(escapeQueryText('10.5061/dryad.234 input/output')).toBe(
      '10.5061/dryad.234 input/output',
    );
    expect(escapeQueryText('a\\/b')).toBe('a\\\\/b');
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

  it('keeps the name slop below the 100 positions DataCite leaves between array values', () => {
    expect(NAME_PROXIMITY_SLOP).toBe(50);
  });

  it.each([
    { name: 'Carberry, Josiah', sent: '"Carberry, Josiah"~50' },
    { name: 'Woodhouse', sent: '"Woodhouse"~50' },
    { name: 'Smith\\', sent: '"Smith\\\\"~50' },
    { name: 'O"Brien', sent: '"O\\"Brien"~50' },
    { name: 'NASA/JPL', sent: '"NASA/JPL"~50' },
    { name: 'Wellcome (UK): AND <J> [x] *?~^!', sent: '"Wellcome (UK): AND <J> [x] *?~^!"~50' },
    { name: `a\r\nb${String.fromCodePoint(0x2028, 0x2029)}c`, sent: '"a b c"~50' },
  ])('matches name $name as one proximity phrase, escaping only " and \\', ({ name, sent }) => {
    expect(nameProximityClause('creators.name', name)).toBe(`creators.name:${sent}`);
    expect(nameProximityClause('fundingReferences.funderName', name)).toBe(
      `fundingReferences.funderName:${sent}`,
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

  it.each(OTHER_LINE_BREAKS)('flattens %s, and a run of breaks, to one space', (_name, sep) => {
    expect(singleLine(`a${sep}b${sep}\r\n${sep}c`)).toBe('a b c');
  });

  it('flattens every kind of line break to a space', () => {
    expect(singleLine(' a\nb\r\nc d ')).toBe('a b c d');
  });
});

describe('placeClause', () => {
  const field = 'geoLocations.geoLocationPlace:';

  it.each([
    { place: 'norway', terms: ['*norway*', '*NORWAY*', '*Norway*'] },
    { place: 'Svalbard', terms: ['*Svalbard*', '*svalbard*', '*SVALBARD*'] },
    {
      place: 'NEW YORK',
      terms: ['*NEW\\ YORK*', '*new\\ york*', '*New\\ York*', '*New\\ york*'],
    },
    {
      place: 'Gulf of Mexico',
      terms: [
        '*Gulf\\ of\\ Mexico*',
        '*gulf\\ of\\ mexico*',
        '*GULF\\ OF\\ MEXICO*',
        '*Gulf\\ Of\\ Mexico*',
        '*Gulf\\ of\\ mexico*',
      ],
    },
    { place: 'a', terms: ['*a*', '*A*'] },
    { place: '123', terms: ['*123*'] },
  ])('ORs the distinct case forms of $place, as typed first', ({ place, terms }) => {
    expect(placeClause(place)).toEqual({
      clause: `${field}(${terms.join(' OR ')})`,
      match: 'substring',
    });
  });

  it('keeps uppercase AND, OR, and NOT as typed, inside the term', () => {
    expect(placeClause('Yaquina Bay, OR').clause).toBe(
      `${field}(*Yaquina\\ Bay,\\ OR* OR *yaquina\\ bay,\\ or* OR *YAQUINA\\ BAY,\\ OR* OR *Yaquina\\ Bay,\\ Or* OR *Yaquina\\ bay,\\ or*)`,
    );
    expect(placeClause('Salt AND Pepper NOT').clause).toContain('*Salt\\ AND\\ Pepper\\ NOT*');
  });

  it('capitalizes each word after any separator but an apostrophe', () => {
    expect(placeClause('BADEN-WÜRTTEMBERG (de)').clause).toContain(
      '*Baden\\-Württemberg\\ \\(De\\)*',
    );
    expect(placeClause("ST. JOHN'S").clause).toContain("*St.\\ John's*");
    expect(placeClause('3RD AVENUE').clause).toBe(
      `${field}(*3RD\\ AVENUE* OR *3rd\\ avenue* OR *3rd\\ Avenue*)`,
    );
    expect(placeClause('(gulf of mexico)').clause).toContain('*\\(Gulf\\ of\\ mexico\\)*');
  });

  it('starts no word after a curly apostrophe or a combining mark', () => {
    expect(placeClause('CÔTE D’IVOIRE').clause).toContain('*Côte\\ D’ivoire*');
    // É decomposed: E, then U+0301 COMBINING ACUTE ACCENT, a mark rather than a letter.
    expect(placeClause('QUÉBEC CITY').clause).toContain('*Québec\\ City*');
  });

  it('matches a whitespace run, tab and no-break space included, as typed and as one space', () => {
    const nbsp = String.fromCodePoint(0xa0);
    const collapsed = placeClause('Gulf of Mexico');
    expect(placeClause(`Gulf${nbsp}of \t Mexico`)).toEqual({
      clause: collapsed.clause.replace(
        `${field}(`,
        `${field}(*Gulf\\${nbsp}of\\ \\\t\\ Mexico* OR `,
      ),
      match: 'substring',
    });
  });

  it('still matches a deposited name holding a double space when typed exactly', () => {
    // Deposited verbatim on 10.21233/n36x3b; an exact phrase of the value matches it.
    const deposited = 'Site name: Site 30 (Delcourt  et al. 1983); Berrien; Georgia; United States';
    expect(placeClause(deposited).clause).toContain(
      '*Site\\ name\\:\\ Site\\ 30\\ \\(Delcourt\\ \\ et\\ al.\\ 1983\\);\\ Berrien;\\ Georgia;\\ United\\ States*',
    );
  });

  it('measures the as-typed form against the cap too, so a value over it never matches as a substring', () => {
    const value = `Gulf${' '.repeat(11)}${'of Mexico '.repeat(24)}`.trim();
    expect(value.replace(/\s+/g, ' ').length).toBeLessThanOrEqual(PLACE_SUBSTRING_MAX_CHARS);
    expect(value.length).toBeGreaterThan(PLACE_SUBSTRING_MAX_CHARS);
    expect(placeClause(value)).toEqual({ clause: `${field}${phrase(value)}`, match: 'exact' });
  });

  it(`matches as a substring up to ${PLACE_SUBSTRING_MAX_CHARS} characters per case form, and exactly past that`, () => {
    expect(PLACE_SUBSTRING_MAX_CHARS).toBe(250);
    const atCap = 'a'.repeat(250);
    expect(placeClause(atCap)).toEqual({
      clause: `${field}(*${atCap}* OR *${atCap.toUpperCase()}* OR *A${'a'.repeat(249)}*)`,
      match: 'substring',
    });
    const pastCap = `Gulf  of "${'a('.repeat(124)}`;
    expect(pastCap).toHaveLength(258);
    expect(placeClause(pastCap)).toEqual({
      clause: `${field}${phrase(pastCap)}`,
      match: 'exact',
    });
    // ß uppercases to SS, so 200 of them make a 400-character form.
    expect(placeClause('ß'.repeat(200)).match).toBe('exact');
  });

  it.each([
    { place: '*', term: '*\\**' },
    { place: '?', term: '*\\?*' },
    { place: 'Sval*bard?', term: '*Sval\\*bard\\?*' },
    { place: '+-=&|!(){}[]^"~:\\', term: '*\\+\\-\\=\\&\\|\\!\\(\\)\\{\\}\\[\\]\\^\\"\\~\\:\\\\*' },
    { place: '<', term: '*<*' },
    { place: '>', term: '*>*' },
    { place: 'Oslo/Akershus', term: '*Oslo/Akershus*' },
  ])(
    'matches $place literally: reserved characters and spaces escaped, / < > bare',
    ({ place, term }) => {
      const { clause, match } = placeClause(place);
      expect(match).toBe('substring');
      expect(clause.startsWith(`${field}(${term}`)).toBe(true);
      expect(clause).not.toMatch(/[( ]\*\*[ )]/);
    },
  );

  /**
   * Timeout 0: the body is synchronous, so vitest can't interrupt it and only compares wall time
   * after it returns. Per-call thread CPU stops a super-linear regression; each larger size is
   * paired with a fresh baseline and the least growth of several pairs is kept, since a
   * garbage-collection pause or a slower core only ever adds time.
   */
  it('bounds place and name clause thread CPU across 64-fold value growth', () => {
    const BASE = 5000;
    const perCallMicros = (build: (value: string) => string, value: string, calls: number) => {
      const start = process.threadCpuUsage();
      for (let call = 0; call < calls; call++) build(value);
      const cpu = process.threadCpuUsage(start);
      return Math.max(1, cpu.user + cpu.system) / calls;
    };
    const builders = {
      place: (value: string) => placeClause(value).clause,
      name: (value: string) => nameProximityClause('creators.name', value),
    };
    const shapes = {
      digits: (n: number) => '1'.repeat(n),
      'one long line, then a break': (n: number) => `${'§1 x'.repeat(n / 4)}\ny`,
      'breaks throughout': (n: number) => '  \r\n'.repeat(n / 4),
      'apostrophes and words': (n: number) => "o'b ".repeat(n / 4),
      'reserved characters': (n: number) => '*?(\\'.repeat(n / 4),
      'quotes and backslashes': (n: number) => '"\\'.repeat(n / 2),
    };
    for (const [builderName, build] of Object.entries(builders)) {
      for (const [shapeName, shape] of Object.entries(shapes)) {
        const base = shape(BASE);
        const growth: number[] = [];
        for (let size = BASE * 2; size <= BASE * 64; size *= 2) {
          const value = shape(size);
          let least = Number.POSITIVE_INFINITY;
          for (let pair = 0; pair < 5; pair++) {
            const baseMicros = perCallMicros(build, base, size / BASE);
            const sizeMicros = perCallMicros(build, value, 1);
            expect(sizeMicros).toBeLessThan(250_000);
            least = Math.min(least, sizeMicros / baseMicros);
          }
          // Linear growth is size / BASE; the bound allows 4× that before the next size runs.
          expect(least).toBeLessThan((4 * size) / BASE);
          growth.push(Number(least.toFixed(1)));
        }
        console.info(
          'clause CPU growth',
          process.versions.bun ? 'Bun' : 'Node',
          builderName,
          shapeName,
          growth,
        );
      }
    }
  }, 0);
});

describe('reverse relation lookups', () => {
  it('pairs both assertion paths with their own type restrictions', () => {
    const query = reverseRelationQuery(['10.1/a'], ['IsPartOf']);
    expect(query).toContain('relatedItems.relatedItemIdentifier.relatedItemIdentifier:');
    expect(query).toContain('AND relatedItems.relationType:(IsPartOf)');
    expect(query).toContain(') OR (');
  });
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
    expect(base).toContain(
      `relatedIdentifiers.relatedIdentifier:(${[...doiForms('10.1/a'), ...doiForms('10.1/b')]
        .map((form) => `"${form}"`)
        .join(' OR ')})`,
    );
    expect(reverseRelationQuery(['10.1/a'], [])).toBe(reverseRelationQuery(['10.1/a']));
    const filtered = reverseRelationQuery(['10.1/a'], ['IsCitedBy', 'Cites']);
    expect(filtered).toContain('AND relatedIdentifiers.relationType:(IsCitedBy OR Cites)');
    expect(filtered).toContain('AND relatedItems.relationType:(IsCitedBy OR Cites)');
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
