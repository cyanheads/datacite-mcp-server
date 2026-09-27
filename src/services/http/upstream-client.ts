/**
 * @fileoverview The one HTTP boundary every upstream call goes through: shared
 * cache → pacer → plain `fetch` with a per-call status accept-list, wrapped in
 * `withRetry` under the tool call's total deadline. Owns the 429 and pacer-shed
 * rules that turn a spent request budget into a `RateLimited` error stating its
 * wait.
 * @module services/http/upstream-client
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  httpErrorFromResponse,
  type Pacer,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type { TtlCache } from './ttl-cache.js';

/** Total budget for every upstream request one tool call makes (inside a 60 s client timeout). */
export const CALL_DEADLINE_MS = 45_000;
/** Ceiling on a single attempt. */
export const ATTEMPT_TIMEOUT_MS = 20_000;
/**
 * The most of one response body this server reads. Past it the rest is cancelled
 * unread and the request fails. About twice the largest real answer measured: a
 * 15.6 MB reverse-relation page, whose largest record alone is 5.9 MB.
 */
const MAX_BODY_BYTES = 32_000_000;
/** Responses larger than this are served but never cached. */
const MAX_CACHED_BYTES = 1_000_000;
/** How much of a rejected response's body is kept for {@link upstreamErrorBody}. */
const ERROR_BODY_BYTES = 2048;
const HTML_BODY_RE = /^\s*<(?:!DOCTYPE\s+html|html[\s>])/i;

/** A settled upstream answer as the cache holds it. */
export interface CachedResponse {
  body: string;
  /** The body's size as received, in bytes (UTF-8); what it counts against the cache's byte budget. */
  bytes: number;
  status: number;
}

/** One GET issued through {@link UpstreamClient.get}. */
export interface UpstreamRequest {
  /** Statuses that are results rather than errors (e.g. `[200]`, or `[200, 204, 404]` for negotiation). */
  acceptStatuses: readonly number[];
  /** Attempts before a transient failure surfaces. Default 3; 1 for a best-effort read. */
  attempts?: number;
  /** Log label. */
  operation: string;
  /** Cancels this request alone, queued or in flight, beside the call's own signal. */
  signal?: AbortSignal;
  /** Cache lifetime for an accepted response with this status. */
  ttlMs: (status: number) => number;
  /** Absolute request URL. Never carries the contact email. */
  url: string;
}

/** The cooldown the pacer applies to consecutive 429s, mirrored into the reported wait. */
export interface CooldownPolicy {
  baseMs: number;
  maxMs: number;
}

/** Construction options for {@link UpstreamClient}. */
export interface UpstreamClientOptions {
  cache: TtlCache<CachedResponse>;
  cooldown: CooldownPolicy;
  fetch: typeof globalThis.fetch;
  pacer: Pacer;
  /** Display name used in messages, e.g. `DataCite`. */
  service: string;
  userAgent: string;
}

/**
 * Upstream 429s this module raised, mapped to whether the response carried a
 * `Retry-After`. Only a hinted 429 is retried in-call: the limit is a 5-minute
 * per-IP window a seconds-scale backoff cannot outlast.
 */
const upstream429s = new WeakMap<object, boolean>();

const isTransient = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && upstream429s.has(error)
    ? upstream429s.get(error) === true
    : defaultIsTransient(error);

/**
 * The body prefix of each rejected response, keyed by the error it raised. It
 * lives here rather than in `error.data`, which reaches the caller as
 * `structuredContent.error.data`.
 */
const errorBodies = new WeakMap<object, string>();

/**
 * The first 2 KB of the response body behind an HTTP error this module raised,
 * for server-side classification only (a search's query parse error), never for
 * a message or error data.
 */
export const upstreamErrorBody = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? errorBodies.get(error) : undefined;

/**
 * A response body read up to `maxBytes`, plus at most the one chunk that crosses
 * it. Past `maxBytes` the rest of the stream is cancelled unread and `complete`
 * is false.
 */
async function readUpTo(
  response: Response,
  maxBytes: number,
): Promise<{ blob: Blob; complete: boolean }> {
  if (!response.body) return { blob: new Blob(), complete: true };
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let read = 0;
  while (read <= maxBytes) {
    const { done, value } = await reader.read();
    if (done) return { blob: new Blob(chunks), complete: true };
    chunks.push(value);
    read += value.byteLength;
  }
  await reader.cancel();
  return { blob: new Blob(chunks), complete: false };
}

const UNANSWERED_CODES = new Set([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.RateLimited,
]);

/** Whether a failed request means the upstream did not answer: an outage, a timeout, or a spent budget. */
export const isUnanswered = (error: unknown): error is McpError =>
  error instanceof McpError && UNANSWERED_CODES.has(error.code);

/**
 * The identifying User-Agent. The contact email rides here only — never a URL
 * parameter — so it never enters a request URL, cache key, or log line.
 */
export const userAgent = (version: string, contactEmail?: string): string =>
  `datacite-mcp-server/${version} (+https://github.com/cyanheads/datacite-mcp-server${contactEmail ? `; mailto:${contactEmail}` : ''})`;

/** Parses a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfterHeader(value: string | null): number | undefined {
  if (value === null) return;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Epoch instant the tool call started: the request context's creation. */
export function callStartedAt(ctx: Context): number {
  const startedAt = Date.parse(ctx.timestamp);
  return Number.isNaN(startedAt) ? Date.now() : startedAt;
}

/** Epoch instant this call's shared deadline expires. */
const deadlineFor = (ctx: Context): number => callStartedAt(ctx) + CALL_DEADLINE_MS;

/** Cache → pacer → fetch pipeline for one upstream host. */
export class UpstreamClient {
  private consecutive429s = 0;

  constructor(private readonly options: UpstreamClientOptions) {}

  /**
   * GETs `request.url` and parses the accepted response. A cached answer returns
   * without queueing or spending budget. Retry covers pacer + fetch + parse.
   *
   * @throws {McpError} `RateLimited` with `data.reason: 'rate_limited'` when the
   *   budget is spent (pacer shed or upstream 429), `ServiceUnavailable` with
   *   `retryable: false` for a redirect or a body past 32 MB, the classified
   *   HTTP error — status only, never the body — for any other status outside
   *   the accept-list, `ServiceUnavailable` for an HTML body, and `Timeout` when
   *   the call's deadline runs out.
   */
  async get<T>(
    request: UpstreamRequest,
    ctx: Context,
    parse: (response: CachedResponse) => T,
  ): Promise<T> {
    const { cache, service } = this.options;
    const cached = cache.get(request.url);
    if (cached) {
      ctx.log.debug(`${service} cache hit`, { operation: request.operation });
      return parse(cached);
    }

    const remainingMs = deadlineFor(ctx) - Date.now();
    if (remainingMs <= 0) {
      throw timeout(`The ${CALL_DEADLINE_MS / 1000} s budget for ${service} requests ran out.`);
    }

    try {
      return await withRetry(
        async (attempt) => {
          const response = await this.options.pacer.run(
            (signal) =>
              this.fetchOnce(
                request,
                signal,
                Math.min(ATTEMPT_TIMEOUT_MS, attempt.remainingMs),
                ctx,
              ),
            { signal: attempt.signal, maxWaitMs: attempt.remainingMs },
          );
          const parsed = parse(response);
          if (response.bytes <= MAX_CACHED_BYTES) {
            cache.set(request.url, response, request.ttlMs(response.status), response.bytes);
          }
          ctx.log.debug(`${service} request`, {
            operation: request.operation,
            status: response.status,
          });
          return parsed;
        },
        {
          operation: request.operation,
          context: ctx,
          signal: request.signal ? AbortSignal.any([ctx.signal, request.signal]) : ctx.signal,
          deadlineMs: remainingMs,
          maxRetries: (request.attempts ?? 3) - 1,
          baseDelayMs: 1000,
          isTransient,
        },
      );
    } catch (error) {
      if (error instanceof McpError && error.data?.reason === 'pacer_shed') {
        const retryAfter = Math.max(1, Number(error.data.retryAfter) || 1);
        throw rateLimited(
          `This deployment's shared ${service} request budget is spent for the current window; retry in ${retryAfter} seconds.`,
          {
            reason: 'rate_limited',
            retryAfter,
            retryable: true,
            ...ctx.recoveryFor('rate_limited'),
          },
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * One paced attempt: fetch, status check against the accept-list, and a body
   * read bounded at {@link MAX_BODY_BYTES}. A redirect is never followed — every endpoint this server calls answers
   * directly, and following one would send the User-Agent (with the contact
   * email) to whatever host `Location` names.
   */
  private async fetchOnce(
    request: UpstreamRequest,
    signal: AbortSignal,
    timeoutMs: number,
    ctx: Context,
  ): Promise<CachedResponse> {
    const { service } = this.options;
    const timer = new AbortController();
    const handle = setTimeout(() => timer.abort(), timeoutMs);
    try {
      const response = await this.options.fetch(request.url, {
        headers: { 'User-Agent': this.options.userAgent },
        redirect: 'manual',
        signal: AbortSignal.any([signal, timer.signal]),
      });
      if (response.status === 429) {
        await response.body?.cancel();
        throw this.rateLimitError(response, ctx);
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw serviceUnavailable(
          `${service} answered with a redirect (HTTP ${response.status}), which this server does not follow.`,
          { status: response.status, retryable: false },
        );
      }
      if (!request.acceptStatuses.includes(response.status)) {
        const { blob } = await readUpTo(response, ERROR_BODY_BYTES);
        const error = await httpErrorFromResponse(response, { service, captureBody: false });
        errorBodies.set(error, await blob.slice(0, ERROR_BODY_BYTES).text());
        throw error;
      }
      const { blob, complete } = await readUpTo(response, MAX_BODY_BYTES);
      if (!complete) {
        throw serviceUnavailable(
          `${service} answered with more than ${MAX_BODY_BYTES / 1_000_000} MB, the most this server reads from one response, so the answer was not read; the record or page is too large to return, and a retry gets the same answer.`,
          { maxBytes: MAX_BODY_BYTES, retryable: false },
        );
      }
      const body = await blob.text();
      this.consecutive429s = 0;
      if (response.status === 200 && HTML_BODY_RE.test(body)) {
        throw serviceUnavailable(
          `${service} answered with an HTML page instead of data; the service is likely degraded.`,
        );
      }
      return { status: response.status, body, bytes: blob.size };
    } catch (error) {
      if (signal.aborted) throw error;
      if (timer.signal.aborted) {
        throw timeout(
          `${service} did not answer within ${Math.round(timeoutMs / 1000)} s.`,
          { timeoutMs },
          { cause: error },
        );
      }
      if (error instanceof McpError) throw error;
      throw serviceUnavailable(
        `The ${service} request failed before a response arrived.`,
        undefined,
        {
          cause: error,
        },
      );
    } finally {
      clearTimeout(handle);
    }
  }

  /**
   * The error for an upstream 429. Its `retryAfter` is the gate this 429 arms —
   * `min(max(base · 2^(n−1), Retry-After), max)` for the n-th consecutive 429 —
   * so the wait is defined whether or not the upstream sends the header.
   */
  private rateLimitError(response: Response, ctx: Context): McpError {
    const { cooldown, service } = this.options;
    this.consecutive429s += 1;
    const hintMs = parseRetryAfterHeader(response.headers.get('retry-after'));
    const gateMs = Math.min(
      Math.max(cooldown.baseMs * 2 ** (this.consecutive429s - 1), hintMs ?? 0),
      cooldown.maxMs,
    );
    const retryAfter = Math.ceil(gateMs / 1000);
    const error = rateLimited(
      `${service} rate limit reached (HTTP 429); this deployment's shared request budget is spent for the current window — retry in ${retryAfter} seconds.`,
      { reason: 'rate_limited', retryAfter, retryable: true, ...ctx.recoveryFor('rate_limited') },
    );
    upstream429s.set(error, hintMs !== undefined);
    return error;
  }
}
