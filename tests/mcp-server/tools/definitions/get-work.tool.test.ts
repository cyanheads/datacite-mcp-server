/**
 * @fileoverview Tests for `datacite_get_work` through its public contract
 * (`runToolContract` over a fake `fetch`): the found arm from a recorded record,
 * list caps and their enrichment, the four miss reasons from the registration-
 * agency lookup, DOI normalization, the exact upstream request, and the declared
 * error reasons — each on both `structuredContent` and `content[]`.
 * @module tests/mcp-server/tools/definitions/get-work.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkTool } from '@/mcp-server/tools/definitions/get-work.tool.js';
import type { RawDoiAttributes, RawDoiResource } from '@/services/datacite/types.js';
import {
  doiList,
  emptyDoiList,
  fixtureResponse,
  rateLimitResponse,
} from '../../../helpers/fixtures.js';
import {
  contentText,
  DATACITE,
  dataCite,
  declaredSeverities,
  doiRa,
  initServices,
  json,
  requestUrl,
  structured,
  type ToolResultLike,
  teardownServices,
  toolError,
} from '../../../helpers/harness.js';

type Output = z.infer<typeof getWorkTool.output> & {
  truncatedLists?: Array<{ field: string; shown: number; total: number }>;
};

afterEach(() => {
  teardownServices();
  vi.useRealTimers();
});

const run = (doi: string) => runToolContract(getWorkTool, { doi });
const output = (result: ToolResultLike) => structured<Output>(result);

/** A full-record `/dois` page holding one constructed record for `doi`. */
const recordPage = (doi: string, attributes: RawDoiAttributes) => {
  const record: RawDoiResource = { id: doi, type: 'dois', attributes: { doi, ...attributes } };
  return json(doiList([record]));
};

const DRYAD_234 = {
  match: dataCite('/dois'),
  respond: fixtureResponse('datacite/works/record-dryad-234.json'),
};

describe('found arm', () => {
  it('returns the recorded dryad.234 record with nested creators and normalized ROR IDs', async () => {
    const { http } = initServices([DRYAD_234]);
    const result = await run('10.5061/dryad.234');
    expect(result.isError).toBeFalsy();
    const out = output(result);
    expect(out).toMatchObject({
      found: true,
      doi: '10.5061/dryad.234',
      doiUrl: 'https://doi.org/10.5061/dryad.234',
      landingUrl: 'https://datadryad.org/dataset/doi:10.5061/dryad.234',
      titles: [{ title: 'Data from: Towards a worldwide wood economics spectrum' }],
      publisher: { name: 'Dryad', rorId: '00x6h5n95' },
      publicationYear: 2009,
      resourceTypeGeneral: 'Dataset',
      metadataLicense: 'CC0-1.0',
      rights: [
        {
          rights: 'Creative Commons Zero v1.0 Universal',
          rightsUri: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode',
          rightsIdentifier: 'cc0-1.0',
        },
      ],
      relatedIdentifierCounts: { IsCitedBy: 1 },
      repository: { repositoryId: 'dryad.dryad', name: 'DRYAD', providerId: 'dryad' },
      counts: { citationCount: 264, viewCount: 56788, downloadCount: 21834 },
    });
    expect(out.creators).toHaveLength(10);
    expect(out.creators?.[0]).toEqual({
      name: 'Zanne, Amy E.',
      nameType: 'Personal',
      givenName: 'Amy E.',
      familyName: 'Zanne',
      otherIdentifiers: [],
      affiliations: [{ name: 'University of Missouri–St. Louis', rorId: '037cnag11' }],
    });
    for (const key of ['missReason', 'registrationAgency', 'guidance', 'truncatedLists']) {
      expect(out).not.toHaveProperty(key);
    }

    const text = contentText(result);
    expect(text).toContain('# Data from: Towards a worldwide wood economics spectrum\n');
    expect(text).toContain('**DOI:** 10.5061/dryad.234 · **Found:** true');
    expect(text).toContain(
      '**Type:** Dataset (dataset) · **Year:** 2009 · **Version:** 5 · **Language:** en',
    );
    expect(text).toContain('**Publisher:** Dryad (ROR 00x6h5n95)');
    expect(text).toContain('**Repository:** DRYAD (dryad.dryad) · **Provider:** dryad');
    expect(text).toContain(
      '**Counts:** 264 citations · 1 references · 0 versions · version of 0 · 1 parts · part of 0 · 56,788 views · 21,834 downloads',
    );
    expect(text).toContain(
      '## Creators\n- Zanne, Amy E. — Personal; given Amy E.; family Zanne; University of Missouri–St. Louis (ROR 037cnag11)',
    );
    expect(text).toContain(
      '## Rights\n- Work rights: Creative Commons Zero v1.0 Universal (cc0-1.0) https://creativecommons.org/publicdomain/zero/1.0/legalcode\n- Metadata: CC0-1.0',
    );
    expect(text).toContain(
      '## Related identifiers\n**IsCitedBy** — 1 of 1\n- 10.1111/j.1461-0248.2009.01285.x (DOI)',
    );
    expect(text).not.toContain('Truncated lists');
    expect(http.calls).toHaveLength(1);
  });

  it('asks for the one exact DOI with its client, newest first, and no field restriction', async () => {
    const { http } = initServices([DRYAD_234]);
    await run('10.5061/dryad.234');
    const url = requestUrl(http);
    expect(`${url.origin}${url.pathname}`).toBe(`${DATACITE}/dois`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: 'doi:"10.5061/dryad.234"',
      sort: '-created',
      include: 'client',
      affiliation: 'true',
      publisher: 'true',
      'page[size]': '1',
    });
  });

  it('escapes quotes and backslashes of the DOI inside the query phrase', async () => {
    const doi = '10.5555/a"b\\c';
    const { http } = initServices([
      { match: dataCite('/dois'), respond: json(emptyDoiList()) },
      { match: doiRa(doi), respond: fixtureResponse('doi-ra/does-not-exist.json') },
    ]);
    const result = await run(doi);
    expect(requestUrl(http).searchParams.get('query')).toBe('doi:"10.5555/a\\"b\\\\c"');
    expect(output(result)).toMatchObject({ found: false, doi, missReason: 'does_not_exist' });
  });

  it('caps long lists and reports each full count in truncatedLists on both surfaces', async () => {
    const many = <T>(n: number, make: (i: number) => T): T[] =>
      Array.from({ length: n }, (_, i) => make(i));
    initServices([
      {
        match: dataCite('/dois'),
        respond: recordPage('10.5555/big', {
          titles: [{ title: 'Big record' }],
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
          geoLocations: many(60, (i) => ({ geoLocationPlace: `Place ${i}` })),
        }),
      },
    ]);
    const result = await run('10.5555/big');
    const out = output(result);
    expect(out.truncatedLists).toEqual([
      { field: 'creators', shown: 100, total: 120 },
      { field: 'geoLocations', shown: 50, total: 60 },
      { field: 'relatedIdentifiers', shown: 100, total: 130 },
      { field: 'relatedItems', shown: 25, total: 30 },
    ]);
    expect(out.creators).toHaveLength(100);
    expect(out.contributors).toHaveLength(100);
    expect(out.relatedIdentifiers).toHaveLength(100);
    expect(out.relatedIdentifierCounts).toEqual({ IsPartOf: 65, Cites: 65 });
    expect(out.relatedItems).toHaveLength(25);
    expect(out.geoLocations).toHaveLength(50);
    const text = contentText(result);
    expect(text).toContain(
      '**Truncated lists:** creators: 100 of 120; geoLocations: 50 of 60; relatedIdentifiers: 100 of 130; relatedItems: 25 of 30',
    );
    expect(text).toContain('**IsPartOf** — 50 of 65');
    expect(text).toContain('**Cites** — 50 of 65');
  });

  it('drops entries missing their identifying field and counts only the kept relations', async () => {
    initServices([
      {
        match: dataCite('/dois'),
        respond: recordPage('10.5555/partial', {
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
          fundingReferences: [{ awardNumber: 'A-1' }, { funderName: 'NSF', awardNumber: 'A-2' }],
          dates: [{ date: '2020' }, { date: '2021', dateType: 'Issued' }],
        }),
      },
    ]);
    const result = await run('10.5555/partial');
    const out = output(result);
    expect(out.relatedIdentifiers).toEqual([
      { relationType: 'Cites', relatedIdentifier: '10.5555/kept', relatedIdentifierType: 'DOI' },
    ]);
    expect(out.relatedIdentifierCounts).toEqual({ Cites: 1 });
    expect(out.fundingReferences).toEqual([{ funderName: 'NSF', awardNumber: 'A-2' }]);
    expect(out.dates).toEqual([{ date: '2021', dateType: 'Issued' }]);
    const text = contentText(result);
    expect(text).toContain('**Cites** — 1 of 1\n- 10.5555/kept (DOI)');
    expect(text).not.toContain('IsCitedBy');
    expect(text).not.toContain('no-type');
    expect(text).toContain('## Funding\n- NSF — award A-2');
    expect(text).not.toContain('A-1');
    expect(text).toContain('## Dates\n- Issued: 2021');
  });

  it('renders a sparse record with explicit markers, zero counts, and no empty sections', async () => {
    initServices([{ match: dataCite('/dois'), respond: recordPage('10.5555/sparse', {}) }]);
    const result = await run('10.5555/sparse');
    expect(result.isError).toBeFalsy();
    expect(output(result)).toEqual({
      found: true,
      doi: '10.5555/sparse',
      doiUrl: 'https://doi.org/10.5555/sparse',
      titles: [],
      creators: [],
      contributors: [],
      dates: [],
      subjects: [],
      descriptions: [],
      fundingReferences: [],
      geoLocations: [],
      rights: [],
      metadataLicense: 'CC0-1.0',
      sizes: [],
      formats: [],
      alternateIdentifiers: [],
      relatedIdentifiers: [],
      relatedIdentifierCounts: {},
      relatedItems: [],
      counts: {
        citationCount: 0,
        referenceCount: 0,
        versionCount: 0,
        versionOfCount: 0,
        partCount: 0,
        partOfCount: 0,
        viewCount: 0,
        downloadCount: 0,
      },
    });
    const text = contentText(result);
    expect(text).toContain('# 10.5555/sparse\n');
    expect(text).toContain(
      '**Type:** Not available · **Year:** Not available · **Version:** Not available · **Language:** Not available',
    );
    expect(text).toContain('**Counts:** 0 citations · 0 references');
    expect(text).toContain('## Rights\n- Work rights: none declared\n- Metadata: CC0-1.0');
    for (const absent of [
      '**Publisher:**',
      '**Repository:**',
      '**Landing page:**',
      '**Record:**',
      '## Titles',
      '## Creators',
      '## Related identifiers',
      '## Related items',
      '## Sizes and formats',
    ]) {
      expect(text).not.toContain(absent);
    }
  });

  it('flattens depositor text in every inline slot, blockquotes descriptions, and keeps structuredContent verbatim', async () => {
    const evil = (label: string) => `${label}\n# INJECTED ${label}\r\n- INJECTED ${label}`;
    initServices([
      {
        match: dataCite('/dois'),
        respond: recordPage('10.5555/hostile', {
          titles: [{ title: evil('title') }, { title: evil('alt'), titleType: 'Other' }],
          creators: [{ name: evil('creator'), affiliation: [{ name: evil('affiliation') }] }],
          contributors: [{ name: evil('contributor'), contributorType: 'DataCurator' }],
          publisher: { name: evil('publisher') },
          types: { resourceTypeGeneral: 'Dataset', resourceType: evil('type') },
          version: evil('version'),
          language: evil('language'),
          url: evil('https://landing'),
          dates: [{ date: evil('date'), dateType: 'Issued' }],
          subjects: [{ subject: evil('subject') }],
          descriptions: [{ description: evil('description'), descriptionType: 'Abstract' }],
          fundingReferences: [{ funderName: evil('funder'), awardTitle: evil('award') }],
          geoLocations: [{ geoLocationPlace: evil('place') }],
          rightsList: [{ rights: evil('rights') }],
          identifiers: [{ identifier: evil('alternate'), identifierType: 'Local' }],
          relatedIdentifiers: [{ relationType: 'Cites', relatedIdentifier: evil('related') }],
          relatedItems: [{ relationType: 'IsPublishedIn', titles: [{ title: evil('item') }] }],
          sizes: [evil('size')],
          formats: [evil('format')],
          registered: evil('registered'),
          created: evil('created'),
          updated: evil('updated'),
          schemaVersion: evil('schema'),
        }),
      },
    ]);
    const result = await run('10.5555/hostile');
    const out = output(result);
    expect(out.titles?.[0]?.title).toBe(evil('title'));
    expect(out.created).toBe(evil('created'));
    expect(out.descriptions?.[0]?.description).toBe(evil('description'));
    const text = contentText(result);
    expect(text).toContain('# title # INJECTED title - INJECTED title\n');
    expect(text).toContain(
      '**Record:** registered registered # INJECTED registered - INJECTED registered · created created',
    );
    expect(text).toContain('> description\n> # INJECTED description\n> - INJECTED description');
    expect(text).not.toMatch(/^(#|-) INJECTED/m);
  });
});

describe('miss arm', () => {
  it.each([
    {
      name: 'another agency’s DOI',
      doi: '10.1038/nature12373',
      ra: 'doi-ra/crossref.json',
      expected: {
        missReason: 'other_agency',
        registrationAgency: 'Crossref',
        guidance:
          '10.1038/nature12373 is registered with Crossref, not DataCite, so DataCite holds no deposited metadata for it. To find DataCite datasets or software linked to it, call datacite_trace_relations with this DOI.',
      },
    },
    {
      name: 'a DOI no agency registered',
      doi: '10.9999/doesnotexist',
      ra: 'doi-ra/does-not-exist.json',
      expected: {
        missReason: 'does_not_exist',
        guidance:
          'No agency has registered 10.9999/doesnotexist. Check it for typos or truncation, or find the work by title with datacite_search_works (text).',
      },
    },
    {
      name: 'a DataCite DOI without public metadata',
      doi: '10.5061/dryad.8515',
      ra: 'doi-ra/datacite.json',
      expected: {
        missReason: 'not_public',
        registrationAgency: 'DataCite',
        guidance:
          '10.5061/dryad.8515 is a DataCite DOI without public (Findable) metadata — it may be in Registered or Draft state, or registered minutes ago. Retry later, or search by title with datacite_search_works.',
      },
    },
  ])(
    'answers $name with found: false, the reason, and the next step',
    async ({ doi, ra, expected }) => {
      const { http } = initServices([
        { match: dataCite('/dois'), respond: json(emptyDoiList()) },
        { match: doiRa(doi), respond: fixtureResponse(ra) },
      ]);
      const result = await run(doi);
      expect(result.isError).toBeFalsy();
      expect(output(result)).toEqual({ found: false, doi, ...expected });
      const text = contentText(result);
      expect(text).toContain(`**Not found in DataCite** — ${doi}`);
      expect(text).toContain(`**DOI:** ${doi} · **Found:** false`);
      expect(text).toContain(`**Miss reason:** ${expected.missReason}`);
      if (expected.registrationAgency) {
        expect(text).toContain(`**Registration agency:** ${expected.registrationAgency}`);
      } else {
        expect(text).not.toContain('**Registration agency:**');
      }
      expect(text).toContain(expected.guidance);
      expect(http.calls).toHaveLength(2);
      expect(requestUrl(http, 1).href).toBe(`https://doi.org/ra/${encodeURIComponent(doi)}`);
    },
  );

  const unclassified = (doi: string) => ({
    found: false,
    doi,
    missReason: 'unclassified',
    guidance: `DataCite holds no public record for ${doi}, and the registration-agency lookup did not answer. Check the DOI, or search by title with datacite_search_works.`,
  });

  it('answers unclassified when the agency lookup is rate limited', async () => {
    const doi = '10.1038/nature12373';
    const { http } = initServices([
      { match: dataCite('/dois'), respond: json(emptyDoiList()) },
      { match: doiRa(doi), respond: rateLimitResponse() },
    ]);
    const result = await run(doi);
    expect(output(result)).toEqual(unclassified(doi));
    expect(contentText(result)).toContain('**Miss reason:** unclassified');
    expect(http.calls).toHaveLength(2);
  });

  it('answers unclassified when the agency lookup keeps failing with 5xx', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const doi = '10.1038/nature12373';
    const { http } = initServices([
      { match: dataCite('/dois'), respond: json(emptyDoiList()) },
      { match: doiRa(doi), respond: json({ errors: [] }, { status: 503 }) },
    ]);
    const pending = run(doi);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(output(result)).toEqual(unclassified(doi));
    expect(http.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('flattens the registration agency inside the guidance and keeps it verbatim in structuredContent', async () => {
    const doi = '10.1038/nature12373';
    const agency = 'Crossref\n# INJECTED heading\r\n- INJECTED bullet';
    initServices([
      { match: dataCite('/dois'), respond: json(emptyDoiList()) },
      { match: doiRa(doi), respond: json([{ DOI: doi, RA: agency }]) },
    ]);
    const result = await run(doi);
    const out = output(result);
    expect(out).toMatchObject({
      found: false,
      missReason: 'other_agency',
      registrationAgency: agency,
    });
    expect(out.guidance).toContain(`registered with ${agency}, not DataCite`);
    const text = contentText(result);
    expect(text).toContain(
      '**Registration agency:** Crossref # INJECTED heading - INJECTED bullet',
    );
    expect(text).toContain(
      'registered with Crossref # INJECTED heading - INJECTED bullet, not DataCite',
    );
    expect(text).not.toMatch(/^(#|-) INJECTED/m);
  });

  it('propagates a non-transient agency failure instead of calling it unclassified', async () => {
    const doi = '10.1038/nature12373';
    initServices([
      { match: dataCite('/dois'), respond: json(emptyDoiList()) },
      { match: doiRa(doi), respond: json({ errors: [] }, { status: 404 }) },
    ]);
    const result = await run(doi);
    const error = toolError(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe('doi.org returned HTTP 404.');
    expect(contentText(result)).toContain('doi.org returned HTTP 404.');
  });
});

describe('DOI input', () => {
  it.each([
    '10.5061/dryad.234',
    '10.5061/DRYAD.234',
    '  10.5061/dryad.234  ',
    'doi:10.5061/dryad.234',
    'DOI: 10.5061/dryad.234',
    'info:doi/10.5061/dryad.234',
    'INFO:DOI/10.5061/dryad.234',
    'https://doi.org/10.5061/dryad.234',
    'http://dx.doi.org/10.5061/DRYAD.234',
    '  HTTPS://DX.DOI.ORG/10.5061/DRYAD.234  ',
    '10.5061%2Fdryad.234',
    '10.5061%2FDRYAD.234',
  ])('normalizes %j to the one canonical request', async (input) => {
    const { http } = initServices([DRYAD_234]);
    const result = await run(input);
    expect(output(result)).toMatchObject({ found: true, doi: '10.5061/dryad.234' });
    expect(requestUrl(http).searchParams.get('query')).toBe('doi:"10.5061/dryad.234"');
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    ['10.12/x', 'a registrant under 4 digits'],
    ['10.1234567890/x', 'a registrant over 9 digits'],
    ['10.5061/', 'no suffix'],
    ['https://doi.org/10.5061/', 'a URL with no suffix'],
  ])('rejects %j (%s) as invalid_doi before any request', async (input) => {
    const { http } = initServices([DRYAD_234]);
    const result = await run(input);
    const error = toolError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_doi');
    expect(contentText(result)).toContain('Recovery: Pass a DOI such as 10.5061/dryad.234');
    expect(contentText(result)).toContain('(reason invalid_doi)');
    expect(http.calls).toHaveLength(0);
  });

  it.each(['', '   ', 'dryad.234', 'urn:doi:10.5061/x'])(
    'rejects %j at the schema, naming the accepted forms',
    async (input) => {
      const { http } = initServices([DRYAD_234]);
      const result = await run(input);
      const error = toolError(result);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(error.message).toContain('Expected a DOI such as 10.5061/dryad.234');
      expect(http.calls).toHaveLength(0);
    },
  );
});

describe('rate limiting', () => {
  it('surfaces an exhausted DataCite budget as rate_limited without an agency lookup', async () => {
    const { http } = initServices([{ match: dataCite('/dois'), respond: rateLimitResponse() }]);
    const result = await run('10.5061/dryad.234');
    const error = toolError(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 30, retryable: true });
    expect(contentText(result)).toContain('(reason rate_limited · retryable)');
    expect(http.calls).toHaveLength(1);
  });

  it('logs invalid_doi at notice and a spent budget at error', () => {
    expect(declaredSeverities(getWorkTool.errors)).toEqual({
      invalid_doi: 'notice',
      rate_limited: 'error',
    });
  });
});
