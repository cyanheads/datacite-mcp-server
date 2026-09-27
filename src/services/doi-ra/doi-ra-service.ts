/**
 * @fileoverview Registration-agency lookup at `doi.org/ra/{doi}` — called only to
 * classify a DOI DataCite holds no public record for: another agency's DOI, a
 * DOI that does not exist, or a DataCite DOI without Findable metadata.
 * @module services/doi-ra/doi-ra-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { internalError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';
import { TtlCache } from '@/services/http/ttl-cache.js';
import {
  type CachedResponse,
  isUnanswered,
  UpstreamClient,
  userAgent,
} from '@/services/http/upstream-client.js';

/** Why DataCite holds no public record for a DOI. */
export type MissReason = 'other_agency' | 'does_not_exist' | 'not_public' | 'unclassified';

/** A classified miss: the reason and, when known, the agency that registered the DOI. */
export interface MissClassification {
  missReason: MissReason;
  registrationAgency?: string;
}

/** Construction options for {@link RegistrationAgencyService}. */
export interface RegistrationAgencyServiceOptions {
  /** Response cache, shared with the DataCite service in production. */
  cache?: TtlCache<CachedResponse>;
  contactEmail?: string;
  fetch: typeof globalThis.fetch;
  pacer?: Pacer;
  /** Server version for the User-Agent. Default: the framework-resolved package version. */
  version?: string;
}

type RaAnswer = Array<{ DOI?: string; RA?: string; status?: string }>;

/** doi.org registration-agency client. */
export class RegistrationAgencyService {
  private readonly client: UpstreamClient;
  private readonly pacer: Pacer;

  constructor(options: RegistrationAgencyServiceOptions) {
    this.pacer =
      options.pacer ??
      createPacer({ name: 'doi-ra', limits: [{ requests: 60, perMs: 60_000 }], maxConcurrent: 2 });
    this.client = new UpstreamClient({
      service: 'doi.org',
      fetch: options.fetch,
      cache: options.cache ?? new TtlCache<CachedResponse>(),
      pacer: this.pacer,
      cooldown: { baseMs: 30_000, maxMs: 300_000 },
      userAgent: userAgent(options.version ?? config.mcpServerVersion, options.contactEmail),
    });
  }

  dispose(): void {
    this.pacer.dispose();
  }

  /**
   * Classifies a DOI DataCite does not hold. A lookup that does not answer
   * (outage, timeout, rate limit) degrades to `unclassified`; a cancelled
   * request and any other failure still throw.
   */
  async classifyMiss(doi: string, ctx: Context): Promise<MissClassification> {
    let answer: RaAnswer;
    try {
      answer = await this.client.get(
        {
          url: `https://doi.org/ra/${encodeURIComponent(doi)}`,
          operation: 'registrationAgency',
          acceptStatuses: [200],
          ttlMs: () => 24 * 60 * 60_000,
        },
        ctx,
        (response) => {
          try {
            return JSON.parse(response.body) as RaAnswer;
          } catch (error) {
            throw internalError(
              'doi.org returned an unparseable registration-agency answer.',
              undefined,
              {
                cause: error,
              },
            );
          }
        },
      );
    } catch (error) {
      if (ctx.signal.aborted || !isUnanswered(error)) throw error;
      ctx.log.warning('Registration-agency lookup did not answer', { code: error.code });
      return { missReason: 'unclassified' };
    }

    const entry = answer[0];
    if (entry?.RA) {
      return entry.RA === 'DataCite'
        ? { missReason: 'not_public', registrationAgency: 'DataCite' }
        : { missReason: 'other_agency', registrationAgency: entry.RA };
    }
    if (entry?.status) return { missReason: 'does_not_exist' };
    return { missReason: 'unclassified' };
  }
}

let _service: RegistrationAgencyService | undefined;

/** Creates the registration-agency service. Called by `initDataCiteServices`. */
export function initRegistrationAgencyService(options: RegistrationAgencyServiceOptions): void {
  _service = new RegistrationAgencyService(options);
}

/** The initialized registration-agency service. */
export function getRegistrationAgencyService(): RegistrationAgencyService {
  if (!_service) {
    throw new Error(
      'RegistrationAgencyService not initialized — call initDataCiteServices() in setup()',
    );
  }
  return _service;
}

/** Disposes the service's pacer. */
export function shutdownRegistrationAgencyService(): void {
  _service?.dispose();
  _service = undefined;
}
