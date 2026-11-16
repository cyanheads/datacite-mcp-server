/**
 * @fileoverview Tests for `renderCitation` over a `DataCiteService` built with an
 * injected, manually clocked style-verdict cache: a verdict belongs to the style
 * id alone, lives 24 hours, and is recomputed once it expires. Also the slice
 * boundaries `sliceDocument` picks: surrogate pairs, tags, and character
 * references are never split, and a walk always advances and reassembles the
 * document.
 * @module tests/services/datacite/citation.test
 */

import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { type DocumentSlice, renderCitation, sliceDocument } from '@/services/datacite/citation.js';
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
  it('carries the requested negotiated URL through a successful cached style verdict', async () => {
    const { service } = build();
    service.styleVerdicts.set('ieee', 'supported', DAY_MS);
    await expect(
      renderCitation(
        service,
        { doi: '10.5061/dryad.8515', format: 'text', style: 'ieee', locale: 'de-DE' },
        createMockContext(),
      ),
    ).resolves.toEqual({
      kind: 'rendered',
      body: DEFAULT_HTML,
      downloadUrl:
        'https://api.datacite.org/dois/text/x-bibliography/10.5061%2Fdryad.8515?style=ieee&locale=de-DE',
    });
  });
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
    ).resolves.toEqual({
      kind: 'rendered',
      body: DEFAULT_HTML,
      downloadUrl:
        'https://api.datacite.org/dois/text/x-bibliography/10.5061%2Fdryad.8515?style=apa',
    });
    expect(http.calls).toHaveLength(1);
  });
});

describe('sliceDocument', () => {
  const PAIR = '😀';
  it.each([
    ['the whole document', 'abcdef', 0, 6, false, [0, 6]],
    ['the first limit units', 'abcdef', 0, 5, false, [0, 5]],
    ['a middle slice', 'abcdef', 2, 2, false, [2, 4]],
    ['a limit running past the end', 'abcdef', 4, 100, false, [4, 6]],
    ['an offset at the end', 'abcdef', 6, 3, false, [6, 6]],
    ['an offset past the end', 'abcdef', 99, 3, false, [6, 6]],
    ['an end inside a pair, moved back', `ab${PAIR}cd`, 0, 3, false, [0, 2]],
    ['an end right after a pair', `ab${PAIR}cd`, 0, 4, false, [0, 4]],
    ['an offset inside a pair, moved back', `ab${PAIR}cd`, 3, 3, false, [2, 5]],
    ['limit 1 at a pair, taking the whole pair', `ab${PAIR}cd`, 2, 1, false, [2, 4]],
    ['adjacent pairs', `${PAIR}${PAIR}`, 0, 3, false, [0, 2]],
    ['a lone high surrogate at the end', 'ab\ud83d', 1, 2, false, [1, 3]],
    ['a lone low surrogate', 'a\ude00b', 1, 1, false, [1, 2]],
    ['tags in a machine document', 'ab<i>cd', 0, 4, false, [0, 4]],
    ['an end inside a tag, moved to its <', 'ab<i>cd', 0, 4, true, [0, 2]],
    ['an end right after a tag', 'ab<i>cd', 0, 5, true, [0, 5]],
    ['an end right before a tag', 'ab<i>cd', 0, 2, true, [0, 2]],
    ['an offset inside a tag, moved to its <', 'ab<i>cd', 3, 4, true, [2, 6]],
    ['limit 1 at a tag, taking the whole tag', 'ab<i>cd', 2, 1, true, [2, 5]],
    ['an end inside a named reference', 'a&amp;b', 0, 3, true, [0, 1]],
    ['an end inside a decimal reference', 'a&#38;b', 0, 4, true, [0, 1]],
    ['an end inside a hex reference', 'a&#x26;b', 0, 5, true, [0, 1]],
    ["an end just before a reference's ;", 'a&amp;b', 0, 5, true, [0, 1]],
    ['limit 2 at a reference, taking the whole reference', 'a&amp;b', 1, 2, true, [1, 6]],
    ['a stray < that opens no tag', 'T < 5 K <i>x</i>', 0, 3, true, [0, 3]],
    ['a stray & that opens no reference', 'a & b &c d', 0, 7, true, [0, 7]],
    ['an unterminated reference', 'a&amp b', 0, 3, true, [0, 3]],
    ['a reference inside a tag, taking the tag', '<a t="&amp;">x', 0, 8, true, [0, 13]],
    ['a pair inside a tag, taking the tag', `<i t="${PAIR}">x`, 0, 7, true, [0, 10]],
    ['an end between a tag and a pair', `<i>${PAIR}`, 0, 3, true, [0, 3]],
  ] as const)('%s', (_name, body, offset, limit, html, [start, end]) => {
    expect(sliceDocument(body, offset, limit, html)).toEqual({ start, end });
  });

  /** Deterministic pseudo-random integers in [0, n), seeded. */
  function random(seed: number) {
    let state = seed >>> 0;
    return (n: number) => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (((t ^ (t >>> 14)) >>> 0) % n) as number;
    };
  }
  const PIECES = ['a', 'b', ' ', 'é', PAIR, '<i>', '</i>', '&amp;', '&#38;', '<', '&', '>', ';'];
  /**
   * The units no boundary may split, found without the code under test: surrogate
   * pairs, and in HTML every tag (`<`, no `<` or `>`, `>`) and `;`-terminated
   * character reference. Spans nest (a reference or pair inside a tag) or are disjoint.
   */
  const unitSpans = (text: string, html: boolean): DocumentSlice[] =>
    [
      /[\ud800-\udbff][\udc00-\udfff]/g,
      ...(html ? [/<[^<>]*>/g, /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi] : []),
    ].flatMap((pattern) =>
      [...text.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length })),
    );

  it.each([false, true])(
    'walks generated documents (html %s) to their end from any offset, never splitting a unit',
    (html) => {
      const next = random(html ? 40 : 4);
      for (let doc = 0; doc < 300; doc++) {
        const body = Array.from({ length: 1 + next(40) }, () => PIECES[next(PIECES.length)]).join(
          '',
        );
        const spans = unitSpans(body, html);
        const splits = (at: number) => spans.some((unit) => unit.start < at && at < unit.end);
        const limit = 1 + next(8);
        let start = sliceDocument(body, next(body.length + 2), limit, html).start;
        const first = start;
        const slices: string[] = [];
        while (start < body.length) {
          const slice = sliceDocument(body, start, limit, html);
          expect(slice.start).toBe(start);
          expect(slice.end).toBeGreaterThan(start);
          expect(splits(slice.end)).toBe(false);
          // Past limit only to take whole the one unit starting here; units never share a start.
          if (slice.end - start > limit) {
            expect(spans.find((unit) => unit.start === start)).toEqual({ start, end: slice.end });
          }
          slices.push(body.slice(slice.start, slice.end));
          start = slice.end;
        }
        expect(slices.join('')).toBe(body.slice(first));
        expect(splits(first)).toBe(false);
      }
    },
  );
});
