/**
 * @fileoverview Bounded exact FundRef-to-ROR identity lookup.
 * @module services/ror/ror-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';
import { normalizeRor } from '@/services/datacite/normalize.js';
import { TtlCache } from '@/services/http/ttl-cache.js';
import { type CachedResponse, UpstreamClient, userAgent } from '@/services/http/upstream-client.js';

const AnswerSchema = z.object({
  number_of_results: z.number().int().nonnegative(),
  items: z
    .array(
      z.object({
        id: z.string(),
        external_ids: z.array(z.object({ type: z.string(), all: z.array(z.string()) })),
      }),
    )
    .max(20),
});

/**
 * What the FundRef-to-ROR lookup established. `unmatched`: ROR answered, naming
 * no organization with the Crossref Funder ID, several, or an incomplete list,
 * and the answer is cached like any other. `unavailable`: ROR gave no answer to
 * read (an outage, a rate limit, a timeout, a redirect, a block page, or a body
 * that is not JSON), which is never cached, so the next lookup asks again.
 */
export type FunderResolution =
  | { status: 'resolved'; ror: string }
  | { status: 'unmatched' }
  | { status: 'unavailable' };

/** Injectable network and pacing boundaries for the ROR lookup. */
export interface RorServiceOptions {
  cache?: TtlCache<CachedResponse>;
  contactEmail?: string;
  fetch: typeof globalThis.fetch;
  pacer?: Pacer;
  version?: string;
}

/** ROR identity lookup: fuzzy search results never establish identity. */
export class RorService {
  private readonly pacer: Pacer;
  private readonly client: UpstreamClient;

  constructor(options: RorServiceOptions) {
    this.pacer =
      options.pacer ??
      createPacer({ name: 'ror', limits: [{ requests: 60, perMs: 60_000 }], maxConcurrent: 2 });
    this.client = new UpstreamClient({
      service: 'ROR',
      fetch: options.fetch,
      pacer: this.pacer,
      cache: options.cache ?? new TtlCache<CachedResponse>(),
      cooldown: { baseMs: 30_000, maxMs: 300_000 },
      userAgent: userAgent(options.version ?? config.mcpServerVersion, options.contactEmail),
    });
  }

  /** Releases the lookup pacer. */
  dispose(): void {
    this.pacer.dispose();
  }

  /**
   * One attempt, including queue time, within five seconds and the shared call
   * deadline. Caller cancellation is rethrown; every other failure is `unavailable`.
   */
  async resolveFunder(funderId: string, ctx: Context): Promise<FunderResolution> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const resolved = await this.client.get(
        {
          url: `https://api.ror.org/v2/organizations?query=${encodeURIComponent(funderId.slice('10.13039/'.length))}`,
          operation: 'resolveFunder',
          attempts: 1,
          signal: controller.signal,
          acceptStatuses: [200],
          ttlMs: () => 24 * 60 * 60_000,
        },
        ctx,
        (response) => {
          const parsed = AnswerSchema.safeParse(JSON.parse(response.body));
          if (!parsed.success || parsed.data.number_of_results !== parsed.data.items.length) return;
          const matches: string[] = [];
          for (const item of parsed.data.items) {
            const ror = normalizeRor(item.id);
            if (!ror || item.id !== `https://ror.org/${ror}`) return;
            if (
              item.external_ids.some(
                (id) =>
                  id.type === 'fundref' && id.all.includes(funderId.slice('10.13039/'.length)),
              )
            )
              matches.push(ror);
          }
          return matches.length === 1 ? matches[0] : undefined;
        },
      );
      return resolved ? { status: 'resolved', ror: resolved } : { status: 'unmatched' };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.log.warning('ROR funder lookup got no answer', {
        ...(error instanceof McpError && { code: error.code }),
      });
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }
}

let service: RorService | undefined;

/** Initializes ROR over the shared HTTP cache. */
export function initRorService(options: RorServiceOptions): void {
  service = new RorService(options);
}
/** Returns the initialized ROR lookup. */
export function getRorService(): RorService {
  if (!service)
    throw new Error('RorService not initialized — call initDataCiteServices() in setup()');
  return service;
}
/** Disposes the ROR pacer. */
export function shutdownRorService(): void {
  service?.dispose();
  service = undefined;
}
