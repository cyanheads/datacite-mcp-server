/**
 * @fileoverview Tests for `datacite_trace_relations` through its public contract
 * (`runToolContract` over a fake `fetch`): the DataCite root with own, reverse,
 * and Event Data edges merged; a journal-article root reaching DataCite works
 * through its outgoing events; depth 2; the node cap; relation-type narrowing;
 * Event Data degradation; notices; and the declared error reasons — each on
 * both `structuredContent` and `content[]`.
 * @module tests/mcp-server/tools/definitions/trace-relations.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { traceRelationsTool } from '@/mcp-server/tools/definitions/trace-relations.tool.js';
import type {
  RawDoiAttributes,
  RawDoiList,
  RawDoiResource,
  RawEventList,
} from '@/services/datacite/types.js';
import {
  doiList,
  dryad8515Part,
  dryad8515ReversePage,
  emptyDoiList,
  fixtureJson,
  fixtureResponse,
  gbifS6ctusRecord,
  linkingCopyRecord,
  rateLimitResponse,
} from '../../../helpers/fixtures.js';
import {
  contentText,
  DATACITE,
  dataCite,
  declaredSeverities,
  initServices,
  json,
  param,
  requestUrls,
  structured,
  type ToolResultLike,
  teardownServices,
  toolError,
} from '../../../helpers/harness.js';

type Input = z.input<typeof traceRelationsTool.input>;
type Output = z.infer<typeof traceRelationsTool.output> & {
  cap?: number;
  notice?: string;
  shown?: number;
  truncated?: boolean;
};

const ROOT = '10.5061/dryad.8515';
const PPAT = '10.1371/journal.ppat.1000446';
const PART1 = '10.5061/dryad.8515/1';
const PART2 = '10.5061/dryad.8515/2';
const ARTICLE = '10.1016/j.jag.2021.102408';

const ROOT_FIELDS =
  'doi,titles,types,publicationYear,citationCount,versionCount,client,relatedIdentifiers,relatedItems,referenceCount,versionOfCount,partCount,partOfCount';
const REVERSE_FIELDS =
  'doi,titles,types,publicationYear,citationCount,versionCount,client,relatedIdentifiers';
const NODE_FIELDS = 'doi,titles,types,publicationYear,citationCount,versionCount,client';
const NODE_WITH_RELATIONS_FIELDS = `${NODE_FIELDS},relatedIdentifiers,relatedItems`;
const CITATION_KEBAB =
  'cites,is-cited-by,references,is-referenced-by,is-supplement-to,is-supplemented-by';

afterEach(() => {
  teardownServices();
  vi.useRealTimers();
});

const run = (input: Input) => runToolContract(traceRelationsTool, input);
const output = (result: ToolResultLike) => structured<Output>(result);

/** The five stored forms of a DOI, written out as the design lists them. */
const doiForms = (doi: string) => [
  doi,
  `https://doi.org/${doi}`,
  `http://doi.org/${doi}`,
  `https://dx.doi.org/${doi}`,
  `http://dx.doi.org/${doi}`,
];

/** The reverse-relation query the design specifies for `dois`, optionally narrowed. */
const reverseQuery = (dois: string[], types?: string[]) =>
  `relatedIdentifiers.relatedIdentifier:(${dois
    .flatMap(doiForms)
    .map((form) => `"${form}"`)
    .join(' OR ')})${types ? ` AND relatedIdentifiers.relationType:(${types.join(' OR ')})` : ''}`;

/** `/dois` routes by call shape: the exact-DOI root read, a reverse query, an `ids=` batch. */
const rootRead = (doi: string) => dataCite('/dois', param('query', `doi:"${doi}"`));
const reverseRead = (dois: string[], types?: string[]) =>
  dataCite('/dois', param('query', reverseQuery(dois, types)));
const idsRead = dataCite('/dois', (url) => url.searchParams.has('ids'));
const eventsRead = dataCite('/events');

/**
 * A fake of `/dois?ids=`: answers with the known records the batch names,
 * case-insensitively, and silently drops the rest — as the upstream does.
 */
const byIds =
  (records: RawDoiResource[]) =>
  (request: Request): Response => {
    const wanted = new Set(
      (new URL(request.url).searchParams.get('ids') ?? '').toLowerCase().split(','),
    );
    return json(doiList(records.filter((record) => wanted.has(record.id.toLowerCase()))));
  };

const eventList = (events: RawEventList['data'] = []): RawEventList => ({
  data: events,
  meta: { total: events.length },
});

/** A DataCite record, `client` set to a repository unless given `null`. */
const record = (
  doi: string,
  attributes: RawDoiAttributes = {},
  client: string | null = 'dryad.dryad',
): RawDoiResource => ({
  id: doi,
  type: 'dois',
  attributes: { doi, ...attributes },
  relationships: { client: { data: client === null ? null : { id: client, type: 'clients' } } },
});

const PPAT_COPY = linkingCopyRecord({
  doi: PPAT,
  title: 'A new malaria agent in African hominids',
  publicationYear: 2009,
  citationCount: 7,
});

/** The dryad.8515 world: recorded root and events, constructed reverse page and hydration. */
const dryad8515Routes = (hydrated: RawDoiResource[] = [PPAT_COPY]) => [
  { match: rootRead(ROOT), respond: fixtureResponse('datacite/graph/root-dryad-8515.json') },
  { match: reverseRead([ROOT]), respond: json(dryad8515ReversePage()) },
  { match: eventsRead, respond: fixtureResponse('datacite/graph/events-dryad-8515.json') },
  { match: idsRead, respond: byIds(hydrated) },
];

const expectToolError = (result: ToolResultLike, reason: string, code: number) => {
  const error = toolError(result);
  expect(error.code).toBe(code);
  expect(error.data?.reason).toBe(reason);
  expect(contentText(result)).toContain(`(reason ${reason}`);
  return error;
};

describe('a DataCite root', () => {
  it('merges own, reverse, and Event Data edges and hydrates every node on both surfaces', async () => {
    const { http } = initServices(dryad8515Routes());
    const result = await run({ doi: ROOT });
    expect(result.isError).toBeFalsy();
    const out = output(result);

    expect(out.root).toEqual({
      doi: ROOT,
      isDataCiteDoi: true,
      title: 'Data from: A new malaria agent in African hominids.',
      resourceTypeGeneral: 'Dataset',
      publicationYear: 2011,
      repositoryId: 'dryad.dryad',
    });
    expect(out.nodes).toEqual([
      {
        id: ROOT,
        idType: 'DOI',
        depth: 0,
        hydrated: true,
        isDataCiteDoi: true,
        title: 'Data from: A new malaria agent in African hominids.',
        resourceTypeGeneral: 'Dataset',
        publicationYear: 2011,
        repositoryId: 'dryad.dryad',
        citationCount: 1,
        versionCount: 0,
      },
      {
        id: PPAT,
        idType: 'DOI',
        depth: 1,
        hydrated: true,
        isDataCiteDoi: false,
        title: 'A new malaria agent in African hominids',
        resourceTypeGeneral: 'Text',
        publicationYear: 2009,
        citationCount: 7,
        versionCount: 0,
      },
      ...[PART1, PART2].map((id, i) => ({
        id,
        idType: 'DOI',
        depth: 1,
        hydrated: true,
        isDataCiteDoi: true,
        title: `Data from: A new malaria agent in African hominids. — file ${i + 1}`,
        resourceTypeGeneral: 'Dataset',
        publicationYear: 2011,
        repositoryId: 'dryad.dryad',
        citationCount: 0,
        versionCount: 0,
      })),
    ]);
    expect(out.edges).toEqual([
      {
        from: ROOT,
        to: PPAT,
        relationType: 'IsCitedBy',
        sources: ['metadata', 'event_data'],
        eventSources: ['datacite-crossref'],
      },
      { from: PART1, to: ROOT, relationType: 'IsPartOf', sources: ['reverse_metadata'] },
      { from: PART2, to: ROOT, relationType: 'IsPartOf', sources: ['reverse_metadata'] },
      {
        from: ROOT,
        to: PPAT,
        relationType: 'IsReferencedBy',
        sources: ['event_data'],
        eventSources: ['datacite-crossref'],
      },
      {
        from: ROOT,
        to: PPAT,
        relationType: 'IsSupplementTo',
        sources: ['event_data'],
        eventSources: ['datacite-crossref'],
      },
    ]);
    expect(out.rootCounts).toEqual({
      citationCount: 1,
      referenceCount: 1,
      versionCount: 0,
      versionOfCount: 0,
      partCount: 2,
      partOfCount: 0,
    });
    expect(out.coverage).toEqual({
      ownMetadata: { status: 'ok', edgeCount: 1 },
      reverseMetadata: { status: 'ok', total: 2, fetched: 2 },
      eventData: { status: 'ok', scope: 'both_sides', total: 3, fetched: 3, kept: 3 },
    });
    for (const key of ['notice', 'truncated', 'shown', 'cap']) expect(out).not.toHaveProperty(key);

    const text = contentText(result);
    expect(text).toContain(`# Relations of ${ROOT}`);
    expect(text).toContain(
      '**Title:** Data from: A new malaria agent in African hominids. · **Type:** Dataset · **Year:** 2011 · **Repository:** dryad.dryad · **DataCite DOI:** true',
    );
    expect(text).toContain(
      '**DataCite counts:** 1 citations · 1 references · 0 versions · version of 0 · 2 parts · part of 0',
    );
    expect(text).toContain(
      `## Edges (5)\n**IsCitedBy**\n- ${ROOT} —IsCitedBy→ ${PPAT} [metadata, event_data, event source datacite-crossref]\n**IsPartOf**\n- ${PART1} —IsPartOf→ ${ROOT} [reverse_metadata]\n- ${PART2} —IsPartOf→ ${ROOT} [reverse_metadata]\n**IsReferencedBy**\n- ${ROOT} —IsReferencedBy→ ${PPAT} [event_data, event source datacite-crossref]`,
    );
    expect(text).toContain('## Nodes (4)');
    expect(text).toContain(
      `| ${PPAT} | DOI | false | 1 | true | 2009 | Text | Not available | 7 | 0 | A new malaria agent in African hominids |`,
    );
    expect(text).toContain(
      `| ${PART2} | DOI | true | 1 | true | 2011 | Dataset | dryad.dryad | 0 | 0 | Data from: A new malaria agent in African hominids. — file 2 |`,
    );
    expect(text).toContain(
      '## Coverage\n- **Own metadata:** ok · 1 asserted relations\n- **Reverse metadata:** ok · fetched 2 of 2 records\n- **Event Data:** ok · scope both_sides · total 3 · fetched 3 · kept 3',
    );
    expect(http.calls).toHaveLength(4);
  });

  it('reads the root, the reverse query, Event Data on both sides, then one ids= batch, newest first', async () => {
    const { http } = initServices(dryad8515Routes());
    await run({ doi: 'https://doi.org/10.5061/DRYAD.8515' });
    const [rootUrl, ...rest] = requestUrls(http);
    const byPath = (path: string) => rest.filter((url) => url.pathname === path);
    expect(Object.fromEntries(rootUrl?.searchParams ?? [])).toEqual({
      query: `doi:"${ROOT}"`,
      sort: '-created',
      'fields[dois]': ROOT_FIELDS,
      affiliation: 'true',
      publisher: 'true',
      'page[size]': '1',
    });
    const [reverse, hydrate] = byPath('/dois');
    expect(Object.fromEntries(reverse?.searchParams ?? [])).toEqual({
      query: `relatedIdentifiers.relatedIdentifier:("${ROOT}" OR "https://doi.org/${ROOT}" OR "http://doi.org/${ROOT}" OR "https://dx.doi.org/${ROOT}" OR "http://dx.doi.org/${ROOT}")`,
      sort: '-created',
      'page[size]': '50',
      'fields[dois]': REVERSE_FIELDS,
      affiliation: 'true',
      publisher: 'true',
    });
    expect(Object.fromEntries(hydrate?.searchParams ?? [])).toEqual({
      ids: PPAT,
      sort: '-created',
      'fields[dois]': NODE_FIELDS,
      affiliation: 'true',
      publisher: 'true',
      'page[size]': '100',
    });
    const [events] = byPath('/events');
    expect(`${events?.origin}${events?.pathname}`).toBe(`${DATACITE}/events`);
    expect(Object.fromEntries(events?.searchParams ?? [])).toEqual({
      doi: ROOT,
      'relation-type-id': CITATION_KEBAB,
      'page[size]': '100',
    });
  });

  it('keeps only the relation a reverse match asserts on the root itself, and every one it does', async () => {
    const mixed = record('10.5061/dryad.9999', {
      relatedIdentifiers: [
        { relationType: 'References', relatedIdentifier: ROOT, relatedIdentifierType: 'DOI' },
        {
          relationType: 'Cites',
          relatedIdentifier: `http://dx.doi.org/${ROOT}`,
          relatedIdentifierType: 'URL',
        },
        {
          relationType: 'IsPartOf',
          relatedIdentifier: '10.5555/other',
          relatedIdentifierType: 'DOI',
        },
      ],
    });
    initServices([
      { match: rootRead(ROOT), respond: fixtureResponse('datacite/graph/root-dryad-8515.json') },
      { match: reverseRead([ROOT]), respond: json(doiList([mixed])) },
      { match: eventsRead, respond: json(eventList()) },
      { match: idsRead, respond: byIds([PPAT_COPY]) },
    ]);
    const out = output(await run({ doi: ROOT, include_event_data: false }));
    expect(out.edges.filter((e) => e.from === '10.5061/dryad.9999')).toEqual([
      {
        from: '10.5061/dryad.9999',
        to: ROOT,
        relationType: 'References',
        sources: ['reverse_metadata'],
      },
      {
        from: '10.5061/dryad.9999',
        to: ROOT,
        relationType: 'Cites',
        sources: ['reverse_metadata'],
      },
    ]);
    expect(out.nodes.map((n) => n.id)).not.toContain('10.5555/other');
  });

  it('keeps own-metadata identifiers of every kind as leaves, typed as deposited', async () => {
    const root = record('10.5555/hub', {
      titles: [{ title: 'Hub\nrecord' }],
      relatedIdentifiers: [
        {
          relationType: 'IsDocumentedBy',
          relatedIdentifier: 'https://example.org/protocol',
          relatedIdentifierType: 'URL',
        },
        {
          relationType: 'References',
          relatedIdentifier: 'arXiv:2101.00001',
          relatedIdentifierType: 'arXiv',
        },
        { relationType: 'IsVariantFormOf', relatedIdentifier: 'local-id-7' },
        {
          relationType: 'HasVersion',
          relatedIdentifier: 'https://doi.org/10.5555/HUB.V2',
          relatedIdentifierType: 'URL',
        },
        { relationType: 'IsCitedBy', relatedIdentifier: '  ' },
        { relatedIdentifier: '10.5555/no-relation-type', relatedIdentifierType: 'DOI' },
      ],
      relatedItems: [
        {
          relationType: 'IsPublishedIn',
          relatedItemIdentifier: {
            relatedItemIdentifier: '1234-5678',
            relatedItemIdentifierType: 'ISSN',
          },
        },
        { relationType: 'Cites', titles: [{ title: 'No identifier' }] },
      ],
      citationCount: 0,
    });
    const v2 = record('10.5555/hub.v2', { titles: [{ title: 'Tab | separated' }] });
    const { http } = initServices([
      { match: rootRead('10.5555/hub'), respond: json(doiList([root])) },
      { match: reverseRead(['10.5555/hub']), respond: json(emptyDoiList()) },
      { match: eventsRead, respond: json(eventList()) },
      { match: idsRead, respond: byIds([v2]) },
    ]);
    const result = await run({ doi: '10.5555/hub' });
    const out = output(result);
    expect(
      out.nodes.slice(1).map(({ id, idType, hydrated }) => ({ id, idType, hydrated })),
    ).toEqual([
      { id: 'https://example.org/protocol', idType: 'URL', hydrated: false },
      { id: 'arXiv:2101.00001', idType: 'arXiv', hydrated: false },
      { id: 'local-id-7', idType: 'Unknown', hydrated: false },
      { id: '10.5555/hub.v2', idType: 'DOI', hydrated: true },
      { id: '1234-5678', idType: 'ISSN', hydrated: false },
    ]);
    expect(out.nodes.find((n) => n.id === 'arXiv:2101.00001')).not.toHaveProperty('isDataCiteDoi');
    expect(out.coverage.ownMetadata).toEqual({ status: 'ok', edgeCount: 5 });
    expect(out.edges.map((e) => `${e.relationType} ${e.to}`)).toEqual([
      'IsDocumentedBy https://example.org/protocol',
      'References arXiv:2101.00001',
      'IsVariantFormOf local-id-7',
      'HasVersion 10.5555/hub.v2',
      'IsPublishedIn 1234-5678',
    ]);
    expect(
      requestUrls(http)
        .find((url) => url.searchParams.has('ids'))
        ?.searchParams.get('ids'),
    ).toBe('10.5555/hub.v2');

    const text = contentText(result);
    expect(text).toContain('**Title:** Hub record · ');
    expect(text).toContain(
      '| https://example.org/protocol | URL | — | 1 | false | Not available | Not available | Not available | Not available | Not available | Not available |',
    );
    expect(text).toContain('| Tab \\| separated |');
  });

  it('answers a root with no relations with the zero-edge and uncounted-citation notices', async () => {
    initServices([
      {
        match: rootRead('10.5555/lonely'),
        respond: json(doiList([record('10.5555/lonely', { citationCount: 3 })])),
      },
      { match: reverseRead(['10.5555/lonely']), respond: json(emptyDoiList()) },
      { match: eventsRead, respond: json(eventList()) },
    ]);
    const result = await run({ doi: '10.5555/lonely' });
    const out = output(result);
    const notice =
      'No relations were found in DataCite metadata or Event Data. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist. DataCite records 3 citations for this DOI; 0 are shown. Citations accrue per DOI — trace the concept DOI and its version DOIs separately.';
    expect(out).toMatchObject({ edges: [], notice });
    expect(out.nodes).toEqual([
      expect.objectContaining({ id: '10.5555/lonely', depth: 0, hydrated: true }),
    ]);
    expect(out.coverage.eventData).toEqual({
      status: 'ok',
      scope: 'both_sides',
      total: 0,
      fetched: 0,
      kept: 0,
    });
    const text = contentText(result);
    expect(text).toContain('## Edges (0)');
    expect(text).toContain(`> ${notice}`);
  });

  const noRelations =
    'No relations were found in DataCite metadata. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist.';

  it.each([
    {
      name: 'is disabled',
      input: { include_event_data: false },
      events: undefined,
      notice: noRelations,
    },
    {
      name: 'does not answer',
      input: {},
      events: rateLimitResponse,
      notice: `${noRelations} Event Data did not answer, so harvested citation links (mostly from journal articles) are missing; own and reverse metadata edges are complete up to the cap. Retry to include them.`,
    },
  ])(
    'names only DataCite metadata as searched when Event Data $name',
    async ({ input, events, notice }) => {
      const lonely = '10.5555/lonely';
      initServices([
        { match: rootRead(lonely), respond: json(doiList([record(lonely)])) },
        { match: reverseRead([lonely]), respond: json(emptyDoiList()) },
        ...(events ? [{ match: eventsRead, respond: events() }] : []),
      ]);
      const result = await run({ doi: lonely, ...input });
      expect(result.isError).toBeFalsy();
      const out = output(result);
      expect(out).toMatchObject({ edges: [], notice });
      expect(out.coverage.eventData.status).not.toBe('ok');
      expect(contentText(result)).toContain(`> ${notice}`);
    },
  );
});

describe('a journal-article root', () => {
  const HNHRG3 = fixtureJson<RawDoiList>('datacite/graph/hydrate-dryad-234-gbif-hnhrg3.json')
    .data[0] as RawDoiResource;
  const articleRoutes = () => [
    { match: rootRead(ARTICLE), respond: json(emptyDoiList()) },
    {
      match: reverseRead([ARTICLE]),
      respond: fixtureResponse('datacite/graph/article-reverse.json'),
    },
    {
      match: dataCite('/events', param('subj-id', `https://doi.org/${ARTICLE}`)),
      respond: fixtureResponse('datacite/graph/article-events.json'),
    },
    {
      match: idsRead,
      respond: byIds([
        gbifS6ctusRecord(),
        HNHRG3,
        linkingCopyRecord({
          doi: '10.1016/j.rse.2005.05.011',
          title: 'A Crossref reference DataCite holds a copy of',
          publicationYear: 2005,
        }),
        linkingCopyRecord({
          doi: ARTICLE,
          title: 'Article title from the linking copy',
          publicationYear: 2021,
        }),
      ]),
    },
  ];

  it('reaches the DataCite works its reference list cites and titles the root from a linking copy', async () => {
    const { http } = initServices(articleRoutes());
    const result = await run({ doi: ARTICLE, max_nodes: 3 });
    expect(result.isError).toBeFalsy();
    const out = output(result);
    expect(out.root).toEqual({
      doi: ARTICLE,
      isDataCiteDoi: false,
      title: 'Article title from the linking copy',
      resourceTypeGeneral: 'Text',
      publicationYear: 2021,
    });
    expect(
      out.nodes.map(({ id, depth, isDataCiteDoi, repositoryId }) => ({
        id,
        depth,
        isDataCiteDoi,
        repositoryId,
      })),
    ).toEqual([
      { id: ARTICLE, depth: 0, isDataCiteDoi: false, repositoryId: undefined },
      { id: '10.15468/s6ctus', depth: 1, isDataCiteDoi: true, repositoryId: 'gbif.gbif' },
      { id: '10.15468/hnhrg3', depth: 1, isDataCiteDoi: true, repositoryId: 'gbif.gbif' },
    ]);
    expect(out.edges).toEqual(
      ['10.15468/s6ctus', '10.15468/hnhrg3'].map((to) => ({
        from: ARTICLE,
        to,
        relationType: 'References',
        sources: ['event_data'],
        eventSources: ['crossref'],
      })),
    );
    expect(out).not.toHaveProperty('rootCounts');
    expect(out.coverage).toEqual({
      ownMetadata: { status: 'not_datacite', edgeCount: 0 },
      reverseMetadata: { status: 'ok', total: 0, fetched: 0 },
      eventData: {
        status: 'ok',
        scope: 'outgoing_to_datacite',
        total: 118,
        fetched: 5,
        kept: 2,
      },
    });
    const notice = `${ARTICLE} is not a DataCite DOI, so it has no DataCite metadata of its own; edges shown are DataCite records that point at it and, from Event Data, the DataCite works its own reference list cites.`;
    expect(out.notice).toBe(notice);
    // The dropped Crossref objects never spent the node budget: 3 nodes fit max_nodes 3.
    expect(out).not.toHaveProperty('truncated');

    const text = contentText(result);
    expect(text).toContain('**DataCite DOI:** false');
    expect(text).not.toContain('**DataCite counts:**');
    expect(text).toContain('- **Own metadata:** not_datacite · 0 asserted relations');
    expect(text).toContain(
      '- **Event Data:** ok · scope outgoing_to_datacite · total 118 · fetched 5 · kept 2',
    );
    expect(text).toContain(`> ${notice}`);

    const urls = requestUrls(http);
    expect(urls).toHaveLength(5);
    const events = urls.find((url) => url.pathname === '/events');
    expect(Object.fromEntries(events?.searchParams ?? [])).toEqual({
      'subj-id': `https://doi.org/${ARTICLE}`,
      'relation-type-id': CITATION_KEBAB,
      'page[size]': '100',
    });
    expect(
      urls.filter((url) => url.searchParams.has('ids')).map((u) => u.searchParams.get('ids')),
    ).toEqual([
      '10.1071/wr13028,10.1016/j.rse.2005.05.011,10.1016/j.rse.2018.02.064,10.15468/s6ctus,10.15468/hnhrg3',
      ARTICLE,
    ]);
  });
});

describe('depth 2', () => {
  const PART1_WITH_RELATIONS = dryad8515Part(1);
  PART1_WITH_RELATIONS.attributes.relatedIdentifiers?.push(
    {
      relationType: 'IsDerivedFrom',
      relatedIdentifier: '10.5555/raw-reads',
      relatedIdentifierType: 'DOI',
    },
    {
      relationType: 'IsDocumentedBy',
      relatedIdentifier: 'https://example.org/protocol',
      relatedIdentifierType: 'URL',
    },
  );
  const REUSE = record('10.5555/reuse', {
    titles: [{ title: 'Reanalysis' }],
    relatedIdentifiers: [
      { relationType: 'IsDerivedFrom', relatedIdentifier: PART1, relatedIdentifierType: 'DOI' },
    ],
  });

  it('expands DataCite neighbours through own and reverse metadata and merges the sources of one assertion', async () => {
    const { http } = initServices([
      ...dryad8515Routes([PPAT_COPY, PART1_WITH_RELATIONS, dryad8515Part(2)]),
      { match: reverseRead([PART1, PART2]), respond: json(doiList([REUSE])) },
    ]);
    const result = await run({ doi: ROOT, depth: 2 });
    const out = output(result);
    expect(out.nodes.map(({ id, depth, hydrated }) => [id, depth, hydrated])).toEqual([
      [ROOT, 0, true],
      [PPAT, 1, true],
      [PART1, 1, true],
      [PART2, 1, true],
      ['10.5555/raw-reads', 2, false],
      ['https://example.org/protocol', 2, false],
      ['10.5555/reuse', 2, true],
    ]);
    expect(out.nodes.find((n) => n.id === '10.5555/raw-reads')).not.toHaveProperty('isDataCiteDoi');
    expect(out.edges).toEqual([
      expect.objectContaining({ from: ROOT, to: PPAT, relationType: 'IsCitedBy' }),
      {
        from: PART1,
        to: ROOT,
        relationType: 'IsPartOf',
        sources: ['reverse_metadata', 'metadata'],
      },
      {
        from: PART2,
        to: ROOT,
        relationType: 'IsPartOf',
        sources: ['reverse_metadata', 'metadata'],
      },
      expect.objectContaining({ from: ROOT, to: PPAT, relationType: 'IsReferencedBy' }),
      expect.objectContaining({ from: ROOT, to: PPAT, relationType: 'IsSupplementTo' }),
      {
        from: PART1,
        to: '10.5555/raw-reads',
        relationType: 'IsDerivedFrom',
        sources: ['metadata'],
      },
      {
        from: PART1,
        to: 'https://example.org/protocol',
        relationType: 'IsDocumentedBy',
        sources: ['metadata'],
      },
      {
        from: '10.5555/reuse',
        to: PART1,
        relationType: 'IsDerivedFrom',
        sources: ['reverse_metadata'],
      },
    ]);
    expect(out).not.toHaveProperty('truncated');
    expect(contentText(result)).toContain(
      `- ${PART1} —IsPartOf→ ${ROOT} [reverse_metadata, metadata]`,
    );

    // root, reverse ∥ events, ids=ppat, frontier ids= ∥ reverse2, ids= second hop.
    const dois = requestUrls(http).filter((url) => url.pathname === '/dois');
    expect(http.calls).toHaveLength(7);
    for (const url of dois) expect(url.searchParams.get('sort')).toBe('-created');
    const frontier = dois.find(
      (url) => url.searchParams.get('fields[dois]') === NODE_WITH_RELATIONS_FIELDS,
    );
    expect(frontier?.searchParams.get('ids')).toBe(`${PART1},${PART2}`);
    const reverse2 = dois.find(
      (url) => url.searchParams.get('query') === reverseQuery([PART1, PART2]),
    );
    expect(reverse2?.searchParams.get('page[size]')).toBe('46');
    expect(
      dois
        .filter((url) => url.searchParams.get('fields[dois]') === NODE_FIELDS)
        .map((u) => u.searchParams.get('ids')),
    ).toEqual([PPAT, '10.5555/raw-reads']);
  });

  /** A hub whose 12 DataCite spokes each assert IsPartOf the hub. */
  const HUB = '10.5555/hub';
  const SPOKES = Array.from(
    { length: 12 },
    (_, i) => `10.5555/spoke-${String(i + 1).padStart(2, '0')}`,
  );
  const SPOKE_RECORDS = SPOKES.map((doi) =>
    record(doi, {
      relatedIdentifiers: [
        { relationType: 'IsPartOf', relatedIdentifier: HUB, relatedIdentifierType: 'DOI' },
      ],
    }),
  );
  const hubRoutes = () => [
    { match: rootRead(HUB), respond: json(doiList([record(HUB)])) },
    { match: reverseRead([HUB]), respond: json(doiList(SPOKE_RECORDS)) },
    { match: eventsRead, respond: json(eventList()) },
    { match: reverseRead(SPOKES.slice(0, 10)), respond: json(emptyDoiList()) },
    { match: idsRead, respond: byIds(SPOKE_RECORDS) },
  ];

  it('expands at most 10 DataCite frontier nodes, in admission order', async () => {
    const hub = HUB;
    const first10 = SPOKES.slice(0, 10);
    const { http } = initServices(hubRoutes());
    const result = await run({ doi: hub, depth: 2 });
    const out = output(result);
    expect(out.nodes).toHaveLength(13);
    const notice =
      'The second hop expanded the first 10 of 12 DataCite neighbours in node order (at most 10 per call), so the relations of the other 2 went untraced; trace one directly to follow its relations.';
    expect(out.notice).toBe(notice);
    expect(out).not.toHaveProperty('truncated');
    expect(contentText(result)).toContain(`> ${notice}`);
    const urls = requestUrls(http);
    expect(urls).toHaveLength(5);
    const frontier = urls.find((url) => url.searchParams.has('ids'));
    expect(frontier?.searchParams.get('ids')).toBe(first10.join(','));
    expect(frontier?.searchParams.get('fields[dois]')).toBe(NODE_WITH_RELATIONS_FIELDS);
    const reverse2 = urls.find((url) => url.searchParams.get('query') === reverseQuery(first10));
    expect(reverse2?.searchParams.get('page[size]')).toBe('37');
  });

  it('promises only the frontier when a filled first hop leaves more than 10 DataCite neighbours untraced', async () => {
    const { http } = initServices(hubRoutes());
    const result = await run({ doi: HUB, depth: 2, max_nodes: 13 });
    const out = output(result);
    const notice =
      'The first hop filled max_nodes=13, so the second hop was not expanded and the relations of 12 DataCite neighbours went untraced; raise max_nodes (≤ 100) to trace the first 10 of them.';
    expect(out).toMatchObject({ truncated: true, shown: 13, cap: 13, notice });
    expect(contentText(result)).toContain(`> ${notice}`);
    // root, reverse ∥ events — the spokes arrive hydrated from the reverse page, and no second hop.
    expect(http.calls).toHaveLength(3);
  });

  it('discloses the cap when the first hop fills max_nodes exactly and leaves no room for the second hop', async () => {
    const { http } = initServices(
      dryad8515Routes([PPAT_COPY, PART1_WITH_RELATIONS, dryad8515Part(2)]),
    );
    // Root + 3 first-hop nodes; PART1 and PART2 are DataCite nodes the second hop would expand.
    const result = await run({ doi: ROOT, depth: 2, max_nodes: 4 });
    const out = output(result);
    const notice =
      'The first hop filled max_nodes=4, so the second hop was not expanded and the relations of 2 DataCite neighbours went untraced; raise max_nodes (≤ 100) to trace them.';
    expect(out.nodes.map((n) => n.id)).toEqual([ROOT, PPAT, PART1, PART2]);
    expect(out).toMatchObject({ truncated: true, shown: 4, cap: 4, notice });
    const text = contentText(result);
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('**cap:** 4');
    expect(text).toContain(`> ${notice}`);
    // root, reverse ∥ events, ids=ppat — no frontier ids= and no second reverse query.
    expect(http.calls).toHaveLength(4);
  });

  it('names both the left-out identifiers and the unexpanded second hop when the first hop overflows', async () => {
    const { http } = initServices(
      dryad8515Routes([PPAT_COPY, PART1_WITH_RELATIONS, dryad8515Part(2)]),
    );
    const result = await run({ doi: ROOT, depth: 2, max_nodes: 3 });
    const out = output(result);
    const notice =
      '2 of 3 related identifiers fit max_nodes=3; raise max_nodes (≤ 100) or narrow relation_types. The first hop filled max_nodes=3, so the second hop was not expanded and the relations of 1 DataCite neighbour went untraced; raise max_nodes (≤ 100) to trace them.';
    expect(out.nodes.map((n) => n.id)).toEqual([ROOT, PPAT, PART1]);
    expect(out).toMatchObject({ truncated: true, shown: 3, cap: 3, notice });
    expect(contentText(result)).toContain(`> ${notice}`);
    expect(http.calls).toHaveLength(4);
  });

  it('does not bind the cap when the first hop fills max_nodes with no DataCite neighbour to expand', async () => {
    const leafy = '10.5555/leafy';
    const { http } = initServices([
      {
        match: rootRead(leafy),
        respond: json(
          doiList([
            record(leafy, {
              relatedIdentifiers: [
                {
                  relationType: 'IsDocumentedBy',
                  relatedIdentifier: 'https://example.org/protocol',
                  relatedIdentifierType: 'URL',
                },
              ],
            }),
          ]),
        ),
      },
      { match: reverseRead([leafy]), respond: json(emptyDoiList()) },
      { match: eventsRead, respond: json(eventList()) },
    ]);
    const result = await run({ doi: leafy, depth: 2, max_nodes: 2 });
    const out = output(result);
    expect(out.nodes.map((n) => n.id)).toEqual([leafy, 'https://example.org/protocol']);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
    const text = contentText(result);
    expect(text).not.toContain('**truncated:**');
    expect(text).not.toContain('max_nodes');
    expect(http.calls).toHaveLength(3);
  });
});

describe('the node cap', () => {
  it('fills the cap in budget order and discloses it in the enrichment and trailer', async () => {
    const { http } = initServices(dryad8515Routes());
    const result = await run({ doi: ROOT, max_nodes: 2 });
    const out = output(result);
    const notice =
      '1 of 3 related identifiers fit max_nodes=2; raise max_nodes (≤ 100) or narrow relation_types.';
    expect(out).toMatchObject({ truncated: true, shown: 2, cap: 2, notice });
    expect(out.nodes.map((n) => n.id)).toEqual([ROOT, PPAT]);
    expect(out.edges.map((e) => e.relationType)).toEqual([
      'IsCitedBy',
      'IsReferencedBy',
      'IsSupplementTo',
    ]);
    const text = contentText(result);
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('**shown:** 2');
    expect(text).toContain('**cap:** 2');
    expect(text).toContain(`> ${notice}`);
    const reverse = requestUrls(http).find(
      (url) => url.searchParams.get('query') === reverseQuery([ROOT]),
    );
    expect(reverse?.searchParams.get('page[size]')).toBe('2');
  });

  it('does not claim no relations were found when the cap removed them', async () => {
    initServices(dryad8515Routes());
    const result = await run({ doi: ROOT, max_nodes: 1 });
    const out = output(result);
    const notice =
      '0 of 3 related identifiers fit max_nodes=1; raise max_nodes (≤ 100) or narrow relation_types. DataCite records 1 citations for this DOI; 0 are shown. Citations accrue per DOI — trace the concept DOI and its version DOIs separately.';
    expect(out).toMatchObject({ truncated: true, shown: 1, cap: 1, edges: [], notice });
    const text = contentText(result);
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('No relations were found');
  });
});

describe('relation_types and Event Data', () => {
  it('narrows own, reverse, and event edges, suffixes the reverse query, and dedupes the filter', async () => {
    const mixed = record('10.5061/dryad.9999', {
      relatedIdentifiers: [
        { relationType: 'References', relatedIdentifier: ROOT, relatedIdentifierType: 'DOI' },
        {
          relationType: 'IsPartOf',
          relatedIdentifier: '10.5555/other',
          relatedIdentifierType: 'DOI',
        },
      ],
    });
    const { http } = initServices([
      { match: rootRead(ROOT), respond: fixtureResponse('datacite/graph/root-dryad-8515.json') },
      {
        match: reverseRead([ROOT], ['IsPartOf', 'IsCitedBy']),
        respond: json(doiList([...dryad8515ReversePage().data, mixed])),
      },
      { match: eventsRead, respond: fixtureResponse('datacite/graph/events-dryad-8515.json') },
      { match: idsRead, respond: byIds([PPAT_COPY]) },
    ]);
    const out = output(
      await run({ doi: ROOT, relation_types: ['isPartOf', 'IS_CITED_BY', 'IsPartOf'] }),
    );
    expect(out.edges.map((e) => [e.from, e.relationType, e.sources])).toEqual([
      [ROOT, 'IsCitedBy', ['metadata', 'event_data']],
      [PART1, 'IsPartOf', ['reverse_metadata']],
      [PART2, 'IsPartOf', ['reverse_metadata']],
    ]);
    // 10.5061/dryad.9999 matched upstream on an IsPartOf attached to another identifier.
    expect(out.nodes.map((n) => n.id)).toEqual([ROOT, PPAT, PART1, PART2]);
    expect(out.coverage.ownMetadata.edgeCount).toBe(1);
    expect(out.coverage.eventData).toMatchObject({ status: 'ok', fetched: 3, kept: 1 });
    const events = requestUrls(http).find((url) => url.pathname === '/events');
    expect(events?.searchParams.get('relation-type-id')).toBe('is-cited-by');
  });

  it('skips Event Data when relation_types admits no citation type', async () => {
    const { http } = initServices([
      { match: rootRead(ROOT), respond: fixtureResponse('datacite/graph/root-dryad-8515.json') },
      { match: reverseRead([ROOT], ['HasPart']), respond: json(emptyDoiList()) },
    ]);
    const result = await run({ doi: ROOT, relation_types: ['has_part'] });
    const detail =
      'relation_types admits no citation relation type, the only kind Event Data carries.';
    expect(output(result).coverage.eventData).toEqual({ status: 'skipped', detail });
    expect(contentText(result)).toContain(`- **Event Data:** skipped · ${detail}`);
    expect(requestUrls(http).map((url) => url.pathname)).toEqual(['/dois', '/dois']);
  });

  it('skips Event Data when include_event_data is false', async () => {
    const { http } = initServices(dryad8515Routes());
    const out = output(await run({ doi: ROOT, include_event_data: false }));
    expect(out.coverage.eventData).toEqual({
      status: 'skipped',
      detail: 'include_event_data is false.',
    });
    expect(out.edges).toEqual([
      { from: ROOT, to: PPAT, relationType: 'IsCitedBy', sources: ['metadata'] },
      expect.objectContaining({ from: PART1 }),
      expect.objectContaining({ from: PART2 }),
    ]);
    expect(requestUrls(http).some((url) => url.pathname === '/events')).toBe(false);
  });

  const unavailableNotice =
    'Event Data did not answer, so harvested citation links (mostly from journal articles) are missing; own and reverse metadata edges are complete up to the cap. Retry to include them.';

  it('degrades a rate-limited Event Data read to unavailable with a notice', async () => {
    initServices([{ match: eventsRead, respond: rateLimitResponse() }, ...dryad8515Routes()]);
    const result = await run({ doi: ROOT });
    expect(result.isError).toBeFalsy();
    const out = output(result);
    expect(out.coverage.eventData).toEqual({
      status: 'unavailable',
      scope: 'both_sides',
      detail: expect.stringContaining(
        'Event Data did not answer (DataCite rate limit reached (HTTP 429)',
      ),
    });
    expect(out.edges).toHaveLength(3);
    expect(out.notice).toBe(unavailableNotice);
    expect(contentText(result)).toContain(`> ${unavailableNotice}`);
    expect(contentText(result)).toContain(
      '- **Event Data:** unavailable · scope both_sides · Event Data did not answer',
    );
  });

  it('degrades an Event Data outage to unavailable after its retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { http } = initServices([
      { match: eventsRead, respond: json({ errors: [] }, { status: 503 }) },
      ...dryad8515Routes(),
    ]);
    const pending = run({ doi: ROOT });
    await vi.advanceTimersByTimeAsync(10_000);
    const out = output(await pending);
    expect(out.coverage.eventData).toMatchObject({ status: 'unavailable', scope: 'both_sides' });
    expect(out.notice).toBe(unavailableNotice);
    expect(
      http.calls.filter((call) => new URL(call.request.url).pathname === '/events'),
    ).toHaveLength(3);
  });

  it('propagates an Event Data 400 instead of reading it as an outage', async () => {
    initServices([
      { match: eventsRead, respond: json({ errors: [{ status: '400' }] }, { status: 400 }) },
      ...dryad8515Routes(),
    ]);
    const result = await run({ doi: ROOT });
    const error = toolError(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBeUndefined();
    expect(contentText(result)).toContain('DataCite returned HTTP 400');
  });
});

describe('declared errors and input', () => {
  it.each(['10.12/x', '10.5061/', 'https://doi.org/10.5061/'])(
    'rejects %j as invalid_doi before any request',
    async (doi) => {
      const { http } = initServices(dryad8515Routes());
      const result = await run({ doi });
      expectToolError(result, 'invalid_doi', JsonRpcErrorCode.ValidationError);
      expect(contentText(result)).toContain(
        'Recovery: Pass the root as a DOI such as 10.5061/dryad.234',
      );
      expect(http.calls).toHaveLength(0);
    },
  );

  it('surfaces an exhausted budget on the root read as rate_limited with the wait', async () => {
    const { http } = initServices([{ match: rootRead(ROOT), respond: rateLimitResponse() }]);
    const result = await run({ doi: ROOT });
    const error = expectToolError(result, 'rate_limited', JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ retryAfter: 30, retryable: true });
    expect(error.message).toContain('retry in 30 seconds');
    expect(contentText(result)).toContain('(reason rate_limited · retryable)');
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    {
      hop: 'the second hop',
      input: { doi: ROOT, depth: 2 },
      routes: () => [
        { match: reverseRead([PART1, PART2]), respond: rateLimitResponse() },
        ...dryad8515Routes([PPAT_COPY, dryad8515Part(1), dryad8515Part(2)]),
      ],
    },
    {
      hop: "the hydration of a journal article's cited objects",
      input: { doi: ARTICLE },
      routes: () => [
        { match: rootRead(ARTICLE), respond: json(emptyDoiList()) },
        { match: reverseRead([ARTICLE]), respond: json(emptyDoiList()) },
        { match: eventsRead, respond: fixtureResponse('datacite/graph/article-events.json') },
        { match: idsRead, respond: rateLimitResponse() },
      ],
    },
  ])(
    'surfaces an exhausted budget on $hop as rate_limited rather than a partial graph',
    async ({ input, routes }) => {
      initServices(routes());
      const result = await run(input);
      const error = expectToolError(result, 'rate_limited', JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ retryAfter: 30, retryable: true });
      expect(error.message).toContain('retry in 30 seconds');
    },
  );

  it('logs invalid_doi at notice and a spent budget at error', () => {
    expect(declaredSeverities(traceRelationsTool.errors)).toEqual({
      invalid_doi: 'notice',
      rate_limited: 'error',
    });
  });

  it('treats blank depth, max_nodes, and relation_types entries as unset', async () => {
    const { http } = initServices(dryad8515Routes());
    const out = output(
      await run({
        doi: ROOT,
        depth: '',
        max_nodes: ' ',
        relation_types: ['', '  '],
      } as unknown as Input),
    );
    expect(out.nodes).toHaveLength(4);
    const reverse = requestUrls(http).find(
      (url) => url.searchParams.get('query') === reverseQuery([ROOT]),
    );
    expect(reverse?.searchParams.get('page[size]')).toBe('50');
  });

  it.each([
    { doi: 'dryad.8515' },
    { doi: ROOT, depth: 0 },
    { doi: ROOT, depth: 3 },
    { doi: ROOT, max_nodes: 0 },
    { doi: ROOT, max_nodes: 101 },
    { doi: ROOT, relation_types: ['Likes'] },
  ])('rejects the malformed input %j at the schema', async (input) => {
    const { http } = initServices(dryad8515Routes());
    const result = await run(input as Input);
    const error = expectToolError(result, 'invalid_arguments', JsonRpcErrorCode.InvalidParams);
    expect(error.message).toContain(Object.keys(input).at(-1) as string);
    expect(http.calls).toHaveLength(0);
  });
});
