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
      { field: 'creators', shown: 100, total: 120 },
      { field: 'subjects', shown: 100, total: 101 },
      { field: 'geoLocations', shown: 50, total: 60 },
      { field: 'relatedIdentifiers', shown: 100, total: 130 },
      { field: 'relatedItems', shown: 25, total: 30 },
    ]);
    expect(work.creators).toHaveLength(RECORD_LIST_CAPS.creators);
    expect(work.contributors).toHaveLength(100);
    expect(work.fundingReferences).toHaveLength(100);
    expect(work.relatedIdentifiers).toHaveLength(100);
    expect(work.relatedIdentifierCounts).toEqual({ IsPartOf: 65, Cites: 65 });
    expect(work.relatedItems).toHaveLength(25);
    expect(work.geoLocations).toHaveLength(50);
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
