/**
 * @fileoverview Tests for `renderCitation` over a `DataCiteService` built with an
 * injected, manually clocked style-verdict cache: a verdict belongs to the style
 * id alone, lives 24 hours, and is recomputed once it expires.
 * @module tests/services/datacite/citation.test
 */

import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { renderCitation } from '@/services/datacite/citation.js';
import { DataCiteService, type StyleVerdict } from '@/services/datacite/datacite-service.js';
import { TtlCache } from '@/services/http/ttl-cache.js';
import type { CachedResponse } from '@/services/http/upstream-client.js';
import { fixtureText } from '../../helpers/fixtures.js';
import { dataCite, fastPacer, manualClock, TEST_VERSION, text } from '../../helpers/harness.js';

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_HTML = fixtureText('datacite/citations/dryad-8515-default.html');
const CANARY_DEFAULT_HTML = fixtureText('datacite/citations/canary-dryad-234-default.html');

const services: DataCiteService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

/** Routes answering every text rendering of `doi` with `body`, whatever the style. */
const renders = (doi: string, body: string) => ({
  match: dataCite(`/dois/text/x-bibliography/${encodeURIComponent(doi)}`),
  respond: text(body),
});

/** A service whose response cache and verdict cache share one manual clock. */
function build() {
  const clock = manualClock();
  const http = createFetchMock([
    renders('10.5061/dryad.8515', DEFAULT_HTML),
    renders('10.5555/other', 'Other. (2020). <i>Other</i>.'),
    renders('10.5061/dryad.234', CANARY_DEFAULT_HTML),
  ]);
  const styleVerdicts = new TtlCache<StyleVerdict>({ now: clock.now });
  const service = new DataCiteService({
    fetch: http.fetch,
    pacer: fastPacer(),
    cache: new TtlCache<CachedResponse>({ now: clock.now }),
    styleVerdicts,
    version: TEST_VERSION,
  });
  services.push(service);
  return { clock, http, service, styleVerdicts };
}

describe('style verdicts', () => {
  it('settles a fallback style once, applies the verdict to any DOI, and recomputes it after 24 h', async () => {
    const { clock, http, service, styleVerdicts } = build();
    const request = { format: 'text', style: 'mla' } as const;
    const ctx = createMockContext();

    await expect(
      renderCitation(service, { ...request, doi: '10.5061/dryad.8515' }, ctx),
    ).resolves.toEqual({ kind: 'unsupported_style' });
    expect(http.calls).toHaveLength(4);
    expect(styleVerdicts.get('mla')).toBe('unsupported');

    clock.advance(DAY_MS - 1);
    await expect(
      renderCitation(service, { ...request, doi: '10.5555/other' }, ctx),
    ).resolves.toEqual({ kind: 'unsupported_style' });
    expect(http.calls).toHaveLength(4);

    clock.advance(1);
    expect(styleVerdicts.get('mla')).toBeUndefined();
    await expect(
      renderCitation(service, { ...request, doi: '10.5061/dryad.8515' }, ctx),
    ).resolves.toEqual({ kind: 'unsupported_style' });
    expect(http.calls).toHaveLength(8);
    expect(styleVerdicts.get('mla')).toBe('unsupported');
  });

  it('renders an explicit apa without consulting the verdict cache', async () => {
    const { http, service, styleVerdicts } = build();
    styleVerdicts.set('apa', 'unsupported', DAY_MS);
    const ctx = createMockContext();
    await expect(
      renderCitation(service, { doi: '10.5061/dryad.8515', format: 'text', style: 'apa' }, ctx),
    ).resolves.toEqual({ kind: 'rendered', body: DEFAULT_HTML });
    expect(http.calls).toHaveLength(1);
  });
});
