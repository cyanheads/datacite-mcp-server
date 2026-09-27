/**
 * @fileoverview Tests for the shared upstream HTTP boundary (cache → pacer →
 * fetch, retry, deadline, 429 and shed rules), driven through the two services
 * built on it with a fake `fetch` at the network seam.
 * @module tests/services/http/upstream-client.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DataCiteService,
  type DataCiteServiceOptions,
  NODE_FIELDS,
  type WorkSearchRequest,
} from '@/services/datacite/datacite-service.js';
import { RegistrationAgencyService } from '@/services/doi-ra/doi-ra-service.js';
import { TtlCache } from '@/services/http/ttl-cache.js';
import type { CachedResponse } from '@/services/http/upstream-client.js';
import { emptyDoiList, fixtureResponse, rateLimitResponse } from '../../helpers/fixtures.js';
import {
  DATACITE,
  dataCite,
  doiRa,
  fastPacer,
  hang,
  json,
  manualClock,
  once,
  onPath,
  requestUrls,
  TEST_VERSION,
  text,
} from '../../helpers/harness.js';

const MINUTE = 60_000;
const EMAIL = 'ops@example.org';
const UA = `datacite-mcp-server/${TEST_VERSION} (+https://github.com/cyanheads/datacite-mcp-server)`;
const UA_WITH_EMAIL = `datacite-mcp-server/${TEST_VERSION} (+https://github.com/cyanheads/datacite-mcp-server; mailto:${EMAIL})`;

const SEARCH: WorkSearchRequest = {
  callerQuery: false,
  facets: false,
  filters: {},
  page: { number: 1 },
  query: '*',
  size: 20,
  sort: '-created',
};

const disposables: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const item of disposables.splice(0)) item.dispose();
  vi.useRealTimers();
});

type BuildOptions = Partial<Omit<DataCiteServiceOptions, 'fetch'>>;

/** A DataCite service over a fetch fake, a clocked cache, and a fast pacer. */
function build(routes: Parameters<typeof createFetchMock>[0], options: BuildOptions = {}) {
  const http = createFetchMock(routes);
  const clock = manualClock();
  const cache = options.cache ?? new TtlCache<CachedResponse>({ now: clock.now });
  const svc = new DataCiteService({
    fetch: http.fetch,
    version: TEST_VERSION,
    pacer: fastPacer(),
    ...options,
    cache,
  });
  disposables.push(svc);
  return { http, clock, cache, svc };
}

/** A registration-agency service sharing `cache`. */
function buildRa(
  http: ReturnType<typeof createFetchMock>,
  cache: TtlCache<CachedResponse>,
  contactEmail?: string,
) {
  const ra = new RegistrationAgencyService({
    fetch: http.fetch,
    cache,
    pacer: fastPacer('doi-ra-test'),
    version: TEST_VERSION,
    ...(contactEmail && { contactEmail }),
  });
  disposables.push(ra);
  return ra;
}

type Outcome<T> = { ok: true; value: T } | { error: unknown; ok: false };

/** Settles a promise into a value without letting a rejection go unhandled. */
const settle = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

function errorOf<T>(outcome: Outcome<T>): McpError {
  if (outcome.ok) throw new Error('Expected a rejection.');
  expect(outcome.error).toBeInstanceOf(McpError);
  return outcome.error as McpError;
}

const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

/** One `/dois` lookup per distinct DOI — distinct URLs, so nothing is served from cache. */
const lookup = (svc: DataCiteService, n: number, ctx = createMockContext()) =>
  svc.getRecord(`10.5555/item.${n}`, NODE_FIELDS, ctx);

describe('User-Agent and request URLs', () => {
  const routes = [
    { match: dataCite('/dois'), respond: json(emptyDoiList()) },
    { match: doiRa('10.1038/nature12373'), respond: fixtureResponse('doi-ra/crossref.json') },
  ];

  it('identifies the server without an email by default', async () => {
    const { http, cache, svc } = build(routes);
    const ra = buildRa(http, cache);
    await svc.getRecord('10.5061/dryad.234', NODE_FIELDS, createMockContext());
    await ra.classifyMiss('10.1038/nature12373', createMockContext());
    expect(http.calls.map((call) => call.request.headers.get('user-agent'))).toEqual([UA, UA]);
  });

  it('appends the contact email as mailto: inside the parentheses', async () => {
    const { http, cache, svc } = build(routes, { contactEmail: EMAIL });
    const ra = buildRa(http, cache, EMAIL);
    await svc.getRecord('10.5061/dryad.234', NODE_FIELDS, createMockContext());
    await ra.classifyMiss('10.1038/nature12373', createMockContext());
    expect(http.calls.map((call) => call.request.headers.get('user-agent'))).toEqual([
      UA_WITH_EMAIL,
      UA_WITH_EMAIL,
    ]);
  });

  it('never puts the contact email in any request URL, the RA lookup included', async () => {
    const { http, cache, svc } = build(
      [
        { match: dataCite('/dois'), respond: json(emptyDoiList()) },
        { match: dataCite('/events'), respond: json({ data: [], meta: { total: 0 } }) },
        { match: dataCite('/repositories'), respond: json({ data: [], meta: { total: 0 } }) },
        {
          match: dataCite('/dois/text/x-bibliography/10.5061%2Fdryad.234'),
          respond: text('Citation.'),
        },
        { match: doiRa('10.1038/nature12373'), respond: fixtureResponse('doi-ra/crossref.json') },
      ],
      { contactEmail: EMAIL },
    );
    const ra = buildRa(http, cache, EMAIL);
    const ctx = createMockContext();
    await svc.searchWorks({ ...SEARCH, query: 'glacier', callerQuery: true, facets: true }, ctx);
    await svc.getWork('10.5061/dryad.234', ctx);
    await svc.queryRecords('doi:"10.5061/dryad.234"', NODE_FIELDS, 5, ctx);
    await svc.hydrate(['10.5061/dryad.234', '10.5061/a,b'], NODE_FIELDS, ctx);
    await svc.getEvents({ doi: '10.5061/dryad.234', relationTypeIds: ['is-cited-by'] }, ctx);
    await svc.searchRepositories({ callerQuery: false, page: 1, size: 20, query: 'x' }, ctx);
    await svc.negotiate('10.5061/dryad.234', 'text/x-bibliography', { style: 'ieee' }, ctx);
    await ra.classifyMiss('10.1038/nature12373', ctx);

    expect(http.calls).toHaveLength(9);
    for (const url of requestUrls(http)) {
      expect(url.href).not.toMatch(/ops|example\.org|mailto/i);
    }
  });
});

describe('response cache', () => {
  it('answers a repeated request from cache without queueing on the pacer', async () => {
    const pacer = createPacer({ name: 'one-slot', limits: [{ requests: 1, perMs: 5 * MINUTE }] });
    disposables.push(pacer);
    const { http, svc } = build([{ match: dataCite('/dois'), respond: json(emptyDoiList()) }], {
      pacer,
    });
    await lookup(svc, 1);
    await lookup(svc, 1);
    expect(http.calls).toHaveLength(1);
    // The one slot is spent: a request that did reach the pacer would shed.
    await expect(lookup(svc, 2)).rejects.toMatchObject({ data: { reason: 'rate_limited' } });
    expect(http.calls).toHaveLength(1);
  });

  const negotiation = (status: 200 | 204 | 404) => ({
    match: dataCite('/dois/text/x-bibliography/10.5061%2Fdryad.234'),
    respond: status === 204 ? new Response(null, { status: 204 }) : text('Citation.', { status }),
  });

  it.each([
    {
      name: 'search pages',
      ttlMs: 5 * MINUTE,
      routes: [{ match: dataCite('/dois'), respond: json(emptyDoiList()) }],
      call: (svc: DataCiteService) => svc.searchWorks(SEARCH, createMockContext()),
    },
    {
      name: 'repository pages',
      ttlMs: 60 * MINUTE,
      routes: [{ match: dataCite('/repositories'), respond: json({ data: [], meta: {} }) }],
      call: (svc: DataCiteService) =>
        svc.searchRepositories({ callerQuery: false, page: 1, size: 20 }, createMockContext()),
    },
    {
      name: 'full records',
      ttlMs: 15 * MINUTE,
      routes: [
        {
          match: dataCite('/dois'),
          respond: fixtureResponse('datacite/works/record-dryad-234.json'),
        },
      ],
      call: (svc: DataCiteService) => svc.getWork('10.5061/dryad.234', createMockContext()),
    },
    {
      name: 'reverse queries',
      ttlMs: 15 * MINUTE,
      routes: [{ match: dataCite('/dois'), respond: json(emptyDoiList()) }],
      call: (svc: DataCiteService) =>
        svc.queryRecords(
          'relatedIdentifiers.relatedIdentifier:"x"',
          NODE_FIELDS,
          10,
          createMockContext(),
        ),
    },
    {
      name: 'hydration batches',
      ttlMs: 15 * MINUTE,
      routes: [{ match: dataCite('/dois'), respond: json(emptyDoiList()) }],
      call: (svc: DataCiteService) =>
        svc.hydrate(['10.5061/dryad.234'], NODE_FIELDS, createMockContext()),
    },
    {
      name: 'events',
      ttlMs: 15 * MINUTE,
      routes: [{ match: dataCite('/events'), respond: json({ data: [], meta: { total: 0 } }) }],
      call: (svc: DataCiteService) =>
        svc.getEvents(
          { doi: '10.5061/dryad.234', relationTypeIds: ['cites'] },
          createMockContext(),
        ),
    },
    ...([200, 204, 404] as const).map((status) => ({
      name: `negotiation ${status}`,
      ttlMs: status === 200 ? 60 * MINUTE : 5 * MINUTE,
      routes: [negotiation(status)],
      call: (svc: DataCiteService) =>
        svc.negotiate('10.5061/dryad.234', 'text/x-bibliography', {}, createMockContext()),
    })),
  ])('caches $name for exactly their TTL', async ({ routes, ttlMs, call }) => {
    const { http, clock, svc } = build(routes);
    await call(svc);
    clock.advance(ttlMs - 1);
    await call(svc);
    expect(http.calls).toHaveLength(1);
    clock.advance(1);
    await call(svc);
    expect(http.calls).toHaveLength(2);
  });

  it('caches registration-agency answers for 24 h', async () => {
    const http = createFetchMock([
      { match: doiRa('10.1038/nature12373'), respond: fixtureResponse('doi-ra/crossref.json') },
    ]);
    const clock = manualClock();
    const ra = buildRa(http, new TtlCache<CachedResponse>({ now: clock.now }));
    await ra.classifyMiss('10.1038/nature12373', createMockContext());
    clock.advance(24 * 60 * MINUTE - 1);
    await ra.classifyMiss('10.1038/nature12373', createMockContext());
    expect(http.calls).toHaveLength(1);
    clock.advance(1);
    await ra.classifyMiss('10.1038/nature12373', createMockContext());
    expect(http.calls).toHaveLength(2);
  });

  it('serves but never caches a body over 1,000,000 bytes, measured in UTF-8 bytes', async () => {
    const bodies: Record<string, string> = {
      '10.5555/at-limit': 'a'.repeat(1_000_000),
      '10.5555/over-limit': 'a'.repeat(1_000_001),
      '10.5555/multibyte': 'é'.repeat(500_001),
    };
    const { http, svc } = build(
      Object.entries(bodies).map(([doi, body]) => ({
        match: dataCite(`/dois/text/x-bibliography/${encodeURIComponent(doi)}`),
        respond: text(body),
      })),
    );
    const render = (doi: string) =>
      svc.negotiate(doi, 'text/x-bibliography', {}, createMockContext());
    for (const doi of Object.keys(bodies)) {
      const first = await render(doi);
      expect(first.body).toBe(bodies[doi]);
      await render(doi);
    }
    const perDoi = Object.keys(bodies).map(
      (doi) =>
        http.calls.filter((call) => call.request.url.includes(encodeURIComponent(doi))).length,
    );
    expect(perDoi).toEqual([1, 2, 2]);
  });

  it('keeps cached bodies within 50,000,000 bytes, evicting the least recently used', async () => {
    const body = 'a'.repeat(999_000);
    const { http, svc } = build([
      {
        match: (request) =>
          new URL(request.url).pathname.startsWith('/dois/text/x-bibliography/10.5555'),
        respond: () => text(body),
      },
    ]);
    const render = (n: number) =>
      svc.negotiate(`10.5555/c${n}`, 'text/x-bibliography', {}, createMockContext());
    for (let n = 0; n < 60; n++) await render(n);
    expect(http.calls).toHaveLength(60);
    await render(59);
    expect(http.calls).toHaveLength(60);
    await render(0);
    expect(http.calls).toHaveLength(61);
  });

  it('never caches a response that failed to parse or a status outside the accept-list', async () => {
    const { http, svc } = build([
      {
        match: dataCite('/dois', (url) => url.searchParams.get('query') === 'doi:"10.5555/item.1"'),
        respond: json('{"data": ['),
      },
      { match: dataCite('/dois'), respond: json({ errors: [] }, { status: 404 }) },
    ]);
    await expect(lookup(svc, 1)).rejects.toMatchObject({ code: JsonRpcErrorCode.InternalError });
    await expect(lookup(svc, 1)).rejects.toMatchObject({ code: JsonRpcErrorCode.InternalError });
    await expect(lookup(svc, 2)).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
    await expect(lookup(svc, 2)).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
    expect(http.calls).toHaveLength(4);
  });
});

describe('response handling', () => {
  const HTML = '<!DOCTYPE html>\n<html><body>Maintenance</body></html>';

  it('treats an HTML page on a 200 as ServiceUnavailable and retries it', async () => {
    fakeTimers();
    const { http, svc } = build([{ match: dataCite('/dois'), respond: text(HTML) }]);
    const outcome = settle(lookup(svc, 1));
    await vi.advanceTimersByTimeAsync(10_000);
    const error = errorOf(await outcome);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('HTML page');
    expect(http.calls).toHaveLength(3);
  });

  it('recovers when the retry after an HTML page returns data', async () => {
    fakeTimers();
    const { http, svc } = build([
      once(dataCite('/dois'), text(`  <html lang="en">${HTML}`)),
      {
        match: dataCite('/dois'),
        respond: fixtureResponse('datacite/works/record-dryad-234.json'),
      },
    ]);
    const outcome = settle(svc.getRecord('10.5061/dryad.234', NODE_FIELDS, createMockContext()));
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await outcome;
    expect(result.ok && result.value?.id).toBe('10.5061/dryad.234');
    expect(http.calls).toHaveLength(2);
  });

  it('checks for HTML only on a 200: a negotiation 404 page is a result', async () => {
    const { svc } = build([
      {
        match: dataCite('/dois/text/x-bibliography/10.5555%2Fx'),
        respond: text(HTML, { status: 404 }),
      },
    ]);
    await expect(
      svc.negotiate('10.5555/x', 'text/x-bibliography', {}, createMockContext()),
    ).resolves.toEqual({ status: 404, body: HTML });
  });

  it('fails unparseable JSON as InternalError after one request', async () => {
    const { http, svc } = build([{ match: dataCite('/dois'), respond: json('not json') }]);
    const error = errorOf(await settle(lookup(svc, 1)));
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toBe('DataCite returned unparseable JSON for getRecord.');
    expect(http.calls).toHaveLength(1);
  });

  it('fails with Timeout and makes no request once the 45 s call budget is spent', async () => {
    fakeTimers();
    const { http, svc } = build([{ match: dataCite('/dois'), respond: json(emptyDoiList()) }]);
    const ctx = createMockContext();
    vi.setSystemTime(Date.now() + 44_999);
    await lookup(svc, 1, ctx);
    expect(http.calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 1);
    const error = errorOf(await settle(lookup(svc, 2, ctx)));
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe('The 45 s budget for DataCite requests ran out.');
    expect(http.calls).toHaveLength(1);
  });

  it('times out a hung request per attempt and fails with Timeout inside the call deadline', async () => {
    fakeTimers();
    const { http, svc } = build([{ match: dataCite('/dois'), respond: hang }]);
    const outcome = settle(lookup(svc, 1));
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(http.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(45_000 - 19_999);
    expect(settled).toBe(true);
    const error = errorOf(await outcome);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(http.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('retries a 500 whose body claims a 400 and never reads it as a query error', async () => {
    fakeTimers();
    const transient = fixtureResponse('datacite/errors/transient-500-claims-400.json', {
      status: 500,
    });
    const { http, svc } = build([
      once(dataCite('/dois'), transient),
      { match: dataCite('/dois'), respond: json(emptyDoiList()) },
    ]);
    const outcome = settle(
      svc.searchWorks({ ...SEARCH, query: 'a', callerQuery: true }, createMockContext()),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await outcome).ok).toBe(true);
    expect(http.calls).toHaveLength(2);
  });

  it('surfaces a persistent 500-with-400-body as ServiceUnavailable after three attempts', async () => {
    fakeTimers();
    const { http, svc } = build([
      {
        match: dataCite('/dois'),
        respond: fixtureResponse('datacite/errors/transient-500-claims-400.json', { status: 500 }),
      },
    ]);
    const outcome = settle(
      svc.searchWorks({ ...SEARCH, query: 'a', callerQuery: true }, createMockContext()),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const error = errorOf(await outcome);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).not.toBe('invalid_query');
    expect(http.calls).toHaveLength(3);
  });
});

describe('error bodies', () => {
  it('classifies a parse error from the head of an endless 400 body and cancels the rest unread', async () => {
    const head = new TextEncoder().encode(
      '{"errors":{"title":"parse_exception: Encountered \\"<EOF>\\" at line 1, column 12."}}',
    );
    let pulls = 0;
    let cancelled = false;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(pulls === 1 ? head : new Uint8Array(1024).fill(0x20));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 400 },
      );
    const { http, svc } = build([{ match: dataCite('/dois'), respond: endless }]);
    const error = errorOf(
      await settle(
        svc.searchWorks(
          { ...SEARCH, query: 'titles.title:(glacier', callerQuery: true },
          createMockContext(),
        ),
      ),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_query');
    expect(error.message).toContain('(line 1, column 12)');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(4);
    expect(http.calls).toHaveLength(1);
  });
});

describe('response size', () => {
  const MB = 1_000_000;
  const MIME = 'application/vnd.datacite.datacite+json';

  /** A 200 whose body streams `total` bytes in 1 MB chunks, recording pulls and a cancel. */
  function streamed(total: number) {
    const chunk = new Uint8Array(MB).fill(0x61);
    const state = { pulls: 0, cancelled: false };
    const respond = () => {
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            state.pulls += 1;
            const size = Math.min(MB, total - sent);
            if (size <= 0) {
              controller.close();
              return;
            }
            controller.enqueue(chunk.subarray(0, size));
            sent += size;
          },
          cancel() {
            state.cancelled = true;
          },
        }),
        { status: 200 },
      );
    };
    return { respond, state };
  }

  const render = (svc: DataCiteService) =>
    svc.negotiate('10.5555/big', MIME, {}, createMockContext());

  it('reads a body of exactly 32,000,000 bytes', async () => {
    const { respond } = streamed(32 * MB);
    const { svc } = build([{ match: dataCite(`/dois/${MIME}/10.5555%2Fbig`), respond }]);
    const result = await render(svc);
    expect(result.body).toHaveLength(32 * MB);
  });

  it('stops reading past 32,000,000 bytes and fails as ServiceUnavailable after one request', async () => {
    const { respond, state } = streamed(40 * MB);
    const { http, svc } = build([{ match: dataCite(`/dois/${MIME}/10.5555%2Fbig`), respond }]);
    const error = errorOf(await settle(render(svc)));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe(
      'DataCite answered with more than 32 MB, the most this server reads from one response, so the answer was not read; the record or page is too large to return, and a retry gets the same answer.',
    );
    expect(error.data).toEqual({ maxBytes: 32 * MB, retryable: false });
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(34);
    expect(http.calls).toHaveLength(1);
  });
});

describe('redirects', () => {
  const redirect = () =>
    new Response('<html>Moved</html>', {
      status: 301,
      headers: { location: 'https://attacker.example/steal' },
    });

  it('never follows a redirect: one request, sent with redirect "manual", failing as ServiceUnavailable', async () => {
    const { http, svc } = build([{ match: dataCite('/dois'), respond: redirect }]);
    const error = errorOf(await settle(lookup(svc, 1)));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe(
      'DataCite answered with a redirect (HTTP 301), which this server does not follow.',
    );
    expect(error.data).toEqual({ status: 301, retryable: false });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.redirect).toBe('manual');
  });

  it('degrades a redirected registration-agency lookup to unclassified after one request', async () => {
    const http = createFetchMock([{ match: doiRa('10.5555/x'), respond: redirect }]);
    const ra = buildRa(http, new TtlCache<CachedResponse>());
    await expect(ra.classifyMiss('10.5555/x', createMockContext())).resolves.toEqual({
      missReason: 'unclassified',
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.redirect).toBe('manual');
  });
});

describe('HTTP 429', () => {
  it('fails an unhinted 429 fast, stating the 30 s gate it armed', async () => {
    const { http, svc } = build([{ match: dataCite('/dois'), respond: rateLimitResponse() }]);
    const error = errorOf(await settle(lookup(svc, 1)));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 30, retryable: true });
    expect(error.message).toContain('retry in 30 seconds');
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    { form: 'delta-seconds', header: () => '5' },
    { form: 'HTTP-date', header: () => new Date(Date.now() + 10_000).toUTCString() },
    { form: 'delta-seconds at the 30 s ceiling', header: () => '30' },
  ])('retries a hinted 429 ($form) after the 30 s gate', async ({ header }) => {
    fakeTimers();
    const { http, svc } = build([
      once(dataCite('/dois'), rateLimitResponse(header())),
      { match: dataCite('/dois'), respond: json(emptyDoiList()) },
    ]);
    const outcome = settle(lookup(svc, 1));
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    expect(http.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await outcome).ok).toBe(true);
    expect(http.calls).toHaveLength(2);
  });

  it.each([
    { header: '31', retryAfter: 31 },
    { header: '120', retryAfter: 120 },
    { header: '600', retryAfter: 300 },
  ])(
    'fails fast when Retry-After $header outlasts the retry cap',
    async ({ header, retryAfter }) => {
      const { http, svc } = build([
        { match: dataCite('/dois'), respond: rateLimitResponse(header) },
      ]);
      const error = errorOf(await settle(lookup(svc, 1)));
      expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter });
      expect(error.message).toContain(`retry in ${retryAfter} seconds`);
      expect(http.calls).toHaveLength(1);
    },
  );

  it('doubles the gate per consecutive 429, caps it at 300 s, and resets on an accepted answer', async () => {
    const { svc } = build([
      {
        match: dataCite(
          '/dois',
          (url) => url.searchParams.get('query') === 'doi:"10.5555/item.99"',
        ),
        respond: json(emptyDoiList()),
      },
      { match: dataCite('/dois'), respond: rateLimitResponse() },
    ]);
    const waits: unknown[] = [];
    for (let n = 1; n <= 6; n++) waits.push(errorOf(await settle(lookup(svc, n))).data?.retryAfter);
    expect(waits).toEqual([30, 60, 120, 240, 300, 300]);
    await lookup(svc, 99);
    expect(errorOf(await settle(lookup(svc, 7))).data?.retryAfter).toBe(30);
  });

  it('counts a retried 429 toward the doubling within one call', async () => {
    fakeTimers();
    const { http, svc } = build([{ match: dataCite('/dois'), respond: rateLimitResponse('5') }]);
    const outcome = settle(lookup(svc, 1));
    await vi.advanceTimersByTimeAsync(31_000);
    const error = errorOf(await outcome);
    expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
    expect(http.calls).toHaveLength(2);
  });

  it('closes a cooldown pacer so the next caller sheds at once with the remaining wait', async () => {
    const pacer = createPacer({
      name: 'cooldown',
      limits: [{ requests: 10_000, perMs: 1000 }],
      cooldown: { baseMs: 30_000, maxMs: 300_000 },
    });
    disposables.push(pacer);
    const { http, svc } = build([{ match: dataCite('/dois'), respond: rateLimitResponse('120') }], {
      pacer,
    });
    expect(errorOf(await settle(lookup(svc, 1))).data?.retryAfter).toBe(120);
    const shed = errorOf(await settle(lookup(svc, 2)));
    expect(shed.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(shed.data).toMatchObject({ reason: 'rate_limited', retryAfter: 120, retryable: true });
    expect(shed.message).toContain('retry in 120 seconds');
    expect((shed.cause as McpError).data?.reason).toBe('pacer_shed');
    expect(http.calls).toHaveLength(1);
  });
});

describe('request budget', () => {
  it('rethrows a pacer shed as rate_limited stating the wait in seconds', async () => {
    const pacer = createPacer({ name: 'spent', limits: [{ requests: 1, perMs: 5 * MINUTE }] });
    disposables.push(pacer);
    const { http, svc } = build([{ match: dataCite('/dois'), respond: json(emptyDoiList()) }], {
      pacer,
    });
    await lookup(svc, 1);
    const error = errorOf(await settle(lookup(svc, 2)));
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 300, retryable: true });
    expect(error.message).toBe(
      "This deployment's shared DataCite request budget is spent for the current window; retry in 300 seconds.",
    );
    expect(http.calls).toHaveLength(1);
  });

  /** Fires `count` distinct lookups at once against the default production pacer. */
  function burst(options: Pick<DataCiteServiceOptions, 'budget' | 'contactEmail'>, count: number) {
    const http = createFetchMock([
      { match: onPath(DATACITE, '/dois'), respond: json(emptyDoiList()) },
    ]);
    const svc = new DataCiteService({ fetch: http.fetch, version: TEST_VERSION, ...options });
    disposables.push(svc);
    const ctx = createMockContext();
    const calls = Array.from({ length: count }, (_, n) => settle(lookup(svc, n, ctx)));
    return { svc, calls };
  }

  it.each([
    { name: 'without a contact email (400)', options: {}, budget: 400 },
    { name: 'from an explicit budget (50)', options: { budget: 50 }, budget: 50 },
  ])('sheds the request past the default pacer budget $name', async ({ options, budget }) => {
    const { svc, calls } = burst(options, budget + 1);
    const last = errorOf(await (calls[budget] as Promise<Outcome<unknown>>));
    expect(last.data?.reason).toBe('rate_limited');
    expect(last.data?.retryAfter).toBeGreaterThanOrEqual(299);
    expect(last.data?.retryAfter).toBeLessThanOrEqual(300);
    svc.dispose();
    const outcomes = await Promise.all(calls.slice(0, budget));
    expect(
      outcomes.every((o) => o.ok || (o.error as McpError).data?.reason !== 'rate_limited'),
    ).toBe(true);
  });

  it('queues the 401st request when a contact email raises the budget to 800', async () => {
    const { svc, calls } = burst({ contactEmail: EMAIL }, 401);
    let settled = false;
    void (calls[400] as Promise<Outcome<unknown>>).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    svc.dispose();
    const error = errorOf(await (calls[400] as Promise<Outcome<unknown>>));
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    await Promise.all(calls);
  });
});
