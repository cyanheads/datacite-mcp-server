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
import { type FetchMockHarness, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  hang,
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
  edgesFound?: number;
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

/**
 * A fake of a `/dois` query page: the first `page[size]` records, with `meta.total`
 * counting every match (`total`, by default the records given) — as the upstream pages.
 */
const paged =
  (records: RawDoiResource[], total = records.length) =>
  (request: Request): Response => {
    const size = Number(new URL(request.url).searchParams.get('page[size]'));
    return json(doiList(records.slice(0, size), { total }));
  };

const eventList = (events: RawEventList['data'] = []): RawEventList => ({
  data: events,
  meta: { total: events.length },
});

/** An Event Data link between two DOIs, as the upstream stores it. */
const event = (
  subj: string,
  relationTypeId: string,
  obj: string,
): RawEventList['data'][number] => ({
  id: `${subj} ${relationTypeId} ${obj}`,
  attributes: {
    'subj-id': `https://doi.org/${subj}`,
    'relation-type-id': relationTypeId,
    'obj-id': `https://doi.org/${obj}`,
    'source-id': 'crossref',
  },
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

/** `count` DataCite spokes each asserting IsPartOf `hub`, as the hub's reverse page returns them. */
const spokesOf = (hub: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    record(`${hub}-spoke-${String(i + 1).padStart(3, '0')}`, {
      relatedIdentifiers: [
        { relationType: 'IsPartOf', relatedIdentifier: hub, relatedIdentifierType: 'DOI' },
      ],
    }),
  );

const PPAT_COPY = linkingCopyRecord({
  doi: PPAT,
  title: 'A new malaria agent in African hominids',
  publicationYear: 2009,
  citationCount: 7,
});

/** The dryad.8515 world: recorded root and events, constructed reverse page and hydration. */
const dryad8515Routes = (hydrated: RawDoiResource[] = [PPAT_COPY]) => [
  { match: rootRead(ROOT), respond: fixtureResponse('datacite/graph/root-dryad-8515.json') },
  { match: reverseRead([ROOT]), respond: paged(dryad8515ReversePage().data) },
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

  it('reads the root, a first reverse page of 10, Event Data on both sides, then one ids= batch, newest first', async () => {
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
      'page[size]': '10',
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
      'page[size]': '10',
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
    // No version DOIs and nothing cut short: the count has no cause this call can name.
    const notice =
      "No relations were found in DataCite metadata or Event Data. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist. DataCite records 3 citations for this DOI; 0 are shown. Every source was read in full, so DataCite's count includes citations no edge records.";
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

  it('asks Event Data only for the outgoing citation types relation_types admits', async () => {
    const { http } = initServices([
      {
        match: reverseRead([ARTICLE], ['IsReferencedBy']),
        respond: fixtureResponse('datacite/graph/article-reverse.json'),
      },
      ...articleRoutes(),
    ]);
    const result = await run({ doi: ARTICLE, max_nodes: 3, relation_types: ['References'] });
    expect(output(result).edges.map((e) => [e.from, e.relationType, e.to])).toEqual([
      [ARTICLE, 'References', '10.15468/s6ctus'],
      [ARTICLE, 'References', '10.15468/hnhrg3'],
    ]);
    const text = contentText(result);
    expect(text).toContain('## Edges (2)');
    expect(text).toContain(`- ${ARTICLE} —References→ 10.15468/s6ctus [event_data`);
    // The root is only ever the subject of an outgoing event, so the inverse type is not asked for.
    const events = requestUrls(http).find((url) => url.pathname === '/events');
    expect(events?.searchParams.get('relation-type-id')).toBe('references');
  });

  it('names Event Data as a source in the root notice only when it was read', async () => {
    const { http } = initServices(articleRoutes());
    const result = await run({ doi: ARTICLE, include_event_data: false });
    const out = output(result);
    expect(out.coverage.eventData).toEqual({
      status: 'skipped',
      detail: 'include_event_data is false.',
    });
    const notice = `${ARTICLE} is not a DataCite DOI, so it has no DataCite metadata of its own; edges shown are DataCite records that point at it. No relations were found in DataCite metadata. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist.`;
    expect(out.notice).toBe(notice);
    const text = contentText(result);
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('from Event Data');
    expect(requestUrls(http).some((url) => url.pathname === '/events')).toBe(false);
  });

  it('says DataCite holds no record, not that another agency does, when no linking copy comes back', async () => {
    const unknown = '10.5061/dryad.zzzz9999notreal';
    initServices([
      { match: rootRead(unknown), respond: json(emptyDoiList()) },
      { match: reverseRead([unknown]), respond: json(emptyDoiList()) },
      {
        match: dataCite('/events', param('subj-id', `https://doi.org/${unknown}`)),
        respond: json(eventList()),
      },
      { match: idsRead, respond: byIds([]) },
    ]);
    const result = await run({ doi: unknown });
    const out = output(result);
    expect(out.root).toEqual({ doi: unknown, isDataCiteDoi: false });
    expect(out.nodes).toEqual([{ id: unknown, idType: 'DOI', depth: 0, hydrated: false }]);
    const notice = `DataCite holds no public record for ${unknown}, so it has no DataCite metadata of its own; edges shown are DataCite records that point at it and, from Event Data, the DataCite works its own reference list cites. datacite_get_work says whether another agency registered it, no agency did, or it is a DataCite DOI without public metadata. No relations were found in DataCite metadata or Event Data. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist.`;
    expect(out.notice).toBe(notice);
    const text = contentText(result);
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('is not a DataCite DOI');
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
    expect(reverse2?.searchParams.get('page[size]')).toBe('10');
    expect(
      dois
        .filter((url) => url.searchParams.get('fields[dois]') === NODE_FIELDS)
        .map((u) => u.searchParams.get('ids')),
    ).toEqual([PPAT, '10.5555/raw-reads']);
  });

  /** Records deriving from PART1 that only the second hop's reverse query finds. */
  const reuses = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      record(`10.5555/reuse-${i + 1}`, {
        relatedIdentifiers: [
          { relationType: 'IsDerivedFrom', relatedIdentifier: PART1, relatedIdentifierType: 'DOI' },
        ],
      }),
    );

  it('counts every record the second-hop reverse query returns, not only those that fit the room left', async () => {
    const { http } = initServices([
      ...dryad8515Routes([PPAT_COPY, dryad8515Part(1), dryad8515Part(2)]),
      { match: reverseRead([PART1, PART2]), respond: paged(reuses(3)) },
    ]);
    // Root + 3 first-hop nodes leave room for one second-hop node of the three found.
    const result = await run({ doi: ROOT, depth: 2, max_nodes: 5 });
    const out = output(result);
    const notice =
      '4 of 6 related identifiers fit max_nodes=5; raise max_nodes (≤ 100), narrow relation_types, or trace a depth-1 neighbour directly to follow its relations.';
    expect(out.nodes.map(({ id, depth }) => [id, depth])).toEqual([
      [ROOT, 0],
      [PPAT, 1],
      [PART1, 1],
      [PART2, 1],
      ['10.5555/reuse-1', 2],
    ]);
    expect(out).toMatchObject({ truncated: true, shown: 5, cap: 5, notice });
    expect(out.coverage.reverseMetadata).toEqual({
      status: 'ok',
      total: 2,
      fetched: 2,
      secondHop: { total: 3, fetched: 3 },
    });
    const text = contentText(result);
    expect(text).toContain('**truncated:** true');
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain(
      '- **Reverse metadata:** ok · fetched 2 of 2 records · second hop fetched 3 of 3 records',
    );
    const reverse2 = requestUrls(http).find(
      (url) => url.searchParams.get('query') === reverseQuery([PART1, PART2]),
    );
    expect(reverse2?.searchParams.get('page[size]')).toBe('10');
  });

  it('discloses the records the second-hop reverse query matched past the 100 it reads', async () => {
    const { http } = initServices([
      ...dryad8515Routes([PPAT_COPY, dryad8515Part(1), dryad8515Part(2)]),
      { match: reverseRead([PART1, PART2]), respond: paged(reuses(100), 250) },
    ]);
    const result = await run({ doi: ROOT, depth: 2, max_nodes: 100 });
    const out = output(result);
    expect(out.coverage.reverseMetadata.secondHop).toEqual({ total: 250, fetched: 100 });
    // A first page of 10 small records, then the page of 100.
    const reverse2 = requestUrls(http).filter(
      (url) => url.searchParams.get('query') === reverseQuery([PART1, PART2]),
    );
    expect(reverse2.map((url) => url.searchParams.get('page[size]'))).toEqual(['10', '100']);
    expect(out.nodes).toHaveLength(100);
    // At the maximum, only the steps that still reach the second-hop nodes left out.
    const notice =
      '99 of 103 related identifiers fit max_nodes=100 (the maximum); narrow relation_types or trace a depth-1 neighbour directly to follow its relations.';
    expect(out).toMatchObject({ truncated: true, shown: 100, cap: 100, notice });
    const text = contentText(result);
    expect(text).toContain(
      '- **Reverse metadata:** ok · fetched 2 of 2 records · second hop fetched 100 of 250 records',
    );
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('raise max_nodes');
  });

  it("reads relation_types from each expanded neighbour's side on the second hop", async () => {
    const part1 = dryad8515Part(1);
    part1.attributes.relatedIdentifiers?.push(
      {
        relationType: 'HasPart',
        relatedIdentifier: '10.5555/file-a',
        relatedIdentifierType: 'DOI',
      },
      {
        relationType: 'IsDerivedFrom',
        relatedIdentifier: '10.5555/raw-reads',
        relatedIdentifierType: 'DOI',
      },
    );
    const subpart = record('10.5555/file-b', {
      relatedIdentifiers: [
        { relationType: 'IsPartOf', relatedIdentifier: PART2, relatedIdentifierType: 'DOI' },
      ],
    });
    // Matched upstream on an IsPartOf attached to another identifier.
    const derived = record('10.5555/derived', {
      relatedIdentifiers: [
        { relationType: 'IsDerivedFrom', relatedIdentifier: PART1, relatedIdentifierType: 'DOI' },
        {
          relationType: 'IsPartOf',
          relatedIdentifier: '10.5555/elsewhere',
          relatedIdentifierType: 'DOI',
        },
      ],
    });
    const { http } = initServices([
      { match: rootRead(ROOT), respond: fixtureResponse('datacite/graph/root-dryad-8515.json') },
      { match: reverseRead([ROOT], ['IsPartOf']), respond: paged(dryad8515ReversePage().data) },
      {
        match: reverseRead([PART1, PART2], ['IsPartOf']),
        respond: json(doiList([subpart, derived])),
      },
      { match: idsRead, respond: byIds([part1, dryad8515Part(2)]) },
    ]);
    const result = await run({ doi: ROOT, depth: 2, relation_types: ['HasPart'] });
    const out = output(result);
    // PART1's own IsPartOf the root is its parent, not a part, so its own read adds no source.
    expect(out.edges).toEqual([
      { from: PART1, to: ROOT, relationType: 'IsPartOf', sources: ['reverse_metadata'] },
      { from: PART2, to: ROOT, relationType: 'IsPartOf', sources: ['reverse_metadata'] },
      { from: PART1, to: '10.5555/file-a', relationType: 'HasPart', sources: ['metadata'] },
      {
        from: '10.5555/file-b',
        to: PART2,
        relationType: 'IsPartOf',
        sources: ['reverse_metadata'],
      },
    ]);
    expect(out.nodes.map(({ id, depth }) => [id, depth])).toEqual([
      [ROOT, 0],
      [PART1, 1],
      [PART2, 1],
      ['10.5555/file-a', 2],
      ['10.5555/file-b', 2],
    ]);
    const text = contentText(result);
    expect(text).toContain(`- ${PART1} —HasPart→ 10.5555/file-a [metadata]`);
    expect(text).toContain(`- 10.5555/file-b —IsPartOf→ ${PART2} [reverse_metadata]`);
    expect(requestUrls(http).some((url) => url.pathname === '/events')).toBe(false);
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
    expect(reverse2?.searchParams.get('page[size]')).toBe('10');
  });

  it('promises only the frontier when a filled first hop leaves more than 10 DataCite neighbours untraced', async () => {
    const { http } = initServices(hubRoutes());
    const result = await run({ doi: HUB, depth: 2, max_nodes: 13 });
    const out = output(result);
    const notice =
      'The first hop filled max_nodes=13, so the second hop was not expanded and the relations of 12 DataCite neighbours went untraced; raise max_nodes to at least 14 (≤ 100) to trace the first 10 of them.';
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
      'The first hop filled max_nodes=4, so the second hop was not expanded and the relations of 2 DataCite neighbours went untraced; raise max_nodes to at least 5 (≤ 100) to trace them.';
    expect(out.nodes.map((n) => n.id)).toEqual([ROOT, PPAT, PART1, PART2]);
    expect(out).toMatchObject({ truncated: true, shown: 4, cap: 4, notice });
    const text = contentText(result);
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('**cap:** 4');
    expect(text).toContain(`> ${notice}`);
    // root, reverse ∥ events, ids=ppat — no frontier ids= and no second reverse query.
    expect(http.calls).toHaveLength(4);
    expect(out.coverage.reverseMetadata).not.toHaveProperty('secondHop');
    expect(text).not.toContain('second hop fetched');
  });

  it('names both the left-out identifiers and the unexpanded second hop when the first hop overflows', async () => {
    const { http } = initServices(
      dryad8515Routes([PPAT_COPY, PART1_WITH_RELATIONS, dryad8515Part(2)]),
    );
    const result = await run({ doi: ROOT, depth: 2, max_nodes: 3 });
    const out = output(result);
    const notice =
      '2 of 3 related identifiers fit max_nodes=3; raise max_nodes (≤ 100) or narrow relation_types. The first hop filled max_nodes=3, so the second hop was not expanded and the relations of 1 DataCite neighbour went untraced; raise max_nodes to at least 5 (≤ 100) to trace them.';
    expect(out.nodes.map((n) => n.id)).toEqual([ROOT, PPAT, PART1]);
    expect(out).toMatchObject({ truncated: true, shown: 3, cap: 3, notice });
    expect(contentText(result)).toContain(`> ${notice}`);
    expect(http.calls).toHaveLength(4);
  });

  const noRoom = 'no max_nodes value leaves the second hop room, so';

  it.each([
    {
      name: 'names the one max_nodes value that leaves the second hop room',
      spokes: 98,
      maxNodes: 99,
      relationTypes: undefined,
      notice:
        'The first hop filled max_nodes=99, so the second hop was not expanded and the relations of 98 DataCite neighbours went untraced; raise max_nodes to 100 to trace the first 10 of them.',
    },
    {
      name: 'offers no max_nodes value when the first hop alone needs every node',
      spokes: 99,
      maxNodes: 99,
      relationTypes: undefined,
      notice: `98 of 99 related identifiers fit max_nodes=99; raise max_nodes (≤ 100) or narrow relation_types. The first hop filled max_nodes=99, so the second hop was not expanded and the relations of 98 DataCite neighbours went untraced; ${noRoom} narrow relation_types or trace a neighbour directly to follow its relations.`,
    },
    {
      name: 'names only the steps left at max_nodes 100',
      spokes: 100,
      maxNodes: 100,
      relationTypes: undefined,
      notice: `99 of 100 related identifiers fit max_nodes=100 (the maximum); narrow relation_types. The first hop filled max_nodes=100, so the second hop was not expanded and the relations of 99 DataCite neighbours went untraced; ${noRoom} narrow relation_types or trace a neighbour directly to follow its relations.`,
    },
    {
      name: 'drops narrowing when relation_types already names one type',
      spokes: 100,
      maxNodes: 100,
      relationTypes: ['HasPart'],
      notice: `99 of 100 related identifiers fit max_nodes=100 (the maximum); pass query relatedIdentifiers.relatedIdentifier:"10.5555/wide-hub" to datacite_search_works to list the DataCite records that point at this DOI. The first hop filled max_nodes=100, so the second hop was not expanded and the relations of 99 DataCite neighbours went untraced; ${noRoom} trace a neighbour directly to follow its relations.`,
    },
  ])('$name', async ({ spokes, maxNodes, relationTypes, notice }) => {
    const hub = '10.5555/wide-hub';
    initServices([
      { match: rootRead(hub), respond: json(doiList([record(hub)])) },
      {
        match: reverseRead([hub], relationTypes && ['IsPartOf']),
        respond: paged(spokesOf(hub, spokes)),
      },
      { match: eventsRead, respond: json(eventList()) },
    ]);
    const result = await run({
      doi: hub,
      depth: 2,
      max_nodes: maxNodes,
      ...(relationTypes && { relation_types: relationTypes }),
    });
    const out = output(result);
    expect(out).toMatchObject({ truncated: true, shown: maxNodes, cap: maxNodes, notice });
    expect(out.coverage.reverseMetadata).not.toHaveProperty('secondHop');
    const text = contentText(result);
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('(≤ 100) to trace');
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
    expect(reverse?.searchParams.get('page[size]')).toBe('10');
  });

  it.each([1, 2, 3])(
    'counts every record the reverse query returns whatever max_nodes is (max_nodes %i)',
    async (maxNodes) => {
      const { http } = initServices(dryad8515Routes());
      const result = await run({ doi: ROOT, max_nodes: maxNodes });
      const out = output(result);
      const notice = `${maxNodes - 1} of 3 related identifiers fit max_nodes=${maxNodes}; raise max_nodes (≤ 100) or narrow relation_types.`;
      expect(out.notice).toContain(notice);
      expect(out.coverage.reverseMetadata).toEqual({ status: 'ok', total: 2, fetched: 2 });
      const text = contentText(result);
      expect(text).toContain(notice);
      expect(text).toContain('- **Reverse metadata:** ok · fetched 2 of 2 records\n');
      const reverse = requestUrls(http).find(
        (url) => url.searchParams.get('query') === reverseQuery([ROOT]),
      );
      expect(reverse?.searchParams.get('page[size]')).toBe('10');
    },
  );

  it('does not claim no relations were found when the cap removed them', async () => {
    initServices(dryad8515Routes());
    const result = await run({ doi: ROOT, max_nodes: 1 });
    const out = output(result);
    const notice =
      '0 of 3 related identifiers fit max_nodes=1; raise max_nodes (≤ 100) or narrow relation_types. DataCite records 1 citation for this DOI; 0 are shown. max_nodes=1 left 1 citing work out.';
    expect(out).toMatchObject({ truncated: true, shown: 1, cap: 1, edges: [], notice });
    const text = contentText(result);
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('No relations were found');
  });

  /** A root asserting `count` URL leaves of one relation type. */
  const WIDE = '10.5555/wide';
  const wideRoot = (count: number) =>
    record(WIDE, {
      relatedIdentifiers: Array.from({ length: count }, (_, i) => ({
        relationType: 'IsDocumentedBy',
        relatedIdentifier: `https://example.org/doc-${i + 1}`,
        relatedIdentifierType: 'URL',
      })),
    });

  it.each([
    {
      name: 'offers narrowing, not a higher max_nodes, at the maximum',
      relationTypes: undefined,
      notice:
        '99 of 101 related identifiers fit max_nodes=100 (the maximum); narrow relation_types.',
    },
    {
      name: 'names no step at the maximum when relation_types names one type and no record points at the DOI',
      relationTypes: ['IsDocumentedBy'],
      notice: '99 of 101 related identifiers fit max_nodes=100 (the maximum).',
    },
  ])('$name', async ({ relationTypes, notice }) => {
    initServices([
      { match: rootRead(WIDE), respond: json(doiList([wideRoot(101)])) },
      {
        match: reverseRead([WIDE], relationTypes && ['Documents']),
        respond: json(emptyDoiList()),
      },
      { match: eventsRead, respond: json(eventList()) },
    ]);
    const result = await run({
      doi: WIDE,
      max_nodes: 100,
      ...(relationTypes && { relation_types: relationTypes }),
    });
    const out = output(result);
    expect(out).toMatchObject({ truncated: true, shown: 100, cap: 100, notice });
    const text = contentText(result);
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('raise max_nodes');
  });

  it('points to datacite_search_works when no step is left and records point at the DOI', async () => {
    const hub = '10.5555/wide-hub';
    const { http } = initServices([
      { match: rootRead(hub), respond: json(doiList([record(hub)])) },
      { match: reverseRead([hub], ['IsPartOf']), respond: paged(spokesOf(hub, 101)) },
    ]);
    const result = await run({ doi: hub, max_nodes: 100, relation_types: ['HasPart'] });
    const out = output(result);
    const notice = `99 of 100 related identifiers fit max_nodes=100 (the maximum); pass query relatedIdentifiers.relatedIdentifier:"${hub}" to datacite_search_works to list the DataCite records that point at this DOI.`;
    expect(out).toMatchObject({ truncated: true, shown: 100, cap: 100, notice });
    expect(out.coverage.reverseMetadata).toEqual({ status: 'ok', total: 101, fetched: 100 });
    // The first 10 spokes list one related identifier each, so the page of 100 is read.
    const reverse = requestUrls(http).filter(
      (url) => url.searchParams.get('query') === reverseQuery([hub], ['IsPartOf']),
    );
    expect(reverse.map((url) => url.searchParams.get('page[size]'))).toEqual(['10', '100']);
    const text = contentText(result);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain('- **Reverse metadata:** ok · fetched 100 of 101 records\n');
  });
});

describe('the edge cap', () => {
  const DENSE = '10.5555/dense';
  const TARGET = '10.5555/dense-target';
  /** `count` distinct free-text relation types, numbered in assertion order. */
  const relationTypes = (count: number) =>
    Array.from({ length: count }, (_, i) => `Relation${String(i + 1).padStart(4, '0')}`);
  /** A root asserting `count` distinct relation types toward one DOI. */
  const denseRoot = (count: number, attributes: RawDoiAttributes = {}) =>
    record(DENSE, {
      ...attributes,
      relatedIdentifiers: relationTypes(count).map((relationType) => ({
        relationType,
        relatedIdentifier: TARGET,
        relatedIdentifierType: 'DOI',
      })),
    });
  const denseRoutes = (root: RawDoiResource, events: RawEventList['data'] = []) => [
    { match: rootRead(DENSE), respond: json(doiList([root])) },
    { match: reverseRead([DENSE]), respond: json(emptyDoiList()) },
    { match: eventsRead, respond: json(eventList(events)) },
    { match: idsRead, respond: byIds([]) },
  ];

  it('returns the first 1,000 edges found and discloses the cap on both surfaces', async () => {
    initServices(denseRoutes(denseRoot(1200)));
    const result = await run({ doi: DENSE });
    const out = output(result);
    const notice =
      '1,000 of 1,200 edges between the returned nodes are shown (at most 1,000 per call), in the order found: own metadata, records pointing at the root, Event Data, then the second hop; narrow relation_types or trace a returned node directly to see the rest of its edges.';
    expect(out).toMatchObject({ truncated: true, edgesFound: 1200, notice });
    expect(out.shown).toBeUndefined();
    expect(out.cap).toBeUndefined();
    expect(out.nodes.map((n) => n.id)).toEqual([DENSE, TARGET]);
    expect(out.edges.map((e) => e.relationType)).toEqual(relationTypes(1000));
    expect(out.coverage.ownMetadata).toEqual({ status: 'ok', edgeCount: 1200 });
    const text = contentText(result);
    expect(text).toContain('## Edges (1000)');
    expect(text).toContain(`- ${DENSE} —Relation1000→ ${TARGET} [metadata]`);
    expect(text).not.toContain('Relation1001');
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('**edgesFound:** 1200');
    expect(text).not.toContain('**shown:**');
    expect(text).toContain(`> ${notice}`);
  });

  it('attributes citing works cut by each cap to that cap when both bind', async () => {
    const citers = ['10.5555/citer-1', '10.5555/citer-2', '10.5555/citer-3'];
    const events = citers.flatMap((citer) => [
      event(citer, 'cites', DENSE),
      event(DENSE, 'is-cited-by', citer),
    ]);
    initServices(denseRoutes(denseRoot(1000, { citationCount: 3 }), events));
    const result = await run({ doi: DENSE, max_nodes: 4 });
    const out = output(result);
    const notice = [
      '3 of 4 related identifiers fit max_nodes=4; raise max_nodes (≤ 100) or narrow relation_types.',
      '1,000 of 1,004 edges between the returned nodes are shown (at most 1,000 per call), in the order found: own metadata, records pointing at the root, Event Data, then the second hop; narrow relation_types or trace a returned node directly to see the rest of its edges.',
      'DataCite records 3 citations for this DOI; 0 are shown. max_nodes=4 left 1 citing work out. The 1,000-edge cap dropped the edges recording 2 citing works.',
    ].join(' ');
    expect(out).toMatchObject({ truncated: true, shown: 4, cap: 4, edgesFound: 1004, notice });
    expect(out.nodes.map((n) => n.id)).toEqual([DENSE, TARGET, citers[0], citers[1]]);
    expect(out.edges).toHaveLength(1000);
    expect(out.edges.every((e) => e.to === TARGET)).toBe(true);
    const text = contentText(result);
    expect(text).toContain('**shown:** 4');
    expect(text).toContain('**cap:** 4');
    expect(text).toContain('**edgesFound:** 1004');
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('—Cites→');
  });

  it('returns exactly 1,000 edges whole, with no cap disclosed', async () => {
    initServices(denseRoutes(denseRoot(1000)));
    const result = await run({ doi: DENSE });
    const out = output(result);
    expect(out.edges.map((e) => e.relationType)).toEqual(relationTypes(1000));
    expect(out.truncated).toBeUndefined();
    expect(out.edgesFound).toBeUndefined();
    expect(out.notice).toBeUndefined();
    const text = contentText(result);
    expect(text).toContain(`- ${DENSE} —Relation1000→ ${TARGET} [metadata]`);
    expect(text).not.toContain('truncated');
    expect(text).not.toContain('edgesFound');
  });
});

describe('large reverse records', () => {
  const DATASET = '10.15468/m8zqqy';
  /** 3,999 other datasets a download derives from — about 400 KB of related identifiers. */
  const OTHER_DATASETS = Array.from({ length: 3_999 }, (_, i) => ({
    relationType: 'IsDerivedFrom',
    relatedIdentifier: `10.15468/${String(i).padStart(6, '0')}`,
    relatedIdentifierType: 'DOI',
  }));
  /** `count` GBIF-download-like records, each deriving from `root` among 4,000 datasets. */
  const downloads = (root: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      record(
        `10.15468/dl.${String(i + 1).padStart(4, '0')}`,
        {
          relatedIdentifiers: [
            {
              relationType: 'IsDerivedFrom',
              relatedIdentifier: root,
              relatedIdentifierType: 'DOI',
            },
            ...OTHER_DATASETS,
          ],
        },
        'gbif.gbif',
      ),
    );

  it('reads 10 records, not a 100-record page past the body limit, and discloses the cut on both surfaces', async () => {
    // A page of 100 of these records is about 40 MB, over the 32,000,000-byte body limit.
    const { http } = initServices([
      { match: rootRead(DATASET), respond: json(doiList([record(DATASET, {}, 'gbif.gbif')])) },
      { match: reverseRead([DATASET]), respond: paged(downloads(DATASET, 100), 9262) },
      { match: eventsRead, respond: json(eventList()) },
      { match: idsRead, respond: byIds([]) },
    ]);
    const result = await run({ doi: DATASET });
    const out = output(result);
    expect(out.coverage.reverseMetadata).toEqual({ status: 'ok', total: 9262, fetched: 10 });
    expect(out.nodes).toHaveLength(11);
    expect(out.edges).toHaveLength(10);
    expect(out.edges[0]).toEqual({
      from: '10.15468/dl.0001',
      to: DATASET,
      relationType: 'IsDerivedFrom',
      sources: ['reverse_metadata'],
    });
    const notice = `The DataCite records that point at this DOI are large (the first 10 list 40,000 related identifiers between them), so this call read 10 of the 9,262 rather than up to 100; pass query relatedIdentifiers.relatedIdentifier:"${DATASET}" to datacite_search_works to list them all.`;
    expect(out.notice).toBe(notice);
    expect(out).not.toHaveProperty('truncated');
    const text = contentText(result);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain('- **Reverse metadata:** ok · fetched 10 of 9,262 records\n');
    expect(text).toContain(`- 10.15468/dl.0001 —IsDerivedFrom→ ${DATASET} [reverse_metadata]`);
    const reverse = requestUrls(http).filter(
      (url) => url.searchParams.get('query') === reverseQuery([DATASET]),
    );
    expect(reverse.map((url) => url.searchParams.get('page[size]'))).toEqual(['10']);
  });

  it('names the reverse cut among the causes of uncounted citations', async () => {
    initServices([
      {
        match: rootRead(DATASET),
        respond: json(doiList([record(DATASET, { citationCount: 50 }, 'gbif.gbif')])),
      },
      { match: reverseRead([DATASET]), respond: paged(downloads(DATASET, 100), 9262) },
      { match: eventsRead, respond: json(eventList()) },
    ]);
    const result = await run({ doi: DATASET });
    const notice = `The DataCite records that point at this DOI are large (the first 10 list 40,000 related identifiers between them), so this call read 10 of the 9,262 rather than up to 100; pass query relatedIdentifiers.relatedIdentifier:"${DATASET}" to datacite_search_works to list them all. DataCite records 50 citations for this DOI; 0 are shown. This call read 10 of the 9,262 DataCite records whose related identifiers name this DOI, the most one call reads of records that large.`;
    expect(output(result).notice).toBe(notice);
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('reads 10 records on the second hop too, and says so', async () => {
    const collection = '10.5555/collection';
    const member = record(
      DATASET,
      {
        relatedIdentifiers: [
          { relationType: 'IsPartOf', relatedIdentifier: collection, relatedIdentifierType: 'DOI' },
        ],
      },
      'gbif.gbif',
    );
    const { http } = initServices([
      { match: rootRead(collection), respond: json(doiList([record(collection)])) },
      { match: reverseRead([collection]), respond: paged([member]) },
      { match: eventsRead, respond: json(eventList()) },
      { match: reverseRead([DATASET]), respond: paged(downloads(DATASET, 100), 9262) },
      { match: idsRead, respond: byIds([member]) },
    ]);
    const result = await run({ doi: collection, depth: 2 });
    const out = output(result);
    expect(out.coverage.reverseMetadata).toEqual({
      status: 'ok',
      total: 1,
      fetched: 1,
      secondHop: { total: 9262, fetched: 10 },
    });
    expect(out.nodes.map(({ id, depth }) => [id, depth])).toEqual([
      [collection, 0],
      [DATASET, 1],
      ...downloads(DATASET, 10).map((download) => [download.id, 2]),
    ]);
    const notice =
      'The DataCite records that point at the neighbours the second hop expanded are large (the first 10 list 40,000 related identifiers between them), so the second hop read 10 of the 9,262 rather than up to 100.';
    expect(out.notice).toBe(notice);
    const text = contentText(result);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain(
      '- **Reverse metadata:** ok · fetched 1 of 1 records · second hop fetched 10 of 9,262 records',
    );
    const reverse2 = requestUrls(http).filter(
      (url) => url.searchParams.get('query') === reverseQuery([DATASET]),
    );
    expect(reverse2.map((url) => url.searchParams.get('page[size]'))).toEqual(['10']);
  });
});

describe('hydration within the time budget', () => {
  const DATASET = '10.15468/m8zqqy';
  /** `count` GBIF download DOIs. */
  const downloadIds = (count: number) =>
    Array.from({ length: count }, (_, i) => `10.15468/dl.${String(i + 1).padStart(4, '0')}`);
  const citing = downloadIds(89);
  /** `ids=` asks for node fields only, so a hydrated record carries no related identifiers. */
  const hydrated = citing.map((doi) => record(doi, {}, 'gbif.gbif'));
  const idsOf = (request: Request) =>
    new URL(request.url).searchParams.get('ids')?.split(',') ?? [];
  /** Answers an `ids=` batch after `ms`, unless the request is cancelled first. */
  const answerAfter = (ms: number, request: Request): Promise<Response> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(byIds(hydrated)(request)), ms);
      request.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(request.signal.reason);
        },
        { once: true },
      );
    });
  /** A DataCite root that the 89 downloads reference through Event Data, and nothing else. */
  const citedRoot = (hydrate: (request: Request) => Response | Promise<Response>) => [
    { match: rootRead(DATASET), respond: json(doiList([record(DATASET, {}, 'gbif.gbif')])) },
    { match: reverseRead([DATASET]), respond: json(emptyDoiList()) },
    {
      match: eventsRead,
      respond: json(eventList(citing.map((doi) => event(doi, 'references', DATASET)))),
    },
    { match: idsRead, respond: hydrate },
  ];
  /** The size of every `ids=` batch requested, in order. */
  const batchSizes = (http: FetchMockHarness) =>
    requestUrls(http)
      .filter((url) => url.searchParams.has('ids'))
      .map((url) => url.searchParams.get('ids')?.split(',').length);

  it('returns the graph with the nodes DataCite did not hydrate in time as unhydrated leaves, and says so on both surfaces', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // Only the batch of the first 10 downloads answers, in 3.5 s; every other batch hangs.
    const firstTen = citing.slice(0, 10);
    const { http } = initServices(
      citedRoot((request) =>
        idsOf(request).every((id) => firstTen.includes(id))
          ? answerAfter(3_500, request)
          : hang(request),
      ),
    );
    let settled = false;
    const pending = run({ doi: DATASET, max_nodes: 100 }).finally(() => {
      settled = true;
    });
    // The hydration deadline, 40 s into the call, cancels the two batches still in flight.
    await vi.advanceTimersByTimeAsync(39_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const result = await pending;
    expect(result.isError).toBeFalsy();
    const out = output(result);
    expect(out.nodes).toHaveLength(90);
    expect(out.nodes.filter((n) => n.depth === 1 && n.hydrated).map((n) => n.id)).toEqual(firstTen);
    expect(out.nodes[11]).toEqual({
      id: '10.15468/dl.0011',
      idType: 'DOI',
      depth: 1,
      hydrated: false,
    });
    expect(out.edges).toHaveLength(89);
    expect(out.edges).toContainEqual({
      from: '10.15468/dl.0089',
      to: DATASET,
      relationType: 'References',
      sources: ['event_data'],
      eventSources: ['crossref'],
    });
    const notice =
      "DataCite did not return the records of 79 DOI nodes within this call's time budget, so they are listed unhydrated (hydrated: false) with their DOIs and edges; datacite_get_work fetches any one of them.";
    expect(out.notice).toBe(notice);
    const text = contentText(result);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain('| 10.15468/dl.0011 | DOI | — | 1 | false | Not available |');
    expect(text).toContain(
      `- 10.15468/dl.0089 —References→ ${DATASET} [event_data, event source crossref]`,
    );
    // One attempt each: two batches time out at 20 s, two are cancelled at 40 s, four are never sent.
    expect(batchSizes(http)).toEqual([10, 10, 10, 10, 10]);
  });

  it('hydrates 10 nodes per request, two requests at a time, and every node when the batches answer in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let inFlight = 0;
    let mostInFlight = 0;
    const { http } = initServices(
      citedRoot(async (request) => {
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        try {
          // 350 ms per record: a batch of 10 answers in 3.5 s.
          return await answerAfter(idsOf(request).length * 350, request);
        } finally {
          inFlight--;
        }
      }),
    );
    let settled = false;
    const pending = run({ doi: DATASET, max_nodes: 100 }).finally(() => {
      settled = true;
    });
    // Four rounds of two batches of 10, then the last 9: 17.15 s, where one at a time takes 31.15 s.
    await vi.advanceTimersByTimeAsync(17_150);
    expect(settled).toBe(true);
    const result = await pending;
    const out = output(result);
    expect(out.nodes).toHaveLength(90);
    expect(out.nodes.every((n) => n.hydrated)).toBe(true);
    expect(out).not.toHaveProperty('notice');
    expect(contentText(result)).toContain(
      '| 10.15468/dl.0089 | DOI | true | 1 | true | Not available | Not available | gbif.gbif |',
    );
    expect(mostInFlight).toBe(2);
    expect(batchSizes(http)).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 9]);
  });

  it('leaves out the Event Data objects of a non-DataCite root whose lookup did not answer, and counts them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const article = '10.5555/article';
    const cited = downloadIds(12);
    const lastTwo = cited.slice(10);
    initServices([
      { match: rootRead(article), respond: json(emptyDoiList()) },
      { match: reverseRead([article]), respond: json(emptyDoiList()) },
      {
        match: eventsRead,
        respond: json(eventList(cited.map((doi) => event(article, 'cites', doi)))),
      },
      // The batch holding the last two objects hangs until its one attempt times out at 20 s.
      {
        match: idsRead,
        respond: (request: Request) =>
          idsOf(request).some((id) => lastTwo.includes(id))
            ? hang(request)
            : byIds(hydrated)(request),
      },
    ]);
    const pending = run({ doi: article });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    const out = output(result);
    expect(out.nodes.map((n) => n.id)).toEqual([article, ...cited.slice(0, 10)]);
    expect(out.coverage.eventData).toMatchObject({ total: 12, fetched: 12, kept: 10 });
    const sentence =
      "Event Data links this DOI to 2 more DOIs whose DataCite lookups did not answer within this call's time budget, so they are left out as unconfirmed (only DataCite DOIs are kept); retry to check them.";
    expect(out.notice).toContain(sentence);
    expect(out.notice).not.toContain('did not return the records');
    expect(contentText(result)).toContain(sentence);
  });

  it('stops hydrating the first hop 25 s into a depth-2 call, leaving the second hop a full attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const collection = '10.5555/collection';
    const member = record('10.5555/member', {
      relatedIdentifiers: [
        { relationType: 'IsPartOf', relatedIdentifier: collection, relatedIdentifierType: 'DOI' },
      ],
    });
    /** 21 parts the root asserts: three `ids=` batches that never answer. */
    const parts = downloadIds(21);
    const { http } = initServices([
      {
        match: rootRead(collection),
        respond: json(
          doiList([
            record(collection, {
              relatedIdentifiers: parts.map((doi) => ({
                relationType: 'HasPart',
                relatedIdentifier: doi,
                relatedIdentifierType: 'DOI',
              })),
            }),
          ]),
        ),
      },
      { match: reverseRead([collection]), respond: paged([member]) },
      { match: eventsRead, respond: json(eventList()) },
      { match: reverseRead([member.id]), respond: json(emptyDoiList()) },
      {
        match: idsRead,
        respond: (request: Request) =>
          idsOf(request).includes(member.id) ? byIds([member])(request) : hang(request),
      },
    ]);
    let settled = false;
    const pending = run({ doi: collection, depth: 2 }).finally(() => {
      settled = true;
    });
    // Two batches time out at 20 s; the deadline cancels the third at 25 s, then the second hop runs.
    await vi.advanceTimersByTimeAsync(24_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const out = output(await pending);
    expect(out.coverage.reverseMetadata.secondHop).toEqual({ total: 0, fetched: 0 });
    expect(requestUrls(http).some((url) => url.searchParams.get('ids') === member.id)).toBe(true);
    expect(out.nodes.filter((n) => !n.hydrated).map((n) => n.id)).toEqual(parts);
    expect(out.notice).toBe(
      "DataCite did not return the records of 21 DOI nodes within this call's time budget, so they are listed unhydrated (hydrated: false) with their DOIs and edges; datacite_get_work fetches any one of them.",
    );
    expect(batchSizes(http)).toEqual([10, 10, 1, 1]);
  });
});

describe('the request ceiling', () => {
  it('guard: a non-DataCite root at depth 2 and max_nodes 100 makes at most 31 requests: both reverse reads paged twice, and the event-object and final hydrations at ten ids= batches plus a comma query each', async () => {
    const root = '10.5555/article';
    const relation = (relationType: string, target: string) => ({
      relationType,
      relatedIdentifier: target,
      relatedIdentifierType: 'DOI',
    });
    /** 96 plain second-hop DOIs: with a comma DOI they fill the 97 nodes left, in ten ids= batches. */
    const secondPlain = Array.from(
      { length: 96 },
      (_, i) => `10.5555/second-${String(i + 1).padStart(3, '0')}`,
    );
    /**
     * relation_types Cites keeps the records the root cites, which assert IsCitedBy it. The
     * frontier is two of them, a comma DOI and a plain one, each citing second-hop DOIs.
     */
    const citedComma = record('10.5555/cited,comma', {
      relatedIdentifiers: [relation('IsCitedBy', root), relation('Cites', '10.5555/second,comma')],
    });
    const citedPlain = record('10.5555/cited-plain', {
      relatedIdentifiers: [
        relation('IsCitedBy', root),
        ...secondPlain.map((doi) => relation('Cites', doi)),
      ],
    });
    /**
     * Nine more records the reverse query matches, with IsCitedBy on another identifier; the
     * pair check drops them. The read takes both pages while the first hop holds two nodes,
     * the fewest that leave the second hop the 97 nodes that take the most batches.
     */
    const unverified = Array.from({ length: 9 }, (_, i) =>
      record(`10.5555/near-${i + 1}`, {
        relatedIdentifiers: [relation('References', root), relation('IsCitedBy', '10.5555/other')],
      }),
    );
    const frontier = [citedComma.id, citedPlain.id];
    /** 11 records the plain frontier node cites, so the second reverse read takes both pages too. */
    const reusing = Array.from({ length: 11 }, (_, i) =>
      record(`10.5555/reuse-${i + 1}`, {
        relatedIdentifiers: [relation('IsCitedBy', citedPlain.id)],
      }),
    );
    /** 100 outgoing event objects, 99 plain and one comma DOI, none of them a DataCite DOI. */
    const references = [
      ...Array.from({ length: 99 }, (_, i) => `10.5555/ref-${String(i + 1).padStart(3, '0')}`),
      '10.5555/ref,comma',
    ];
    const commaRead = (doi: string) => dataCite('/dois', param('query', `doi:("${doi}")`));
    const { http } = initServices([
      { match: rootRead(root), respond: json(emptyDoiList()) },
      {
        match: reverseRead([root], ['IsCitedBy']),
        respond: paged([citedComma, citedPlain, ...unverified]),
      },
      {
        match: eventsRead,
        respond: json(eventList(references.map((object) => event(root, 'cites', object)))),
      },
      { match: commaRead('10.5555/ref,comma'), respond: json(emptyDoiList()) },
      { match: commaRead(citedComma.id), respond: json(doiList([citedComma])) },
      { match: commaRead('10.5555/second,comma'), respond: json(emptyDoiList()) },
      { match: reverseRead(frontier, ['IsCitedBy']), respond: paged(reusing) },
      { match: idsRead, respond: byIds([citedPlain]) },
    ]);
    const result = await run({ doi: root, depth: 2, max_nodes: 100, relation_types: ['Cites'] });
    const out = output(result);
    expect(out.nodes).toHaveLength(100);
    expect(out.nodes.filter((n) => n.depth === 1).map((n) => n.id)).toEqual(frontier);
    // The second-hop pool fills in order found: the frontier's own metadata first.
    expect(out.nodes.filter((n) => n.depth === 2).map((n) => n.id)).toEqual([
      ...secondPlain,
      '10.5555/second,comma',
    ]);
    expect(out.coverage.reverseMetadata).toEqual({
      status: 'ok',
      total: 11,
      fetched: 11,
      secondHop: { total: 11, fetched: 11 },
    });
    expect(out.coverage.eventData).toMatchObject({ total: 100, fetched: 100, kept: 0 });
    const urls = requestUrls(http);
    const pageSizes = (dois: string[]) =>
      urls
        .filter((url) => url.searchParams.get('query') === reverseQuery(dois, ['IsCitedBy']))
        .map((url) => url.searchParams.get('page[size]'));
    expect(pageSizes([root])).toEqual(['10', '100']);
    expect(pageSizes(frontier)).toEqual(['10', '100']);
    // Event objects, the root, the frontier's own records, then the second hop's nodes.
    expect(
      urls
        .filter((url) => url.searchParams.has('ids'))
        .map((url) => url.searchParams.get('ids')?.split(',').length),
    ).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 10, 9, 1, 1, 10, 10, 10, 10, 10, 10, 10, 10, 10, 6]);
    expect(urls.filter((url) => url.searchParams.get('query')?.startsWith('doi:('))).toHaveLength(
      3,
    );
    expect(http.calls).toHaveLength(31);
  });
});

describe('the citation-count notice', () => {
  const CITED = '10.5555/cited';
  /** `count` works citing CITED, each through one Event Data link per side. */
  const citationEvents = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => `10.5555/citer-${String(i + 1).padStart(3, '0')}`,
    ).flatMap((citer) => [event(citer, 'cites', CITED), event(CITED, 'is-cited-by', citer)]);
  const citedRoutes = ({
    attributes = {},
    events = [],
    eventTotal = events.length,
    reverse = [],
    reverseTotal = reverse.length,
    reverseTypes,
  }: {
    attributes?: RawDoiAttributes;
    events?: RawEventList['data'];
    eventTotal?: number;
    reverse?: RawDoiResource[];
    reverseTotal?: number;
    reverseTypes?: string[];
  }) => [
    { match: rootRead(CITED), respond: json(doiList([record(CITED, attributes)])) },
    { match: reverseRead([CITED], reverseTypes), respond: paged(reverse, reverseTotal) },
    { match: eventsRead, respond: json({ data: events, meta: { total: eventTotal } }) },
    { match: idsRead, respond: byIds([]) },
  ];
  const noRelations =
    'No relations were found in DataCite metadata or Event Data. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist.';

  it('names the Event Data events left unread, and the per-type calls that read more', async () => {
    initServices(
      citedRoutes({
        attributes: { citationCount: 80 },
        events: citationEvents(50),
        eventTotal: 160,
      }),
    );
    const result = await run({ doi: CITED, max_nodes: 100 });
    const out = output(result);
    expect(out.coverage.eventData).toEqual({
      status: 'ok',
      scope: 'both_sides',
      total: 160,
      fetched: 100,
      kept: 100,
    });
    expect(out.nodes).toHaveLength(51);
    const notice =
      'DataCite records 80 citations for this DOI; 50 are shown. This call read 100 of the 160 Event Data events on this DOI, the most one call reads; a call per citation type (relation_types IsCitedBy, IsReferencedBy, or IsSupplementTo) reads the first 100 of each.';
    expect(out.notice).toBe(notice);
    expect(out).not.toHaveProperty('truncated');
    const text = contentText(result);
    expect(text).toContain('**DataCite counts:** 80 citations');
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('accrue');
  });

  it('names the citing works max_nodes left out', async () => {
    initServices(citedRoutes({ attributes: { citationCount: 50 }, events: citationEvents(50) }));
    const result = await run({ doi: CITED, max_nodes: 20 });
    const out = output(result);
    const notice =
      '19 of 50 related identifiers fit max_nodes=20; raise max_nodes (≤ 100) or narrow relation_types. DataCite records 50 citations for this DOI; 19 are shown. max_nodes=20 left 31 citing works out.';
    expect(out).toMatchObject({ truncated: true, shown: 20, cap: 20, notice });
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('names Event Data as unread when include_event_data is false', async () => {
    initServices(citedRoutes({ attributes: { citationCount: 3 } }));
    const result = await run({ doi: CITED, include_event_data: false });
    const notice =
      'No relations were found in DataCite metadata. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist. DataCite records 3 citations for this DOI; 0 are shown. Event Data, the source of most citation links, was not read (include_event_data is false).';
    expect(output(result).notice).toBe(notice);
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('names the citation types relation_types leaves out', async () => {
    initServices(
      citedRoutes({ attributes: { citationCount: 3 }, reverseTypes: ['IsSupplementedBy'] }),
    );
    const result = await run({ doi: CITED, relation_types: ['IsSupplementTo'] });
    const notice =
      'No relations of the requested relation_types were found in DataCite metadata or Event Data. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist. DataCite records 3 citations for this DOI; 0 are shown. relation_types leaves out the citation types IsCitedBy and IsReferencedBy.';
    expect(output(result).notice).toBe(notice);
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('names the reverse-query records left unread', async () => {
    // Matched upstream on a Cites attached to another identifier; none asserts a citation of CITED.
    const documenting = Array.from({ length: 100 }, (_, i) =>
      record(`10.5555/doc-${i + 1}`, {
        relatedIdentifiers: [
          {
            relationType: 'IsDocumentedBy',
            relatedIdentifier: CITED,
            relatedIdentifierType: 'DOI',
          },
          {
            relationType: 'Cites',
            relatedIdentifier: '10.5555/elsewhere',
            relatedIdentifierType: 'DOI',
          },
        ],
      }),
    );
    const citationTypes = ['IsCitedBy', 'IsReferencedBy', 'IsSupplementTo'];
    initServices(
      citedRoutes({
        attributes: { citationCount: 5 },
        reverse: documenting,
        reverseTotal: 150,
        reverseTypes: ['Cites', 'References', 'IsSupplementedBy'],
      }),
    );
    const result = await run({ doi: CITED, relation_types: citationTypes });
    const out = output(result);
    expect(out.coverage.reverseMetadata).toEqual({ status: 'ok', total: 150, fetched: 100 });
    const notice =
      'No relations of the requested relation_types were found in DataCite metadata or Event Data. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist. DataCite records 5 citations for this DOI; 0 are shown. This call read 100 of the 150 DataCite records whose related identifiers name this DOI, the most one call reads.';
    expect(out.notice).toBe(notice);
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('points at version DOIs only for a DOI that has versions', async () => {
    initServices(
      citedRoutes({ attributes: { citationCount: 3, versionCount: 2 }, events: citationEvents(1) }),
    );
    const result = await run({ doi: CITED });
    const notice =
      'DataCite records 3 citations for this DOI; 1 is shown. Citations accrue per DOI — trace the concept DOI and its version DOIs separately.';
    expect(output(result).notice).toBe(notice);
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('adds nothing when every citation DataCite counts is shown', async () => {
    initServices(citedRoutes({ attributes: { citationCount: 2 }, events: citationEvents(2) }));
    const result = await run({ doi: CITED });
    expect(output(result)).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('DataCite records');
  });

  it('skips the notice when relation_types admits no citation of the DOI', async () => {
    // Cites keeps what the DOI cites; nothing it admits is a citation of the DOI.
    initServices(citedRoutes({ attributes: { citationCount: 3 }, reverseTypes: ['IsCitedBy'] }));
    const result = await run({ doi: CITED, relation_types: ['Cites'] });
    const out = output(result);
    expect(out.notice).toBe(
      noRelations.replace('No relations', 'No relations of the requested relation_types'),
    );
    expect(contentText(result)).not.toContain('DataCite records');
  });
});

describe('relation_types and Event Data', () => {
  it('reads each type from the root side: HasPart finds the parts asserting IsPartOf it, shown as asserted', async () => {
    // Both matched upstream on a type attached to another identifier; what each asserts on the root fails the filter.
    const citing = record('10.5061/dryad.9999', {
      relatedIdentifiers: [
        { relationType: 'References', relatedIdentifier: ROOT, relatedIdentifierType: 'DOI' },
        {
          relationType: 'IsPartOf',
          relatedIdentifier: '10.5555/other',
          relatedIdentifierType: 'DOI',
        },
      ],
    });
    const parent = record('10.5061/dryad.collection', {
      relatedIdentifiers: [
        { relationType: 'HasPart', relatedIdentifier: ROOT, relatedIdentifierType: 'DOI' },
        {
          relationType: 'IsPartOf',
          relatedIdentifier: '10.5555/archive',
          relatedIdentifierType: 'DOI',
        },
      ],
    });
    const { http } = initServices([
      { match: rootRead(ROOT), respond: fixtureResponse('datacite/graph/root-dryad-8515.json') },
      {
        match: reverseRead([ROOT], ['IsPartOf', 'Cites']),
        respond: json(doiList([...dryad8515ReversePage().data, citing, parent])),
      },
      { match: eventsRead, respond: fixtureResponse('datacite/graph/events-dryad-8515.json') },
      { match: idsRead, respond: byIds([PPAT_COPY]) },
    ]);
    const result = await run({ doi: ROOT, relation_types: ['hasPart', 'IS_CITED_BY', 'HasPart'] });
    const out = output(result);
    expect(out.edges.map((e) => [e.from, e.relationType, e.sources])).toEqual([
      [ROOT, 'IsCitedBy', ['metadata', 'event_data']],
      [PART1, 'IsPartOf', ['reverse_metadata']],
      [PART2, 'IsPartOf', ['reverse_metadata']],
    ]);
    expect(out.nodes.map((n) => n.id)).toEqual([ROOT, PPAT, PART1, PART2]);
    expect(out.coverage.ownMetadata.edgeCount).toBe(1);
    // Of the root's three outgoing events only is-cited-by passes.
    expect(out.coverage.eventData).toMatchObject({ status: 'ok', fetched: 3, kept: 1 });
    expect(out).not.toHaveProperty('notice');
    const text = contentText(result);
    expect(text).toContain(`- ${PART1} —IsPartOf→ ${ROOT} [reverse_metadata]`);
    expect(text).not.toContain('No relations');
    // Event Data holds a DataCite root's links on both sides: Cites reaches it from the citing side.
    const events = requestUrls(http).find((url) => url.pathname === '/events');
    expect(events?.searchParams.get('relation-type-id')).toBe('cites,is-cited-by');
  });

  it('reads IsPartOf as the root being a part, and matches a type with no inverse on either side', async () => {
    const root = '10.5555/chapter-3';
    const rootRecord = record(root, {
      relatedIdentifiers: [
        {
          relationType: 'IsPartOf',
          relatedIdentifier: '10.5555/book',
          relatedIdentifierType: 'DOI',
        },
        {
          relationType: 'HasPart',
          relatedIdentifier: '10.5555/figure-1',
          relatedIdentifierType: 'DOI',
        },
        {
          relationType: 'IsPublishedIn',
          relatedIdentifier: '10.5555/series',
          relatedIdentifierType: 'DOI',
        },
      ],
    });
    const assertingOnRoot = (doi: string, relationType: string, elsewhere?: string) =>
      record(doi, {
        relatedIdentifiers: [
          { relationType, relatedIdentifier: root, relatedIdentifierType: 'DOI' },
          ...(elsewhere
            ? [
                {
                  relationType: 'HasPart',
                  relatedIdentifier: elsewhere,
                  relatedIdentifierType: 'DOI',
                },
              ]
            : []),
        ],
      });
    const book = assertingOnRoot('10.5555/book', 'HasPart');
    const section = assertingOnRoot('10.5555/section-3-1', 'IsPartOf', '10.5555/figure-2');
    const review = assertingOnRoot('10.5555/review', 'IsPublishedIn');
    const { http } = initServices([
      { match: rootRead(root), respond: json(doiList([rootRecord])) },
      {
        match: reverseRead([root], ['HasPart', 'IsPublishedIn']),
        respond: json(doiList([book, section, review])),
      },
      { match: idsRead, respond: byIds([]) },
    ]);
    const result = await run({ doi: root, relation_types: ['IsPartOf', 'IsPublishedIn'] });
    const out = output(result);
    expect(out.edges).toEqual([
      { from: root, to: '10.5555/book', relationType: 'IsPartOf', sources: ['metadata'] },
      { from: root, to: '10.5555/series', relationType: 'IsPublishedIn', sources: ['metadata'] },
      { from: '10.5555/book', to: root, relationType: 'HasPart', sources: ['reverse_metadata'] },
      {
        from: '10.5555/review',
        to: root,
        relationType: 'IsPublishedIn',
        sources: ['reverse_metadata'],
      },
    ]);
    expect(out.nodes.map((n) => n.id)).toEqual([
      root,
      '10.5555/book',
      '10.5555/series',
      '10.5555/review',
    ]);
    expect(out.coverage.ownMetadata.edgeCount).toBe(2);
    const text = contentText(result);
    expect(text).toContain(`- 10.5555/book —HasPart→ ${root} [reverse_metadata]`);
    expect(text).toContain(`- 10.5555/review —IsPublishedIn→ ${root} [reverse_metadata]`);
    expect(requestUrls(http).some((url) => url.pathname === '/events')).toBe(false);
  });

  it('keeps Event Data links on either side of a DataCite root by the type the root sees', async () => {
    const citing = '10.1000/citing-article';
    const { http } = initServices([
      { match: rootRead(ROOT), respond: fixtureResponse('datacite/graph/root-dryad-8515.json') },
      { match: reverseRead([ROOT], ['References']), respond: json(emptyDoiList()) },
      {
        match: eventsRead,
        respond: json(
          eventList([
            event(ROOT, 'is-referenced-by', PPAT),
            event(citing, 'references', ROOT),
            event(ROOT, 'references', '10.1000/cited-by-root'),
            event('10.1000/cited-article', 'is-referenced-by', ROOT),
          ]),
        ),
      },
      { match: idsRead, respond: byIds([PPAT_COPY]) },
    ]);
    const result = await run({ doi: ROOT, relation_types: ['IsReferencedBy'] });
    const out = output(result);
    expect(out.edges).toEqual([
      {
        from: ROOT,
        to: PPAT,
        relationType: 'IsReferencedBy',
        sources: ['event_data'],
        eventSources: ['crossref'],
      },
      {
        from: citing,
        to: ROOT,
        relationType: 'References',
        sources: ['event_data'],
        eventSources: ['crossref'],
      },
    ]);
    expect(out.nodes.map((n) => n.id)).toEqual([ROOT, PPAT, citing]);
    expect(out.coverage.eventData).toEqual({
      status: 'ok',
      scope: 'both_sides',
      total: 4,
      fetched: 4,
      kept: 2,
    });
    const text = contentText(result);
    expect(text).toContain(`- ${citing} —References→ ${ROOT} [event_data, event source crossref]`);
    expect(text).toContain(
      '- **Event Data:** ok · scope both_sides · total 4 · fetched 4 · kept 2',
    );
    const events = requestUrls(http).find((url) => url.pathname === '/events');
    expect(events?.searchParams.get('relation-type-id')).toBe('references,is-referenced-by');
  });

  it('skips Event Data when relation_types admits no citation type', async () => {
    const { http } = initServices([
      { match: rootRead(ROOT), respond: fixtureResponse('datacite/graph/root-dryad-8515.json') },
      { match: reverseRead([ROOT], ['IsReviewedBy']), respond: json(emptyDoiList()) },
    ]);
    const result = await run({ doi: ROOT, relation_types: ['reviews'] });
    const detail =
      'relation_types admits no citation relation type, the only kind Event Data carries.';
    const out = output(result);
    expect(out.coverage.eventData).toEqual({ status: 'skipped', detail });
    const zero =
      'No relations of the requested relation_types were found in DataCite metadata. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist.';
    // The root's one citation cannot be shown under this filter, so no citation-count fragment.
    expect(out.notice).toBe(zero);
    const text = contentText(result);
    expect(text).toContain(`- **Event Data:** skipped · ${detail}`);
    expect(text).toContain(zero);
    expect(text).not.toContain('DataCite records');
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
    const input = { doi: ROOT, depth: '', max_nodes: ' ', relation_types: ['', '  '] };
    expect(traceRelationsTool.input.parse(input)).toEqual({
      doi: ROOT,
      depth: 1,
      include_event_data: true,
      max_nodes: 50,
    });
    const out = output(await run(input as unknown as Input));
    expect(out.nodes).toHaveLength(4);
    expect(out).not.toHaveProperty('truncated');
    // An unnarrowed reverse query, and no second one: depth fell back to 1.
    const queries = requestUrls(http).flatMap((url) => url.searchParams.get('query') ?? []);
    expect(queries).toEqual([`doi:"${ROOT}"`, reverseQuery([ROOT])]);
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
