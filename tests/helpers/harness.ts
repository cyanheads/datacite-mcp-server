/**
 * @fileoverview Shared test harness: upstream route predicates matched on exact
 * origin + path, `Response` builders, a manual clock, a pacer that never waits,
 * per-test service wiring over a strict fetch fake, and accessors for both
 * consumption paths of a tool result (`structuredContent` and `content[]` text).
 * @module tests/helpers/harness
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  type FetchMockHarness,
  type FetchMockRoute,
} from '@cyanheads/mcp-ts-core/testing';
import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';
import { vi } from 'vitest';
import {
  initDataCiteServices,
  shutdownDataCiteServices,
} from '@/services/datacite/datacite-service.js';
import { TtlCache } from '@/services/http/ttl-cache.js';
import type { CachedResponse } from '@/services/http/upstream-client.js';

export const DATACITE = 'https://api.datacite.org';
export const DOI_ORG = 'https://doi.org';
/** Version string every harness-built service puts in its User-Agent. */
export const TEST_VERSION = '9.9.9-test';
/** A fixed epoch the manual clock starts from (2026-09-26T00:00:00Z). */
export const CLOCK_START = Date.UTC(2026, 8, 26);

type UrlPredicate = (url: URL) => boolean;

/**
 * A request predicate matching `origin` + `pathname` exactly (never a prefix),
 * optionally narrowed by a check on the parsed URL (e.g. a query parameter).
 */
export function onPath(origin: string, pathname: string, where?: UrlPredicate) {
  return (request: Request): boolean => {
    const url = new URL(request.url);
    return url.origin === origin && url.pathname === pathname && (where?.(url) ?? true);
  };
}

/** `onPath` on api.datacite.org. */
export const dataCite = (pathname: string, where?: UrlPredicate) =>
  onPath(DATACITE, pathname, where);

/** The doi.org registration-agency path for a DOI, encoded the way the service sends it. */
export const raPath = (doi: string): string => `/ra/${encodeURIComponent(doi)}`;

/** `onPath` on doi.org's registration-agency lookup for `doi`. */
export const doiRa =
  (doi: string) =>
  (request: Request): boolean => {
    const url = new URL(request.url);
    return url.origin === DOI_ORG && url.pathname === raPath(doi);
  };

/** Predicate helper: a query parameter equals `value`. */
export const param =
  (name: string, value: string): UrlPredicate =>
  (url) =>
    url.searchParams.get(name) === value;

/** A JSON response; `body` is serialized unless it is already a string. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    ...(init.statusText !== undefined && { statusText: init.statusText }),
    headers,
  });
}

/** A text response (content negotiation, HTML pages). */
export function text(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
  return new Response(body, { status: init.status ?? 200, headers });
}

/** A route that answers once, then falls through to later routes. */
export const once = (match: FetchMockRoute['match'], respond: FetchMockRoute['respond']) =>
  ({ match, respond, once: true }) satisfies FetchMockRoute;

/**
 * A responder that never answers on its own: it settles only when the request's
 * signal aborts (per-attempt timeout, deadline, or cancellation).
 */
export const hang = (request: Request): Promise<Response> =>
  new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  });

/**
 * Every line break beyond LF and CR that a reader may split a line on: the other
 * mandatory breaks of Unicode line breaking (UAX #14), and the file, group, and
 * record separators Python's `str.splitlines` also splits on.
 */
export const OTHER_LINE_BREAKS = [
  ['VT', '\v'],
  ['FF', '\f'],
  ['FS', '\x1c'],
  ['GS', '\x1d'],
  ['RS', '\x1e'],
  ['NEL', '\u0085'],
  ['LS', '\u{2028}'],
  ['PS', '\u{2029}'],
] as const;

/** A clock the test advances by hand, for `TtlCache({ now })`. */
export interface ManualClock {
  advance(ms: number): void;
  now(): number;
}

export function manualClock(start = CLOCK_START): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

/** A pacer with limits so generous no test ever waits on it, and no cooldown. */
export const fastPacer = (name = 'test'): Pacer =>
  createPacer({ name, limits: [{ requests: 10_000, perMs: 1000 }] });

/** What {@link initServices} wired, for assertions and further routes. */
export interface ServiceHarness {
  cache: TtlCache<CachedResponse>;
  clock: ManualClock;
  http: FetchMockHarness;
  pacer: Pacer;
  raPacer: Pacer;
}

export interface InitServicesOptions {
  budget?: number;
  contactEmail?: string;
  pacer?: Pacer;
  raPacer?: Pacer;
}

/**
 * Wires both services over a strict fetch fake, a manually clocked shared cache,
 * and fast pacers. The server's env vars are stubbed blank first so the host
 * shell never leaks a contact email or budget into a test; pass them as options.
 * Pair with {@link teardownServices} in `afterEach`.
 */
export function initServices(
  routes: readonly FetchMockRoute[] = [],
  options: InitServicesOptions = {},
): ServiceHarness {
  vi.stubEnv('DATACITE_CONTACT_EMAIL', '');
  vi.stubEnv('DATACITE_MAX_REQUESTS_PER_5MIN', '');
  const http = createFetchMock(routes);
  const clock = manualClock();
  const cache = new TtlCache<CachedResponse>({ now: clock.now });
  const pacer = options.pacer ?? fastPacer('datacite-test');
  const raPacer = options.raPacer ?? fastPacer('doi-ra-test');
  initDataCiteServices({
    fetch: http.fetch,
    cache,
    pacer,
    raPacer,
    version: TEST_VERSION,
    ...(options.contactEmail !== undefined && { contactEmail: options.contactEmail }),
    ...(options.budget !== undefined && { budget: options.budget }),
  });
  return { http, clock, cache, pacer, raPacer };
}

/** Disposes both services' pacers and restores stubbed env vars. */
export function teardownServices(): void {
  shutdownDataCiteServices();
  vi.unstubAllEnvs();
}

/** The parsed URL of the `index`-th captured request. */
export function requestUrl(http: FetchMockHarness, index = 0): URL {
  const call = http.calls[index];
  if (!call) throw new Error(`No request #${index}; ${http.calls.length} captured.`);
  return new URL(call.request.url);
}

/** Every captured request URL, in call order. */
export const requestUrls = (http: FetchMockHarness): URL[] =>
  http.calls.map((call) => new URL(call.request.url));

/** A tool result as `runToolContract` returns it — both public surfaces. */
export interface ToolResultLike {
  content?: ReadonlyArray<{ text?: string; type: string }> | undefined;
  isError?: boolean | undefined;
  structuredContent?: unknown;
}

/** `structuredContent`, typed for assertions; throws when the result has none. */
export function structured<T = Record<string, unknown>>(result: ToolResultLike): T {
  if (!result.structuredContent) throw new Error('Result has no structuredContent.');
  return result.structuredContent as T;
}

/** Every text block of `content[]`, joined — what a content-only client reads. */
export const contentText = (result: ToolResultLike): string =>
  (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');

/** The `structuredContent.error` envelope of a failed tool call. */
export function toolError(result: ToolResultLike): {
  code: number;
  data?: Record<string, unknown> & { reason?: string };
  message: string;
} {
  if (!result.isError) throw new Error('Expected an error result.');
  return structured<{ error: ReturnType<typeof toolError> }>(result).error;
}

/**
 * The log level each declared reason's failure record is written at, keyed by
 * reason — `error` where the contract declares no `severity`. The wire response
 * is the same at every level, so a contract test pins the declaration itself.
 */
export const declaredSeverities = (errors: readonly ErrorContract[] = []): Record<string, string> =>
  Object.fromEntries(errors.map((entry) => [entry.reason, entry.severity ?? 'error']));
