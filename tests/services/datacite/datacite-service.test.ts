/**
 * @fileoverview Tests for `DataCiteService` behavior above the HTTP boundary —
 * query-parse classification, the parameters every `/dois` call pins, the
 * exact-DOI record lookup — and for the service wiring `setup()` / `teardown()`
 * run: shared cache, pacer disposal, accessors, and env-derived defaults.
 * @module tests/services/datacite/datacite-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchWorksTool } from '@/mcp-server/tools/definitions/search-works.tool.js';
import {
  DataCiteService,
  getDataCiteService,
  NODE_FIELDS,
  shutdownDataCiteServices,
  type WorkSearchRequest,
} from '@/services/datacite/datacite-service.js';
import type { RawDoiList } from '@/services/datacite/types.js';
import { getRegistrationAgencyService } from '@/services/doi-ra/doi-ra-service.js';
import { doiList, emptyDoiList, fixtureJson, fixtureResponse } from '../../helpers/fixtures.js';
import {
  DATACITE,
  dataCite,
  doiRa,
  fastPacer,
  initServices,
  json,
  onPath,
  param,
  requestUrls,
  TEST_VERSION,
  teardownServices,
} from '../../helpers/harness.js';

const SEARCH: WorkSearchRequest = {
  callerQuery: true,
  facets: false,
  filters: {},
  page: { number: 1 },
  query: 'titles.title:(glacier',
  size: 20,
  sort: 'relevance',
};

const services: DataCiteService[] = [];

afterEach(() => {
  for (const svc of services.splice(0)) svc.dispose();
  teardownServices();
  vi.unstubAllEnvs();
  vi.resetModules();
});

function build(routes: Parameters<typeof createFetchMock>[0]) {
  const http = createFetchMock(routes);
  const svc = new DataCiteService({ fetch: http.fetch, pacer: fastPacer(), version: TEST_VERSION });
  services.push(svc);
  return { http, svc };
}

const rejection = async (promise: Promise<unknown>): Promise<McpError> => {
  const error = await promise.then(
    () => {
      throw new Error('Expected a rejection.');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
};

describe('query parse errors', () => {
  const parse400 = (path: string) =>
    fixtureResponse(path, { status: 400, headers: { 'content-type': 'application/json' } });

  it('reports a parse_exception on caller query syntax as invalid_query with its position', async () => {
    const { http, svc } = build([
      { match: dataCite('/dois'), respond: parse400('datacite/errors/parse-exception-query.json') },
    ]);
    const error = await rejection(
      svc.searchWorks(SEARCH, createMockContext({ errors: searchWorksTool.errors })),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_query');
    expect(error.message).toBe(
      'DataCite could not parse the query syntax (line 1, column 12): check for unbalanced parentheses or quotes, a dangling operator, or an unescaped reserved character.',
    );
    expect(error.data?.recovery).toEqual(expect.objectContaining({ hint: expect.any(String) }));
    expect(http.calls).toHaveLength(1);
  });

  it('reads the "failed to parse" prefix as a parse error too', async () => {
    const { svc } = build([
      { match: dataCite('/dois'), respond: parse400('datacite/errors/failed-to-parse-date.json') },
    ]);
    const error = await rejection(svc.searchWorks(SEARCH, createMockContext()));
    expect(error.data?.reason).toBe('invalid_query');
    expect(error.message).toMatch(/^DataCite could not parse the query syntax: check/);
  });

  it('reports a parse error on a server-composed query as an InternalError, never invalid_query', async () => {
    const { svc } = build([
      { match: dataCite('/dois'), respond: parse400('datacite/errors/parse-exception-query.json') },
    ]);
    const error = await rejection(
      svc.searchWorks({ ...SEARCH, callerQuery: false }, createMockContext()),
    );
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.data?.reason).toBeUndefined();
    expect(error.message).toBe(
      'DataCite could not parse a query clause this server composed; this is a server bug, not an input error.',
    );
  });

  it('classifies repository search parse errors the same way', async () => {
    const { svc } = build([
      {
        match: dataCite('/repositories'),
        respond: parse400('datacite/errors/parse-exception-repositories.json'),
      },
    ]);
    const request = { callerQuery: true, page: 1, size: 20, query: '(glacier' };
    const caller = await rejection(svc.searchRepositories(request, createMockContext()));
    expect(caller.data?.reason).toBe('invalid_query');
    const server = await rejection(
      svc.searchRepositories({ ...request, callerQuery: false }, createMockContext()),
    );
    expect(server.code).toBe(JsonRpcErrorCode.InternalError);
  });

  it('lets any other 400 propagate with its upstream status, unclassified', async () => {
    const { http, svc } = build([
      {
        match: dataCite('/dois'),
        respond: json({ errors: [{ status: '400', title: 'Bad sort value' }] }, { status: 400 }),
      },
    ]);
    const error = await rejection(svc.searchWorks(SEARCH, createMockContext()));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data).toMatchObject({ status: 400 });
    expect(error.data?.reason).toBeUndefined();
    expect(http.calls).toHaveLength(1);
  });
});

describe('/dois requests', () => {
  it('pins affiliation=true and publisher=true on every /dois call', async () => {
    const { http, svc } = build([{ match: dataCite('/dois'), respond: json(emptyDoiList()) }]);
    const ctx = createMockContext();
    await svc.searchWorks({ ...SEARCH, query: '*', callerQuery: false }, ctx);
    await svc.getWork('10.5061/dryad.234', ctx);
    await svc.getRecord('10.5061/dryad.234', NODE_FIELDS, ctx);
    await svc.queryRecords('doi:"10.5061/dryad.234"', NODE_FIELDS, 5, ctx);
    await svc.hydrate(['10.5061/dryad.234', '10.5061/a,b'], NODE_FIELDS, ctx);
    const urls = requestUrls(http);
    expect(urls).toHaveLength(6);
    for (const url of urls) {
      expect(url.searchParams.get('affiliation')).toBe('true');
      expect(url.searchParams.get('publisher')).toBe('true');
    }
  });

  it('returns the exact-DOI record with its included repository client', async () => {
    const { svc } = build([
      {
        match: dataCite('/dois'),
        respond: fixtureResponse('datacite/works/record-dryad-234.json'),
      },
    ]);
    const found = await svc.getWork('10.5061/dryad.234', createMockContext());
    expect(found?.record.id).toBe('10.5061/dryad.234');
    expect(found?.client?.id).toBe('dryad.dryad');
    expect(found?.client?.relationships?.provider?.data?.id).toBe('dryad');
  });

  it('treats a hit for a different DOI as no record', async () => {
    const other = fixtureJson<RawDoiList>('datacite/works/record-dryad-234.json');
    const { svc } = build([{ match: dataCite('/dois'), respond: json(other) }]);
    await expect(svc.getWork('10.5061/dryad.2345', createMockContext())).resolves.toBeUndefined();
    await expect(
      svc.getRecord('10.5061/dryad.2345', NODE_FIELDS, createMockContext()),
    ).resolves.toBeUndefined();
  });

  it('returns a record without a client when the list includes none', async () => {
    const list = fixtureJson<RawDoiList>('datacite/works/record-dryad-234.json');
    delete list.included;
    const { svc } = build([{ match: dataCite('/dois'), respond: json(list) }]);
    const found = await svc.getWork('10.5061/dryad.234', createMockContext());
    expect(found?.record.id).toBe('10.5061/dryad.234');
    expect(found).not.toHaveProperty('client');
  });
});

describe('hydrate batching', () => {
  /** A `/dois` page holding `dois` as upper-case records, the case the upstream may answer in. */
  const answer = (dois: readonly string[]) =>
    json(
      doiList(
        dois.map((doi) => ({
          id: doi.toUpperCase(),
          type: 'dois',
          attributes: { doi: doi.toUpperCase() },
        })),
      ),
    );

  it('batches ids= at 100, sends comma DOIs through a doi: query, and keys records by lowercase DOI', async () => {
    const plain = Array.from({ length: 150 }, (_, i) => `10.5555/n${i}`);
    const comma = ['10.5555/a,b', '10.5555/c,d'];
    const commaQuery = 'doi:("10.5555/a,b" OR "10.5555/c,d")';
    const { http, svc } = build([
      {
        match: dataCite('/dois', (url) => url.searchParams.has('ids')),
        respond: (request) =>
          answer((new URL(request.url).searchParams.get('ids') ?? '').split(',')),
      },
      {
        match: dataCite('/dois', param('query', commaQuery)),
        respond: answer([...comma, '10.5555/unrequested']),
      },
    ]);
    const records = await svc.hydrate([...plain, ...comma], NODE_FIELDS, createMockContext());

    const urls = requestUrls(http);
    expect(urls).toHaveLength(3);
    expect(
      urls.filter((url) => url.searchParams.has('ids')).map((url) => url.searchParams.get('ids')),
    ).toEqual([plain.slice(0, 100).join(','), plain.slice(100).join(',')]);
    const byQuery = urls.find((url) => url.searchParams.has('query'));
    expect(Object.fromEntries(byQuery?.searchParams ?? [])).toEqual({
      query: commaQuery,
      sort: '-created',
      'page[size]': '2',
      'fields[dois]': NODE_FIELDS,
      affiliation: 'true',
      publisher: 'true',
    });
    expect([...records.keys()]).toEqual([...plain, ...comma]);
    expect(records.get('10.5555/a,b')?.id).toBe('10.5555/A,B');
  });

  it('makes no request for an empty batch', async () => {
    const { http, svc } = build([]);
    await expect(svc.hydrate([], NODE_FIELDS, createMockContext())).resolves.toEqual(new Map());
    expect(http.calls).toHaveLength(0);
  });
});

describe('service wiring', () => {
  it('throws from both accessors before init and after shutdown', async () => {
    vi.resetModules();
    const fresh = await import('@/services/datacite/datacite-service.js');
    const freshRa = await import('@/services/doi-ra/doi-ra-service.js');
    expect(() => fresh.getDataCiteService()).toThrow(
      'DataCiteService not initialized — call initDataCiteServices() in setup()',
    );
    expect(() => freshRa.getRegistrationAgencyService()).toThrow(
      'RegistrationAgencyService not initialized — call initDataCiteServices() in setup()',
    );

    initServices();
    expect(getDataCiteService()).toBeInstanceOf(DataCiteService);
    expect(getRegistrationAgencyService()).toBeDefined();
    shutdownDataCiteServices();
    expect(() => getDataCiteService()).toThrow('not initialized');
    expect(() => getRegistrationAgencyService()).toThrow('not initialized');
  });

  it('builds both services over one shared response cache', async () => {
    const { cache } = initServices([
      {
        match: dataCite('/dois'),
        respond: fixtureResponse('datacite/works/record-dryad-234.json'),
      },
      { match: doiRa('10.1038/nature12373'), respond: fixtureResponse('doi-ra/crossref.json') },
    ]);
    const ctx = createMockContext();
    await getDataCiteService().getRecord('10.5061/dryad.234', NODE_FIELDS, ctx);
    await getRegistrationAgencyService().classifyMiss('10.1038/nature12373', ctx);
    expect(cache.get('https://doi.org/ra/10.1038%2Fnature12373')).toMatchObject({ status: 200 });
    const doisKey = `${DATACITE}/dois?${new URLSearchParams([
      ['query', 'doi:"10.5061/dryad.234"'],
      ['sort', '-created'],
      ['fields[dois]', NODE_FIELDS],
      ['affiliation', 'true'],
      ['publisher', 'true'],
      ['page[size]', '1'],
    ])}`;
    expect(cache.get(doisKey)).toMatchObject({ status: 200 });
  });

  it('disposes both pacers on shutdown and on re-init', async () => {
    const first = initServices();
    const second = initServices();
    await expect(first.pacer.run(async () => 'ran')).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    await expect(first.raPacer.run(async () => 'ran')).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    await expect(second.pacer.run(async () => 'ran')).resolves.toBe('ran');
    shutdownDataCiteServices();
    await expect(second.pacer.run(async () => 'ran')).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
    await expect(second.raPacer.run(async () => 'ran')).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
    });
  });

  it('reads the contact email from DATACITE_CONTACT_EMAIL, and an explicit option wins', async () => {
    vi.resetModules();
    vi.stubEnv('DATACITE_CONTACT_EMAIL', 'env@example.org');
    const wiring = await import('@/services/datacite/datacite-service.js');
    const ra = await import('@/services/doi-ra/doi-ra-service.js');
    const http = createFetchMock([
      { match: onPath(DATACITE, '/dois'), respond: json(emptyDoiList()) },
      { match: doiRa('10.1038/nature12373'), respond: fixtureResponse('doi-ra/crossref.json') },
    ]);
    const agents = async (options: { contactEmail?: string }) => {
      const seen = http.calls.length;
      wiring.initDataCiteServices({
        fetch: http.fetch,
        pacer: fastPacer(),
        raPacer: fastPacer(),
        version: TEST_VERSION,
        ...options,
      });
      const ctx = createMockContext();
      await wiring.getDataCiteService().getRecord('10.5061/dryad.234', NODE_FIELDS, ctx);
      await ra.getRegistrationAgencyService().classifyMiss('10.1038/nature12373', ctx);
      wiring.shutdownDataCiteServices();
      return http.calls.slice(seen).map((call) => call.request.headers.get('user-agent'));
    };
    const suffix = (email: string) =>
      `(+https://github.com/cyanheads/datacite-mcp-server; mailto:${email})`;
    expect(await agents({})).toEqual([
      expect.stringContaining(suffix('env@example.org')),
      expect.stringContaining(suffix('env@example.org')),
    ]);
    expect(await agents({ contactEmail: 'option@example.org' })).toEqual([
      expect.stringContaining(suffix('option@example.org')),
      expect.stringContaining(suffix('option@example.org')),
    ]);
  });

  it('sizes the default pacer from DATACITE_MAX_REQUESTS_PER_5MIN', async () => {
    vi.resetModules();
    vi.stubEnv('DATACITE_CONTACT_EMAIL', '');
    vi.stubEnv('DATACITE_MAX_REQUESTS_PER_5MIN', '50');
    const wiring = await import('@/services/datacite/datacite-service.js');
    const http = createFetchMock([
      { match: onPath(DATACITE, '/dois'), respond: json(emptyDoiList()) },
    ]);
    wiring.initDataCiteServices({ fetch: http.fetch, version: TEST_VERSION });
    const svc = wiring.getDataCiteService();
    const ctx = createMockContext();
    const calls = Array.from({ length: 51 }, (_, n) =>
      svc.getRecord(`10.5555/item.${n}`, NODE_FIELDS, ctx).catch((e: unknown) => e),
    );
    const last = (await calls[50]) as McpError;
    expect(last.data?.reason).toBe('rate_limited');
    expect(last.data?.retryAfter).toBeGreaterThanOrEqual(299);
    wiring.shutdownDataCiteServices();
    await Promise.all(calls);
  });
});
