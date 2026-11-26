/**
 * @fileoverview Tests for the raw DataCite → output mappers: recorded search
 * rows, the full dryad.234 record, repository accounts, list caps, dropped
 * incomplete entries, and sparse records whose absent values must stay absent.
 * @module tests/services/datacite/mappers.test
 */

import { describe, expect, it } from 'vitest';
import {
  mapRepository,
  mapWork,
  mapWorkRow,
  publicationYear,
  RECORD_LIST_CAPS,
} from '@/services/datacite/mappers.js';
import type {
  RawClientResource,
  RawDoiAttributes,
  RawDoiList,
  RawDoiResource,
  RawRepositoryList,
} from '@/services/datacite/types.js';
import { fixtureJson } from '../../helpers/fixtures.js';

const record = (attributes: RawDoiAttributes, client?: string): RawDoiResource => ({
  id: attributes.doi ?? '10.5555/constructed',
  type: 'dois',
  attributes,
  ...(client && { relationships: { client: { data: { id: client, type: 'clients' } } } }),
});

const clientsOf = (list: RawDoiList) =>
  new Map((list.included ?? []).map((client) => [client.id, client]));

describe('mapWorkRow', () => {
  it('normalizes title and snippet before the surrogate-safe snippet cap', () => {
    const row = mapWorkRow(
      record({
        titles: [{ title: '<em>A</em> &amp; B' }],
        descriptions: [{ description: `<p>${'a'.repeat(299)}&#x1f600;tail</p>` }],
      }),
      new Map(),
    );
    expect(row.title).toBe('A & B');
    expect(row.descriptionSnippet).toBe(`${'a'.repeat(299)}…`);
  });
  const page = fixtureJson<RawDoiList>('datacite/works/search-glacier.json');

  it('maps a recorded search hit, with repository and provider from the included client', () => {
    expect(mapWorkRow(page.data[0] as RawDoiResource, clientsOf(page))).toEqual({
      doi: '10.48580/dgwv7',
      title: 'Cryptocalciella – a new Mortierellaceae genus from Alpine glacier forefields',
      creators: [
        'Mandolini, Edoardo',
        'Szedlacsek, Sophie',
        'Abramczyk, Beniamin',
        'Szucs, Attila',
        'Staykova, Anastasiya',
      ],
      creatorCount: 10,
      publicationYear: 2026,
      resourceTypeGeneral: 'Dataset',
      resourceType: 'Dataset',
      publisher: 'Plazi',
      repositoryId: 'gbif.col',
      repositoryName: 'The Catalogue of Life',
      providerId: 'gbif',
      licenses: [],
      citationCount: 0,
      viewCount: 0,
      downloadCount: 0,
      versionCount: 1,
      landingUrl: 'https://www.checklistbank.org/dataset/314394',
    });
  });

  it('never derives the provider from the repository id prefix', () => {
    const row = mapWorkRow(page.data[0] as RawDoiResource, new Map());
    expect(row.repositoryId).toBe('gbif.col');
    expect(row).not.toHaveProperty('providerId');
    expect(row).not.toHaveProperty('repositoryName');
  });

  it('keeps every absent value absent on a sparse record, counts included', () => {
    expect(mapWorkRow({ id: '10.5555/SPARSE', type: 'dois', attributes: {} }, new Map())).toEqual({
      doi: '10.5555/sparse',
      creators: [],
      creatorCount: 0,
      licenses: [],
    });
  });

  it('keeps a reported zero count and omits a count DataCite did not report', () => {
    const row = mapWorkRow(
      record({ citationCount: 0, viewCount: null, downloadCount: 3 }),
      new Map(),
    );
    expect(row).toMatchObject({ citationCount: 0, downloadCount: 3 });
    expect(row).not.toHaveProperty('viewCount');
    expect(row).not.toHaveProperty('versionCount');
  });

  it('reads created, and leaves a blank or missing one absent', () => {
    expect(mapWorkRow(record({ created: '2011-08-26T08:33:28Z' }), new Map()).created).toBe(
      '2011-08-26T08:33:28Z',
    );
    expect(mapWorkRow(record({ created: '  ' }), new Map())).not.toHaveProperty('created');
    expect(mapWorkRow(record({ created: null }), new Map())).not.toHaveProperty('created');
  });

  it('skips blank titles, names, and license ids and reads the publisher object form', () => {
    const row = mapWorkRow(
      record({
        doi: '10.5555/X',
        titles: [{ title: '  ' }, { title: ' Second title ' }],
        creators: [{ name: '' }, { name: 'Carberry, Josiah' }],
        publisher: { name: 'Dryad', publisherIdentifier: 'https://ror.org/00x6h5n95' },
        rightsList: [{ rightsIdentifier: '' }, { rightsIdentifier: 'cc-by-4.0' }, { rights: 'x' }],
        publicationYear: '2019',
        version: '2',
        citationCount: 7,
      }),
      new Map(),
    );
    expect(row).toMatchObject({
      doi: '10.5555/x',
      title: 'Second title',
      creators: ['Carberry, Josiah'],
      creatorCount: 1,
      publisher: 'Dryad',
      licenses: ['cc-by-4.0'],
      publicationYear: 2019,
      version: '2',
      citationCount: 7,
    });
  });

  it('snips the first abstract, else the first description, to 300 characters', () => {
    const long = `${'word '.repeat(70)}tail`;
    const withAbstract = mapWorkRow(
      record({
        descriptions: [
          { description: 'Series note', descriptionType: 'SeriesInformation' },
          { description: '   ', descriptionType: 'Abstract' },
          { description: long, descriptionType: 'Abstract' },
        ],
      }),
      new Map(),
    );
    expect(withAbstract.descriptionSnippet).toBe(`${long.slice(0, 300).trimEnd()}…`);
    const fallback = mapWorkRow(
      record({ descriptions: [{ description: '' }, { description: 'Methods only.' }] }),
      new Map(),
    );
    expect(fallback.descriptionSnippet).toBe('Methods only.');
    const exact = mapWorkRow(
      record({ descriptions: [{ description: 'x'.repeat(300) }] }),
      new Map(),
    );
    expect(exact.descriptionSnippet).toBe('x'.repeat(300));
  });

  it('never splits a surrogate pair at the snippet boundary', () => {
    const row = mapWorkRow(
      record({ descriptions: [{ description: `${'a'.repeat(299)}\u{1F600}${'b'.repeat(10)}` }] }),
      new Map(),
    );
    expect(row.descriptionSnippet).toBe(`${'a'.repeat(299)}…`);
  });
});

describe('publicationYear', () => {
  it('reads numbers and numeric strings, and leaves non-years absent', () => {
    expect(publicationYear({ publicationYear: 2009 })).toBe(2009);
    expect(publicationYear({ publicationYear: '2009' })).toBe(2009);
    expect(publicationYear({ publicationYear: ' 2009 ' })).toBe(2009);
    expect(publicationYear({ publicationYear: null })).toBeUndefined();
    expect(publicationYear({})).toBeUndefined();
    expect(publicationYear({ publicationYear: 'n.d.' })).toBeUndefined();
    expect(publicationYear({ publicationYear: '2009.5' })).toBeUndefined();
    expect(publicationYear({ publicationYear: 2009.5 })).toBeUndefined();
  });

  it.each(['', '  ', '1e3', '0x7D9'])(
    'leaves the non-digit year string %j absent instead of converting it',
    (value) => {
      expect(publicationYear({ publicationYear: value })).toBeUndefined();
    },
  );
});

describe('mapWork', () => {
  it('maps the captured polygon-only geometry before selected-list counting', () => {
    const captured = fixtureJson<RawDoiList>('datacite/works/polygon-1223849.json');
    const mapped = mapWork(captured.data[0]!, undefined, { list: 'geoLocations', offset: 0 });
    expect(mapped.work.geoLocations).toEqual([
      {
        polygon: {
          points: [
            { latitude: 37, longitude: -103 },
            { latitude: 31.4, longitude: -103 },
            { latitude: 31.4, longitude: -109.1 },
            { latitude: 37, longitude: -109.1 },
            { latitude: 37, longitude: -103 },
          ],
        },
      },
    ]);
    expect(mapped.listPage).toEqual({ list: 'geoLocations', offset: 0, total: 1 });
    expect(mapped.omittedGeoLocationPolygons).toBe(0);
  });
  const list = fixtureJson<RawDoiList>('datacite/works/record-dryad-234.json');
  const raw = list.data[0] as RawDoiResource;
  const client = list.included?.[0] as RawClientResource;

  it('maps the recorded dryad.234 record, normalizing affiliation and publisher ROR IDs', () => {
    const { doi, work, truncatedLists } = mapWork(raw, client);
    expect(doi).toBe('10.5061/dryad.234');
    expect(truncatedLists).toEqual([]);
    expect(work).toMatchObject({
      doiUrl: 'https://doi.org/10.5061/dryad.234',
      landingUrl: 'https://datadryad.org/dataset/doi:10.5061/dryad.234',
      titles: [{ title: 'Data from: Towards a worldwide wood economics spectrum' }],
      publisher: { name: 'Dryad', rorId: '00x6h5n95' },
      publicationYear: 2009,
      resourceTypeGeneral: 'Dataset',
      resourceType: 'dataset',
      version: '5',
      language: 'en',
      rights: [
        {
          rights: 'Creative Commons Zero v1.0 Universal',
          rightsUri: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode',
          rightsIdentifier: 'cc0-1.0',
        },
      ],
      metadataLicense: 'CC0-1.0',
      sizes: ['2123413 bytes'],
      formats: [],
      alternateIdentifiers: [],
      relatedIdentifiers: [
        {
          relationType: 'IsCitedBy',
          relatedIdentifier: '10.1111/j.1461-0248.2009.01285.x',
          relatedIdentifierType: 'DOI',
        },
      ],
      relatedIdentifierCounts: { IsCitedBy: 1 },
      relatedItems: [],
      counts: {
        citationCount: 264,
        referenceCount: 1,
        versionCount: 0,
        versionOfCount: 0,
        partCount: 1,
        partOfCount: 0,
        viewCount: 56788,
        downloadCount: 21834,
      },
      repository: { repositoryId: 'dryad.dryad', name: 'DRYAD', providerId: 'dryad' },
      registered: '2010-06-08T02:26:02Z',
      created: '2011-11-22T17:26:55Z',
      updated: '2026-01-27T16:21:55Z',
      schemaVersion: 'http://datacite.org/schema/kernel-4',
    });
    expect(work.creators).toHaveLength(10);
    expect(work.creators[0]).toEqual({
      name: 'Zanne, Amy E.',
      nameType: 'Personal',
      givenName: 'Amy E.',
      familyName: 'Zanne',
      otherIdentifiers: [],
      affiliations: [{ name: 'University of Missouri–St. Louis', rorId: '037cnag11' }],
    });
    expect(work.contributors).toEqual([]);
    expect(work.dates).toHaveLength(3);
    expect(work.subjects).toHaveLength(4);
    expect(work.descriptions.map((d) => d.descriptionType)).toEqual(['Abstract', 'Other']);
    expect(work).not.toHaveProperty('contentUrls');
  });

  it('keeps the repository id without a name or provider when no client was included', () => {
    expect(mapWork(raw, undefined).work.repository).toEqual({ repositoryId: 'dryad.dryad' });
  });

  it('normalizes one checksum-valid ORCID iD per person and keeps every other identifier', () => {
    const { work } = mapWork(
      record({
        creators: [
          {
            givenName: 'Josiah',
            familyName: 'Carberry',
            nameIdentifiers: [
              { nameIdentifier: '0000-0002-1825-0098', nameIdentifierScheme: 'ORCID' },
              {
                nameIdentifier: 'https://orcid.org/0000-0002-1825-0097',
                nameIdentifierScheme: 'orcid',
              },
              { nameIdentifier: '0000-0002-1694-233X', nameIdentifierScheme: 'ORCID' },
              { nameIdentifier: '0000 0001 2281 955X', nameIdentifierScheme: 'ISNI' },
              { nameIdentifier: '  ' },
            ],
            affiliation: [
              {
                name: 'Brown University',
                affiliationIdentifier: 'https://ror.org/05gq02987',
                affiliationIdentifierScheme: 'ror',
              },
              {
                name: 'Elsewhere',
                affiliationIdentifier: 'https://ror.org/05gq02987',
                affiliationIdentifierScheme: 'GRID',
              },
              {
                name: '',
                affiliationIdentifier: 'https://ror.org/05gq02987',
                affiliationIdentifierScheme: 'ROR',
              },
            ],
          },
          { name: '  ' },
        ],
        contributors: [{ name: 'Data Manager', contributorType: 'DataManager' }],
      }),
      undefined,
    );
    expect(work.creators).toEqual([
      {
        name: 'Josiah Carberry',
        givenName: 'Josiah',
        familyName: 'Carberry',
        orcid: '0000-0002-1825-0097',
        otherIdentifiers: [
          { identifier: '0000-0002-1825-0098', scheme: 'ORCID' },
          { identifier: '0000-0002-1694-233X', scheme: 'ORCID' },
          { identifier: '0000 0001 2281 955X', scheme: 'ISNI' },
        ],
        affiliations: [{ name: 'Brown University', rorId: '05gq02987' }, { name: 'Elsewhere' }],
      },
    ]);
    expect(work.contributors).toEqual([
      {
        name: 'Data Manager',
        contributorType: 'DataManager',
        otherIdentifiers: [],
        affiliations: [],
      },
    ]);
  });

  it('caps long lists, reporting each full count, and leaves a list at its cap untruncated', () => {
    const many = <T>(n: number, make: (i: number) => T): T[] =>
      Array.from({ length: n }, (_, i) => make(i));
    const { work, truncatedLists } = mapWork(
      record({
        creators: many(120, (i) => ({ name: `Creator ${i}` })),
        contributors: many(100, (i) => ({ name: `Contributor ${i}` })),
        relatedIdentifiers: many(130, (i) => ({
          relationType: i % 2 ? 'Cites' : 'IsPartOf',
          relatedIdentifier: `10.5555/r${i}`,
        })),
        relatedItems: many(30, (i) => ({
          relationType: 'IsPublishedIn',
          titles: [{ title: `Item ${i}` }],
        })),
        subjects: many(101, (i) => ({ subject: `Subject ${i}` })),
        fundingReferences: many(100, (i) => ({ funderName: `Funder ${i}` })),
        geoLocations: many(60, (i) => ({ geoLocationPlace: `Place ${i}` })),
      }),
      undefined,
    );
    expect(truncatedLists).toEqual([
      { field: 'creators', shown: 100, total: 120, nextOffset: 100 },
      { field: 'subjects', shown: 100, total: 101, nextOffset: 100 },
      { field: 'geoLocations', shown: 50, total: 60, nextOffset: 50 },
      {
        field: 'relatedIdentifiers',
        shown: 100,
        total: 130,
        nextOffset: 100,
        byRelationType: [
          { relationType: 'IsPartOf', shown: 50, total: 65, nextOffset: 50 },
          { relationType: 'Cites', shown: 50, total: 65, nextOffset: 50 },
        ],
      },
      { field: 'relatedItems', shown: 25, total: 30, nextOffset: 25 },
    ]);
    expect(work.creators).toHaveLength(RECORD_LIST_CAPS.creators);
    expect(work.contributors).toHaveLength(100);
    expect(work.fundingReferences).toHaveLength(100);
    expect(work.relatedIdentifiers).toHaveLength(100);
    expect(work.relatedIdentifierCounts).toEqual({ IsPartOf: 65, Cites: 65 });
    expect(work.relatedItems).toHaveLength(25);
    expect(work.geoLocations).toHaveLength(50);
  });

  describe('relatedIdentifiers by relation type', () => {
    /** An irregular interleave, with depositor spellings outside the vocabulary mixed in. */
    const typeAt = (i: number) =>
      i % 7 === 0 ? 'IsCitedBy' : i % 5 === 0 ? 'isPartOf' : i % 3 === 0 ? 'HasPart' : 'Cites';
    /** `count` entries typed by `typeAt`, then one Other and one blank-identifier Reviews. */
    const deposit = (count: number) =>
      record({
        relatedIdentifiers: [
          ...Array.from({ length: count }, (_, i) => ({
            relationType: typeAt(i),
            relatedIdentifier: `10.5555/r${i}`,
          })),
          { relationType: 'Other', relatedIdentifier: '10.5555/other' },
          { relationType: 'Reviews', relatedIdentifier: '  ' },
        ],
      });
    const mixed = deposit(250);
    const ids = (entries: Array<{ relatedIdentifier: string }> | undefined) =>
      (entries ?? []).map((r) => r.relatedIdentifier);

    it('continues each vocabulary type past the capped prefix from exactly its shown count', () => {
      const { work, truncatedLists } = mapWork(mixed, undefined);
      const entry = truncatedLists.find((t) => t.field === 'relatedIdentifiers');
      const prefix = work.relatedIdentifiers;
      // Every valid entry in deposit order: the blank-identifier Reviews entry is not one.
      const deposited = (mixed.attributes.relatedIdentifiers ?? []).filter((r) =>
        r.relatedIdentifier?.trim(),
      );
      expect(entry).toMatchObject({ shown: 100, total: 251, nextOffset: 100 });
      // Every type with entries past the cap, in relatedIdentifierCounts order; isPartOf is depositor
      // spelling no relation_types value matches, so it gets no per-type continuation.
      expect(Object.keys(work.relatedIdentifierCounts)).toEqual([
        'IsCitedBy',
        'Cites',
        'HasPart',
        'isPartOf',
        'Other',
      ]);
      expect(work.relatedIdentifierCounts).toEqual({
        IsCitedBy: 36,
        Cites: 114,
        HasPart: 58,
        isPartOf: 42,
        Other: 1,
      });
      // The first 100 deposits hold 15 IsCitedBy, 45 Cites, 23 HasPart, and no Other.
      expect(entry?.byRelationType).toEqual([
        { relationType: 'IsCitedBy', shown: 15, total: 36, nextOffset: 15 },
        { relationType: 'Cites', shown: 45, total: 114, nextOffset: 45 },
        { relationType: 'HasPart', shown: 23, total: 58, nextOffset: 23 },
        { relationType: 'Other', shown: 0, total: 1, nextOffset: 0 },
      ]);
      for (const typed of entry?.byRelationType ?? []) {
        const inPrefix = ids(prefix.filter((r) => r.relationType === typed.relationType));
        const ofType = deposited
          .filter((r) => r.relationType === typed.relationType)
          .map((r) => r.relatedIdentifier);
        expect(inPrefix).toHaveLength(typed.shown);
        const page = mapWork(mixed, undefined, {
          list: 'relatedIdentifiers',
          offset: typed.nextOffset,
          relationTypes: [typed.relationType],
        });
        const filteredAll = mapWork(mixed, undefined, {
          list: 'relatedIdentifiers',
          offset: 0,
          relationTypes: [typed.relationType],
        });
        // The shown prefix is exactly the first `shown` entries of the filtered list, so the
        // continuation neither repeats nor skips one.
        expect(ids(filteredAll.work.relatedIdentifiers).slice(0, typed.shown)).toEqual(inPrefix);
        expect(ids(page.work.relatedIdentifiers)[0]).toBe(ofType[typed.shown]);
        expect(page.listPage).toMatchObject({
          list: 'relatedIdentifiers',
          relationTypes: [typed.relationType],
          offset: typed.nextOffset,
          total: typed.total,
        });
      }
    });

    it('filters before paging, in deposit order, and leaves the counts and other lists whole', () => {
      // 400 deposits hold 149 HasPart or IsCitedBy entries: more than one page from offset 30.
      const long = deposit(400);
      const all = mapWork(long, undefined);
      const selection = {
        list: 'relatedIdentifiers',
        relationTypes: ['HasPart', 'IsCitedBy'],
      } as const;
      const page = mapWork(long, undefined, { ...selection, offset: 30 });
      const expected = Array.from({ length: 400 }, (_, i) => i)
        .filter((i) => typeAt(i) === 'HasPart' || typeAt(i) === 'IsCitedBy')
        .map((i) => `10.5555/r${i}`);
      expect(expected).toHaveLength(149);
      expect(ids(page.work.relatedIdentifiers)).toEqual(expected.slice(30, 130));
      expect(page.listPage).toEqual({ ...selection, offset: 30, total: 149, nextOffset: 130 });
      expect(page.work.relatedIdentifierCounts).toEqual(all.work.relatedIdentifierCounts);
      expect(page.truncatedLists).toEqual([]);
      // The second page continues the filtered list from nextOffset to its end.
      const second = mapWork(long, undefined, { ...selection, offset: 130 });
      expect(ids(second.work.relatedIdentifiers)).toEqual(expected.slice(130));
      expect(second.listPage).toEqual({ ...selection, offset: 130, total: 149 });
      const none = mapWork(mixed, undefined, {
        list: 'relatedIdentifiers',
        offset: 0,
        relationTypes: ['IsDerivedFrom'],
      });
      expect(none.work.relatedIdentifiers).toEqual([]);
      expect(none.listPage).toEqual({
        list: 'relatedIdentifiers',
        relationTypes: ['IsDerivedFrom'],
        offset: 0,
        total: 0,
      });
    });
  });

  it('drops list entries missing their identifying field and counts only the kept relations', () => {
    const { work } = mapWork(
      record({
        relatedIdentifiers: [
          {
            relationType: 'Cites',
            relatedIdentifier: '10.5555/kept',
            relatedIdentifierType: 'DOI',
          },
          { relationType: 'Cites', relatedIdentifier: '  ' },
          { relatedIdentifier: '10.5555/no-type' },
          { relationType: 'IsCitedBy' },
        ],
        fundingReferences: [
          { funderName: '', awardNumber: '1' },
          { funderName: 'NSF', awardNumber: '2' },
        ],
        dates: [
          { date: '2020', dateType: '' },
          { date: '2021', dateType: 'Issued' },
        ],
        relatedItems: [{ relatedItemType: 'Book' }, { relationType: 'IsPublishedIn' }],
        identifiers: [
          { identifier: 'abc', identifierType: '' },
          { identifier: 'ark:/1/2', identifierType: 'ARK' },
        ],
        rightsList: [{ rights: ' ', rightsUri: null }, { rightsUri: 'https://example.org/l' }],
        titles: [{ title: '' }, { title: 'Kept', lang: 'en' }],
        subjects: [{ subject: '' }, { subject: 'Glaciology', subjectScheme: 'Keywords' }],
        descriptions: [{ description: ' ' }],
        sizes: ['', '1 MB'],
        formats: [' ', 'text/csv'],
      }),
      undefined,
    );
    expect(work.relatedIdentifiers).toEqual([
      { relationType: 'Cites', relatedIdentifier: '10.5555/kept', relatedIdentifierType: 'DOI' },
    ]);
    expect(work.relatedIdentifierCounts).toEqual({ Cites: 1 });
    expect(work.fundingReferences).toEqual([{ funderName: 'NSF', awardNumber: '2' }]);
    expect(work.dates).toEqual([{ date: '2021', dateType: 'Issued' }]);
    expect(work.relatedItems).toEqual([{ relationType: 'IsPublishedIn' }]);
    expect(work.alternateIdentifiers).toEqual([{ identifier: 'ark:/1/2', identifierType: 'ARK' }]);
    expect(work.rights).toEqual([{ rightsUri: 'https://example.org/l' }]);
    expect(work.titles).toEqual([{ title: 'Kept', lang: 'en' }]);
    expect(work.subjects).toEqual([{ subject: 'Glaciology', scheme: 'Keywords' }]);
    expect(work.descriptions).toEqual([]);
    expect(work.sizes).toEqual(['1 MB']);
    expect(work.formats).toEqual(['text/csv']);
  });

  describe('relatedItems', () => {
    const recorded = fixtureJson<RawDoiList>('datacite/works/related-items.json');
    const itemsOf = (doi: string) => {
      const raw = recorded.data.find((r) => r.id === doi);
      if (!raw) throw new Error(`No recorded record for ${doi}.`);
      return mapWork(raw, undefined).work.relatedItems;
    };
    /** A recorded related person: given and family names, no identifiers or affiliations. */
    const person = (familyName: string, givenName: string, extra: Record<string, string> = {}) => ({
      name: `${familyName}, ${givenName}`,
      ...extra,
      givenName,
      familyName,
      otherIdentifiers: [],
      affiliations: [],
    });

    it('carries the recorded volume, issue, number, pages, publisher, year, and people', () => {
      expect(itemsOf('10.15162/rde.v2i2.2688')).toStrictEqual([
        {
          relationType: 'IsPublishedIn',
          relatedItemType: 'Journal',
          identifier: '3103-845X',
          identifierType: 'ISSN',
          title: 'Rassegna di Diritto dell’Economia',
          volume: '2',
          issue: '2',
          firstPage: '133',
          lastPage: '161',
        },
      ]);
      expect(itemsOf('10.3205/000367')).toStrictEqual([
        {
          relationType: 'IsPublishedIn',
          relatedItemType: 'Journal',
          identifier: '1612-3174',
          identifierType: 'ISSN',
          title: 'GMS German Medical Science',
          volume: '24',
          number: 'Doc14',
          numberType: 'Article',
          publicationYear: 2026,
        },
      ]);
      expect(itemsOf('10.83394/978-3-913202-00-6_011')).toStrictEqual([
        {
          relationType: 'IsPublishedIn',
          relatedItemType: 'Book',
          identifier: '10.83394/978-3-913202-00-6',
          identifierType: 'DOI',
          title: 'Journalists in Fiction',
          publisher: 'Freiburg University Publishing',
          publicationYear: 2026,
          creators: [person('Korte', 'Barbara'), person('Valverde', 'Beatriz')],
        },
      ]);
      expect(itemsOf('10.11588/edition.klee.klee_korr_fk_340106')).toStrictEqual([
        {
          relationType: 'IsVariantFormOf',
          relatedItemType: 'Text',
          title: 'Familienkorrespondenz Klee: Brief von Felix Klee an Lily Klee und Paul Klee',
          publicationYear: 1934,
          creators: [person('Klee', 'Felix', { nameType: 'Personal' })],
          contributors: [
            person('Klee', 'Lily', { nameType: 'Personal', contributorType: 'RelatedPerson' }),
            person('Klee', 'Paul', { nameType: 'Personal', contributorType: 'RelatedPerson' }),
          ],
        },
        {
          relationType: 'IsPartOf',
          relatedItemType: 'Text',
          identifier: 'urn:nbn:de:bsz:16-diglit-527578',
          identifierType: 'URN',
          title: 'Familienkorrespondenz Klee',
          creators: [{ name: ':none', otherIdentifiers: [], affiliations: [] }],
        },
      ]);
    });

    it.each([
      [2026, 2026],
      ['2026', 2026],
      [' 1934 ', 1934],
      [2026.5, undefined],
      ['2026a', undefined],
      ['n.d.', undefined],
      ['1e3', undefined],
      ['', undefined],
      [null, undefined],
      [Number.NaN, undefined],
      [Number.POSITIVE_INFINITY, undefined],
    ])('reads a related item publicationYear of %j as %j', (value, expected) => {
      const { work } = mapWork(
        record({ relatedItems: [{ relationType: 'IsPartOf', publicationYear: value }] }),
        undefined,
      );
      expect(work.relatedItems).toStrictEqual([
        { relationType: 'IsPartOf', ...(expected !== undefined && { publicationYear: expected }) },
      ]);
    });

    it('maps related people as record people and leaves undeposited fields absent', () => {
      const { work } = mapWork(
        record({
          relatedItems: [
            {
              relationType: 'IsPublishedIn',
              creators: [],
              contributors: [{ name: ' ' }],
              publisher: ' ',
              volume: '',
              titles: [],
            },
            {
              relationType: 'IsPartOf',
              volume: ' 12 ',
              number: '0',
              firstPage: '0:i',
              lastPage: '0:xviii',
              edition: '2nd',
              creators: [
                {
                  name: 'Carberry, Josiah',
                  nameType: 'Personal',
                  contributorType: 'Editor',
                  nameIdentifiers: [
                    {
                      nameIdentifier: 'https://orcid.org/0000-0002-1825-0097',
                      nameIdentifierScheme: 'ORCID',
                    },
                    { nameIdentifier: '0000 0001 2281 955X', nameIdentifierScheme: 'ISNI' },
                  ],
                  affiliation: [
                    {
                      name: 'Brown University',
                      affiliationIdentifier: 'https://ror.org/05gq02987',
                      affiliationIdentifierScheme: 'ROR',
                    },
                  ],
                },
                { name: '' },
              ],
              contributors: [
                { givenName: 'Lily', familyName: 'Klee', contributorType: 'RelatedPerson' },
                { name: 'Anon' },
              ],
            },
          ],
        }),
        undefined,
      );
      expect(work.relatedItems).toStrictEqual([
        { relationType: 'IsPublishedIn' },
        {
          relationType: 'IsPartOf',
          volume: '12',
          number: '0',
          firstPage: '0:i',
          lastPage: '0:xviii',
          edition: '2nd',
          creators: [
            {
              name: 'Carberry, Josiah',
              nameType: 'Personal',
              orcid: '0000-0002-1825-0097',
              otherIdentifiers: [{ identifier: '0000 0001 2281 955X', scheme: 'ISNI' }],
              affiliations: [{ name: 'Brown University', rorId: '05gq02987' }],
            },
          ],
          contributors: [
            {
              name: 'Lily Klee',
              givenName: 'Lily',
              familyName: 'Klee',
              contributorType: 'RelatedPerson',
              otherIdentifiers: [],
              affiliations: [],
            },
            { name: 'Anon', otherIdentifiers: [], affiliations: [] },
          ],
        },
      ]);
    });
  });

  it('counts a relation type named like an Object.prototype member as its own key', () => {
    const types = ['constructor', '__proto__', 'toString', 'constructor'];
    const { work } = mapWork(
      record({
        relatedIdentifiers: types.map((relationType, i) => ({
          relationType,
          relatedIdentifier: `10.5555/r${i}`,
          relatedIdentifierType: 'DOI',
        })),
      }),
      undefined,
    );
    expect(Object.entries(work.relatedIdentifierCounts)).toEqual([
      ['constructor', 2],
      ['__proto__', 1],
      ['toString', 1],
    ]);
    expect(Object.getPrototypeOf(work.relatedIdentifierCounts)).toBe(Object.prototype);
  });

  it('reads geolocations from numbers or numeric strings and drops ones with nothing usable', () => {
    const { work } = mapWork(
      record({
        geoLocations: [
          { geoLocationPoint: { pointLatitude: '46.5', pointLongitude: 8 } },
          {
            geoLocationBox: {
              westBoundLongitude: -10,
              eastBoundLongitude: '10',
              southBoundLatitude: 40,
              northBoundLatitude: 50,
            },
            geoLocationPlace: 'Alps',
          },
          {
            geoLocationBox: {
              westBoundLongitude: 1,
              eastBoundLongitude: 2,
              southBoundLatitude: '',
            },
          },
          { geoLocationPoint: { pointLatitude: 'north', pointLongitude: 8 } },
          { geoLocationPlace: '  ' },
        ],
      }),
      undefined,
    );
    expect(work.geoLocations).toEqual([
      { point: { latitude: 46.5, longitude: 8 } },
      { place: 'Alps', box: { west: -10, east: 10, south: 40, north: 50 } },
    ]);
  });

  it('accepts contentUrl as a string or a list, and a publisher as a plain string', () => {
    const single = mapWork(
      record({ contentUrl: 'https://x.org/a.csv', publisher: 'Dryad' }),
      undefined,
    );
    expect(single.work.contentUrls).toEqual(['https://x.org/a.csv']);
    expect(single.work.publisher).toEqual({ name: 'Dryad' });
    const listed = mapWork(
      record({ contentUrl: ['https://x.org/a', ' ', 'https://x.org/b'] }),
      undefined,
    );
    expect(listed.work.contentUrls).toEqual(['https://x.org/a', 'https://x.org/b']);
  });

  it('keeps a non-ROR publisher identifier out of rorId', () => {
    const { work } = mapWork(
      record({
        publisher: {
          name: 'Zenodo',
          publisherIdentifier: 'https://ror.org/01ggx4157',
          publisherIdentifierScheme: 'Wikidata',
        },
      }),
      undefined,
    );
    expect(work.publisher).toEqual({ name: 'Zenodo' });
  });
});

describe('mapRepository', () => {
  const accounts = fixtureJson<RawRepositoryList>('datacite/repositories/ids-ethz-wgms-dryad.json');

  it('maps a recorded account, omitting what it does not declare', () => {
    const dryad = accounts.data.find((a) => a.id === 'dryad.dryad') as RawClientResource;
    expect(mapRepository(dryad)).toEqual({
      repositoryId: 'dryad.dryad',
      name: 'DRYAD',
      providerId: 'dryad',
      clientType: 'repository',
      repositoryTypes: [],
      certificates: [],
      subjects: [],
      language: [],
      url: 'https://datadryad.org',
      re3data: 'https://doi.org/10.17616/R34S33',
      description: dryad.attributes.description?.trim(),
      year: 2018,
      isActive: true,
    });
  });

  it('reads the provider from the relationship, not the id prefix', () => {
    const wgms = accounts.data.find((a) => a.id === 'ethz.wgms') as RawClientResource;
    expect(mapRepository(wgms).providerId).toBe('kadq');
  });

  it('degrades a sparse account to its id with empty lists', () => {
    expect(mapRepository({ id: 'x.y', type: 'clients', attributes: {} })).toEqual({
      repositoryId: 'x.y',
      name: 'x.y',
      repositoryTypes: [],
      certificates: [],
      subjects: [],
      language: [],
    });
  });
});

describe('names, publishers, funders, and subject terms as plain text', () => {
  /** A recognized tag, named and numeric references, a reference encoded twice, and a line break: what the title conversion strips, decodes once, and collapses. */
  const RAW = ' <i>Kipp</i> &amp;\nZonen &#8211; &beta;-ray &amp;gt;1 ';
  const PLAIN = 'Kipp & Zonen – β-ray &gt;1';

  it('converts every name, publisher, funder, and subject field of a full record the way titles are converted', () => {
    const { work } = mapWork(
      record({
        subjects: [{ subject: RAW }, { subject: '<br/>' }],
        publisher: { name: RAW },
        creators: [
          { name: RAW, givenName: RAW, familyName: RAW, affiliation: [{ name: RAW }] },
          { name: '<span></span>' },
          { name: '<span></span>', givenName: 'Josiah', familyName: 'Carberry' },
        ],
        contributors: [{ name: RAW, contributorType: 'Editor', affiliation: [{ name: RAW }] }],
        fundingReferences: [{ funderName: RAW }],
        relatedItems: [
          {
            relationType: 'IsPublishedIn',
            publisher: RAW,
            creators: [{ name: RAW, affiliation: [{ name: RAW }] }],
            contributors: [{ givenName: RAW, familyName: 'Str&ouml;m', contributorType: 'Editor' }],
          },
        ],
      }),
      undefined,
    );
    const [creator, composed] = work.creators;
    const [item] = work.relatedItems;
    expect({
      subjects: work.subjects,
      publisher: work.publisher,
      creatorCount: work.creators.length,
      creatorName: creator?.name,
      composedCreatorName: composed?.name,
      creatorGivenName: creator?.givenName,
      creatorFamilyName: creator?.familyName,
      creatorAffiliations: creator?.affiliations,
      contributorName: work.contributors[0]?.name,
      contributorAffiliations: work.contributors[0]?.affiliations,
      funderName: work.fundingReferences[0]?.funderName,
      itemPublisher: item?.publisher,
      itemCreatorName: item?.creators?.[0]?.name,
      itemCreatorAffiliations: item?.creators?.[0]?.affiliations,
      itemContributor: item?.contributors?.[0],
    }).toStrictEqual({
      subjects: [{ subject: PLAIN }],
      publisher: { name: PLAIN },
      // A name that converts to nothing is dropped, or composed from given and family names.
      creatorCount: 2,
      creatorName: PLAIN,
      composedCreatorName: 'Josiah Carberry',
      creatorGivenName: PLAIN,
      creatorFamilyName: PLAIN,
      creatorAffiliations: [{ name: PLAIN }],
      contributorName: PLAIN,
      contributorAffiliations: [{ name: PLAIN }],
      funderName: PLAIN,
      itemPublisher: PLAIN,
      itemCreatorName: PLAIN,
      itemCreatorAffiliations: [{ name: PLAIN }],
      itemContributor: {
        name: `${PLAIN} Ström`,
        givenName: PLAIN,
        familyName: 'Ström',
        contributorType: 'Editor',
        otherIdentifiers: [],
        affiliations: [],
      },
    });
  });

  it('converts search-row creator names and the plain-string publisher, dropping a name that converts to nothing', () => {
    const row = mapWorkRow(
      record({
        creators: [{ name: RAW }, { name: '<br>' }, { name: 'Smith, J&ouml;rg' }],
        publisher: 'Taylor &amp; Francis',
      }),
      new Map(),
    );
    expect(row).toMatchObject({
      creators: [PLAIN, 'Smith, Jörg'],
      creatorCount: 2,
      publisher: 'Taylor & Francis',
    });
  });

  it.each([
    ['Igneous&gt;Rock', 'Igneous>Rock'],
    ['Taylor &amp; Francis', 'Taylor & Francis'],
    ['Igneous&amp;gt;Rock', 'Igneous&gt;Rock'],
    ['&bogus; and &beta without a semicolon', '&bogus; and &beta without a semicolon'],
    ['pH < 7 and <Unknown> markup', 'pH < 7 and <Unknown> markup'],
  ])(
    'reads the deposited subject %j as %j: one decoding pass, unknown references and tags kept',
    (deposited, expected) => {
      const { work } = mapWork(record({ subjects: [{ subject: deposited }] }), undefined);
      expect(work.subjects).toEqual([{ subject: expected }]);
    },
  );

  it('leaves identifiers, URIs, schemes, codes, places, award fields, rights, and descriptions as deposited', () => {
    const ENC = 'A &amp; B&gt;C';
    const { work } = mapWork(
      record({
        subjects: [{ subject: 'Geology', subjectScheme: ENC, classificationCode: ENC }],
        creators: [
          {
            name: 'Carberry, Josiah',
            nameIdentifiers: [{ nameIdentifier: ENC, nameIdentifierScheme: 'ISNI' }],
          },
        ],
        fundingReferences: [
          {
            funderName: 'NSF',
            funderIdentifier: ENC,
            awardNumber: ENC,
            awardTitle: ENC,
            awardUri: ENC,
          },
        ],
        geoLocations: [{ geoLocationPlace: ENC }],
        rightsList: [{ rights: ENC, rightsUri: ENC, rightsIdentifier: ENC }],
        descriptions: [{ description: ENC }],
        relatedItems: [
          {
            relationType: 'IsPartOf',
            relatedItemIdentifier: { relatedItemIdentifier: ENC, relatedItemIdentifierType: 'DOI' },
          },
        ],
      }),
      undefined,
    );
    expect(work.subjects).toEqual([{ subject: 'Geology', scheme: ENC, classificationCode: ENC }]);
    expect(work.creators[0]?.otherIdentifiers).toEqual([{ identifier: ENC, scheme: 'ISNI' }]);
    expect(work.fundingReferences).toEqual([
      {
        funderName: 'NSF',
        funderIdentifier: ENC,
        awardNumber: ENC,
        awardTitle: ENC,
        awardUri: ENC,
      },
    ]);
    expect(work.geoLocations).toEqual([{ place: ENC }]);
    expect(work.rights).toEqual([{ rights: ENC, rightsUri: ENC, rightsIdentifier: ENC }]);
    expect(work.descriptions).toEqual([{ description: ENC }]);
    expect(work.relatedItems).toEqual([
      { relationType: 'IsPartOf', identifier: ENC, identifierType: 'DOI' },
    ]);
  });
});

describe('mapWorkRow rightsUris', () => {
  it('carries a license deposited only as a rightsUri, deriving no id from it', () => {
    const row = mapWorkRow(
      record({
        rightsList: [
          {
            rights: 'Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)',
            rightsUri: 'https://creativecommons.org/licenses/by-nc/4.0/',
          },
        ],
      }),
      new Map(),
    );
    expect(row.licenses).toEqual([]);
    expect(row.rightsUris).toEqual(['https://creativecommons.org/licenses/by-nc/4.0/']);
  });

  it('keeps every deposited rightsUri in deposit order beside the ids, trimmed, blanks dropped, none decoded', () => {
    const row = mapWorkRow(
      record({
        rightsList: [
          {
            rightsIdentifier: 'cc-by-4.0',
            rightsUri: ' https://creativecommons.org/licenses/by/4.0/legalcode ',
          },
          { rightsUri: '  ' },
          { rights: 'Statement only' },
          { rightsUri: 'https://example.org/terms?a=1&amp;b=2' },
          { rightsIdentifier: 'cc-by-4.0', rightsUri: 'info:eu-repo/semantics/openAccess' },
        ],
      }),
      new Map(),
    );
    expect(row.licenses).toEqual(['cc-by-4.0', 'cc-by-4.0']);
    expect(row.rightsUris).toEqual([
      'https://creativecommons.org/licenses/by/4.0/legalcode',
      'https://example.org/terms?a=1&amp;b=2',
      'info:eu-repo/semantics/openAccess',
    ]);
  });

  it.each([
    ['no rightsList', {}],
    ['a null rightsList', { rightsList: null }],
    ['an empty rightsList', { rightsList: [] }],
    [
      'statements and ids without a URI',
      {
        rightsList: [
          { rights: 'All rights reserved' },
          { rightsIdentifier: 'mit', rightsUri: null },
        ],
      },
    ],
  ] satisfies Array<[string, RawDoiAttributes]>)(
    'leaves rightsUris absent, never [], with %s',
    (_name, attributes) => {
      expect(mapWorkRow(record(attributes), new Map())).not.toHaveProperty('rightsUris');
    },
  );
});
