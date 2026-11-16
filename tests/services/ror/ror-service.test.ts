/**
 * @fileoverview Exact FundRef identity, unmatched and unavailable answers, caching, deadline, and cancellation tests.
 * @module tests/services/ror/ror-service.test
 */
import {
  createFetchMock,
  createMockContext,
  type FetchMockRoute,
} from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RorService } from '@/services/ror/ror-service.js';
import { fastPacer, hang, json, once, onPath, requestUrl, text } from '../../helpers/harness.js';

const services: RorService[] = [];
const funder = '10.13039/501100001659';
const exact = {
  id: 'https://ror.org/018mejw64',
  external_ids: [{ type: 'fundref', all: ['501100001659'] }],
};
const answer = { number_of_results: 1, items: [exact] };
const resolved = { status: 'resolved', ror: '018mejw64' };
const rorPath = onPath('https://api.ror.org', '/v2/organizations');
const botCheck = '<!DOCTYPE html><html><title>Just a moment...</title></html>';
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
});
function build(
  respond: FetchMockRoute['respond'] | FetchMockRoute[],
  pacer = fastPacer('ror-test'),
) {
  const http = createFetchMock(Array.isArray(respond) ? respond : [{ match: rorPath, respond }]);
  const service = new RorService({ fetch: http.fetch, pacer, version: 'test' });
  services.push(service);
  return { service, http };
}
describe('RorService', () => {
  it('accepts exact FundRef identity and caches the lookup', async () => {
    const { service, http } = build(() => json(answer));
    for (let i = 0; i < 2; i++)
      expect(await service.resolveFunder(funder, createMockContext())).toEqual(resolved);
    expect(http.calls).toHaveLength(1);
    expect(requestUrl(http).searchParams.get('query')).toBe('501100001659');
  });
  it.each([
    { name: 'empty', body: { number_of_results: 0, items: [] } },
    {
      name: 'fuzzy',
      body: {
        number_of_results: 1,
        items: [{ ...exact, external_ids: [{ type: 'fundref', all: ['501100001650'] }] }],
      },
    },
    {
      name: 'wrong type',
      body: {
        number_of_results: 1,
        items: [{ ...exact, external_ids: [{ type: 'grid', all: ['501100001659'] }] }],
      },
    },
    {
      name: 'ambiguous',
      body: { number_of_results: 2, items: [exact, { ...exact, id: 'https://ror.org/021nxhr62' }] },
    },
    { name: 'incomplete', body: { number_of_results: 2, items: [exact] } },
    {
      name: 'malformed sibling',
      body: { number_of_results: 2, items: [exact, { id: 'https://ror.org/021nxhr62' }] },
    },
    {
      name: 'malformed id',
      body: { number_of_results: 1, items: [{ ...exact, id: 'https://example.com/018mejw64' }] },
    },
  ])('reports $name as unmatched from its one request', async ({ body }) => {
    const { service, http } = build(() => json(body));
    expect(await service.resolveFunder(funder, createMockContext())).toEqual({
      status: 'unmatched',
    });
    expect(http.calls).toHaveLength(1);
  });
  it('accepts an exact match beyond the first fuzzy result', async () => {
    const { service } = build(() =>
      json({ number_of_results: 2, items: [{ ...exact, external_ids: [] }, exact] }),
    );
    expect(await service.resolveFunder(funder, createMockContext())).toEqual(resolved);
  });
  it.each([
    { name: 'a 503', respond: () => json({}, { status: 503 }) },
    { name: 'a 500', respond: () => json({}, { status: 500 }) },
    { name: 'a 429', respond: () => json({}, { status: 429, headers: { 'retry-after': '1' } }) },
    { name: 'a 404', respond: () => json({}, { status: 404 }) },
    { name: 'a redirect', respond: () => json({}, { status: 301 }) },
    {
      name: 'a 403 bot-check page',
      respond: () => text(botCheck, { status: 403, headers: { 'content-type': 'text/html' } }),
    },
    {
      name: 'a 200 bot-check page',
      respond: () => text(botCheck, { headers: { 'content-type': 'text/html' } }),
    },
    { name: 'a body that is not JSON', respond: () => json('{') },
    { name: 'a network failure', respond: () => Promise.reject(new TypeError('fetch failed')) },
  ])('reports $name as unavailable after one attempt', async ({ respond }) => {
    const { service, http } = build(respond);
    expect(await service.resolveFunder(funder, createMockContext())).toEqual({
      status: 'unavailable',
    });
    expect(http.calls).toHaveLength(1);
  });
  it('does not cache an outage, so the next lookup asks ROR again', async () => {
    const { service, http } = build([
      once(rorPath, () => json({}, { status: 503 })),
      { match: rorPath, respond: () => json(answer) },
    ]);
    expect(await service.resolveFunder(funder, createMockContext())).toEqual({
      status: 'unavailable',
    });
    expect(await service.resolveFunder(funder, createMockContext())).toEqual(resolved);
    expect(http.calls).toHaveLength(2);
  });
  it('includes in-flight time in the five-second budget', async () => {
    vi.useFakeTimers();
    const { service, http } = build(hang);
    const pending = service.resolveFunder(funder, createMockContext());
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toEqual({ status: 'unavailable' });
    expect(http.calls).toHaveLength(1);
  });
  it('includes queue time in the five-second budget', async () => {
    vi.useFakeTimers();
    const pacer = createPacer({ name: 'ror-queued', limits: [{ requests: 1, perMs: 60_000 }] });
    await pacer.run(async () => undefined);
    const { service, http } = build(() => json(answer), pacer);
    const pending = service.resolveFunder(funder, createMockContext());
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toEqual({ status: 'unavailable' });
    expect(http.calls).toHaveLength(0);
  });
  it('rethrows the caller cancellation itself, never an outage or another error', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Lookup cancelled by caller.', 'AbortError');
    const { service, http } = build((request) => {
      controller.abort(reason);
      return Promise.reject(request.signal.reason);
    });
    await expect(
      service.resolveFunder(funder, createMockContext({ signal: controller.signal })),
    ).rejects.toBe(reason);
    expect(http.calls).toHaveLength(1);
  });
});
