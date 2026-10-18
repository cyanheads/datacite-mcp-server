/**
 * @fileoverview Exact FundRef identity, completeness, caching, deadline and cancellation tests.
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
import { fastPacer, hang, json, onPath, requestUrl } from '../../helpers/harness.js';

const services: RorService[] = [];
const funder = '10.13039/501100001659';
const exact = {
  id: 'https://ror.org/018mejw64',
  external_ids: [{ type: 'fundref', all: ['501100001659'] }],
};
const answer = { number_of_results: 1, items: [exact] };
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
});
function build(respond: FetchMockRoute['respond'], pacer = fastPacer('ror-test')) {
  const http = createFetchMock([
    { match: onPath('https://api.ror.org', '/v2/organizations'), respond },
  ]);
  const service = new RorService({ fetch: http.fetch, pacer, version: 'test' });
  services.push(service);
  return { service, http };
}
describe('RorService', () => {
  it('accepts exact FundRef identity and caches the lookup', async () => {
    const { service, http } = build(() => json(answer));
    for (let i = 0; i < 2; i++)
      expect(await service.resolveFunder(funder, createMockContext())).toBe('018mejw64');
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
    { name: 'invalid JSON', body: '{' },
  ])('keeps the literal fallback for $name', async ({ body }) => {
    const { service, http } = build(() => json(body));
    expect(await service.resolveFunder(funder, createMockContext())).toBeUndefined();
    expect(http.calls).toHaveLength(1);
  });
  it('accepts an exact match beyond the first fuzzy result', async () => {
    const { service } = build(() =>
      json({ number_of_results: 2, items: [{ ...exact, external_ids: [] }, exact] }),
    );
    expect(await service.resolveFunder(funder, createMockContext())).toBe('018mejw64');
  });
  it('does not retry an outage', async () => {
    const { service, http } = build(() => json({}, { status: 503 }));
    expect(await service.resolveFunder(funder, createMockContext())).toBeUndefined();
    expect(http.calls).toHaveLength(1);
  });
  it('includes in-flight time in the five-second budget', async () => {
    vi.useFakeTimers();
    const { service, http } = build(hang);
    const pending = service.resolveFunder(funder, createMockContext());
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toBeUndefined();
    expect(http.calls).toHaveLength(1);
  });
  it('includes queue time in the five-second budget', async () => {
    vi.useFakeTimers();
    const pacer = createPacer({ name: 'ror-queued', limits: [{ requests: 1, perMs: 60_000 }] });
    await pacer.run(async () => undefined);
    const { service, http } = build(() => json(answer), pacer);
    const pending = service.resolveFunder(funder, createMockContext());
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toBeUndefined();
    expect(http.calls).toHaveLength(0);
  });
  it('propagates caller cancellation without starting a fallback search', async () => {
    const controller = new AbortController();
    const { service, http } = build((request) => {
      controller.abort();
      return Promise.reject(request.signal.reason);
    });
    await expect(
      service.resolveFunder(funder, createMockContext({ signal: controller.signal })),
    ).rejects.toBeDefined();
    expect(http.calls).toHaveLength(1);
  });
});
