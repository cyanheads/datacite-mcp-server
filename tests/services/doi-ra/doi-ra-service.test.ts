/**
 * @fileoverview Tests for the doi.org registration-agency lookup that classifies
 * a DOI DataCite holds no public record for: each recorded answer shape, the
 * transient failures that degrade to `unclassified`, and the ones that propagate.
 * @module tests/services/doi-ra/doi-ra-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockRoute,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistrationAgencyService } from '@/services/doi-ra/doi-ra-service.js';
import { fixtureResponse, rateLimitResponse } from '../../helpers/fixtures.js';
import { doiRa, fastPacer, hang, json, requestUrl, TEST_VERSION } from '../../helpers/harness.js';

const services: RegistrationAgencyService[] = [];

afterEach(() => {
  for (const svc of services.splice(0)) svc.dispose();
  vi.useRealTimers();
});

function build(doi: string, respond: FetchMockRoute['respond']) {
  const http = createFetchMock([{ match: doiRa(doi), respond }]);
  const svc = new RegistrationAgencyService({
    fetch: http.fetch,
    pacer: fastPacer(),
    version: TEST_VERSION,
  });
  services.push(svc);
  return { http, svc };
}

describe('RegistrationAgencyService.classifyMiss', () => {
  it.each([
    {
      name: 'another agency',
      doi: '10.1038/nature12373',
      fixture: 'doi-ra/crossref.json',
      expected: { missReason: 'other_agency', registrationAgency: 'Crossref' },
    },
    {
      name: 'DataCite without public metadata',
      doi: '10.5061/dryad.8515',
      fixture: 'doi-ra/datacite.json',
      expected: { missReason: 'not_public', registrationAgency: 'DataCite' },
    },
    {
      name: 'a DOI no agency registered',
      doi: '10.9999/doesnotexist',
      fixture: 'doi-ra/does-not-exist.json',
      expected: { missReason: 'does_not_exist' },
    },
  ])('classifies $name', async ({ doi, fixture, expected }) => {
    const { svc } = build(doi, fixtureResponse(fixture));
    await expect(svc.classifyMiss(doi, createMockContext())).resolves.toEqual(expected);
  });

  it('encodes the whole DOI into the lookup path', async () => {
    const { http, svc } = build('10.1038/nature12373', fixtureResponse('doi-ra/crossref.json'));
    await svc.classifyMiss('10.1038/nature12373', createMockContext());
    expect(requestUrl(http).href).toBe('https://doi.org/ra/10.1038%2Fnature12373');
  });

  it.each([
    { name: 'an empty answer', body: [] },
    { name: 'an entry with neither RA nor status', body: [{ DOI: '10.5555/x' }] },
  ])('leaves $name unclassified', async ({ body }) => {
    const { svc } = build('10.5555/x', json(body));
    await expect(svc.classifyMiss('10.5555/x', createMockContext())).resolves.toEqual({
      missReason: 'unclassified',
    });
  });

  it('degrades a 429 to unclassified and logs a warning', async () => {
    const { http, svc } = build('10.5555/x', rateLimitResponse());
    const ctx = createMockContext();
    await expect(svc.classifyMiss('10.5555/x', ctx)).resolves.toEqual({
      missReason: 'unclassified',
    });
    expect(http.calls).toHaveLength(1);
    expect(
      (ctx.log as MockContextLogger).calls.some(
        (call) => call.level === 'warning' && call.msg.includes('did not answer'),
      ),
    ).toBe(true);
  });

  it.each([
    { name: 'a persistent 5xx', respond: () => json({ errors: [] }, { status: 503 }) },
    { name: 'a hung lookup', respond: () => hang },
  ])('degrades $name to unclassified after retrying', async ({ respond }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { http, svc } = build('10.5555/x', respond());
    const outcome = svc.classifyMiss('10.5555/x', createMockContext());
    await vi.advanceTimersByTimeAsync(46_000);
    await expect(outcome).resolves.toEqual({ missReason: 'unclassified' });
    expect(http.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('propagates a non-transient failure instead of calling it unclassified', async () => {
    const notFound = build('10.5555/x', json({ errors: [] }, { status: 404 }));
    await expect(notFound.svc.classifyMiss('10.5555/x', createMockContext())).rejects.toMatchObject(
      { code: JsonRpcErrorCode.NotFound },
    );
    const garbled = build('10.5555/y', json('<not json'));
    await expect(garbled.svc.classifyMiss('10.5555/y', createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'doi.org returned an unparseable registration-agency answer.',
    });
  });

  it('rethrows when the request was cancelled', async () => {
    const { http, svc } = build('10.5555/x', fixtureResponse('doi-ra/crossref.json'));
    const controller = new AbortController();
    controller.abort(new Error('caller went away'));
    await expect(
      svc.classifyMiss('10.5555/x', createMockContext({ signal: controller.signal })),
    ).rejects.toThrow('caller went away');
    expect(http.calls).toHaveLength(0);
  });
});
