/**
 * @fileoverview DataCite REST client: `/dois` search and lookups, `/events`,
 * `/repositories`, and content negotiation at `/dois/{mime}/{doi}`, all through
 * one paced, cached, retried HTTP boundary on `api.datacite.org`. Every `/dois`
 * call sends `affiliation=true&publisher=true` so the parsed shape never changes.
 * @module services/datacite/datacite-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import {
  internalError,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  initRegistrationAgencyService,
  shutdownRegistrationAgencyService,
} from '@/services/doi-ra/doi-ra-service.js';
import { TtlCache } from '@/services/http/ttl-cache.js';
import {
  type CachedResponse,
  type CooldownPolicy,
  isUnanswered,
  UpstreamClient,
  type UpstreamRequest,
  upstreamErrorBody,
  userAgent,
} from '@/services/http/upstream-client.js';
import { recordDoi } from './mappers.js';
import { anyPhrase, doiQuery } from './query-builder.js';
import type {
  RawClientResource,
  RawDoiList,
  RawDoiResource,
  RawEventList,
  RawRepositoryList,
} from './types.js';

const BASE_URL = 'https://api.datacite.org';
const MINUTE = 60_000;
const COOLDOWN: CooldownPolicy = { baseMs: 30_000, maxMs: 300_000 };

/** `fields[dois]` for a search row. */
const SEARCH_FIELDS =
  'doi,titles,creators,publicationYear,types,publisher,version,rightsList,descriptions,url,citationCount,viewCount,downloadCount,versionCount,created,client';
/** `fields[dois]` for a relation-graph node. */
export const NODE_FIELDS = 'doi,titles,types,publicationYear,citationCount,versionCount,client';
/** Node fields plus the record's own relation assertions. */
export const NODE_WITH_RELATIONS_FIELDS = `${NODE_FIELDS},relatedIdentifiers,relatedItems`;
/** Node fields plus the related identifiers a reverse match is verified against. */
export const REVERSE_FIELDS = `${NODE_FIELDS},relatedIdentifiers`;
/** Node fields plus the root's own assertions and DataCite counts. */
export const ROOT_FIELDS = `${NODE_WITH_RELATIONS_FIELDS},referenceCount,versionOfCount,partCount,partOfCount`;

/**
 * DOIs per `ids=` request. The upstream's time for one grows with the size of the
 * records it builds, whatever `fields[dois]` leaves out: 10 cold GBIF downloads
 * answered in 3.5 s, while three of four concurrent batches of 25 larger ones got no
 * answer inside the 20 s attempt timeout. At 10, a batch of large records stays well
 * inside one attempt, and one that fails leaves 10 nodes unhydrated rather than 25.
 */
const HYDRATE_BATCH = 10;

/**
 * `ids=` requests one hydration keeps in flight. Concurrent batches of large records
 * answered no faster than one, and the ones abandoned kept the upstream busy for the
 * next call; two still halves the time for small records.
 */
const HYDRATE_CONCURRENCY = 2;

/** What {@link DataCiteService.hydrate} returned. */
export interface Hydration {
  /** Records keyed by lowercase DOI; a DOI DataCite does not hold has none. */
  records: Map<string, RawDoiResource>;
  /** DOIs whose request did not answer before the deadline; always empty without one. */
  unanswered: Set<string>;
}

/** Filters `/dois` takes as named parameters. */
export interface WorkSearchFilters {
  affiliationCountry?: string;
  affiliationId?: string;
  clientIds?: string[];
  fundedBy?: string;
  includeFunderChildOrganizations?: boolean;
  licenses?: string[];
  minCitations?: number;
  providerIds?: string[];
  resourceTypeIds?: string[];
}

/** A typed `/dois` search. Only these fields ever become query parameters. */
export interface WorkSearchRequest {
  /** Whether the caller wrote query syntax; decides what a parse error means. */
  callerQuery: boolean;
  facets: boolean;
  filters: WorkSearchFilters;
  page: { cursor: string } | { number: number };
  query: string;
  size: number;
  /** Upstream sort value, always sent — a cursor walk runs in `created` order whatever it says. */
  sort: string;
}

/** A typed `/repositories` request. */
export interface RepositorySearchRequest {
  callerQuery: boolean;
  certificates?: string[];
  clientType?: string;
  ids?: string[];
  page: number;
  providerId?: string;
  query?: string;
  repositoryTypes?: string[];
  size: number;
  software?: string;
}

/** A typed `/events` request. */
export interface EventRequest {
  doi?: string;
  relationTypeIds: string[];
  subjId?: string;
}

/**
 * Content-negotiation outcome: a body, or the status the path answered. DataCite
 * answers a format it cannot render for a record with 204, a 200 with an empty
 * body, or 400, and an unknown DOI with 404.
 */
export interface NegotiationResult {
  body: string;
  status: 200 | 204 | 400 | 404;
}

/** Construction options for {@link DataCiteService}. Every network boundary is injectable. */
export interface DataCiteServiceOptions {
  /** Requests per 5-minute window for the default pacer. Default 800 with a contact email, 400 without. */
  budget?: number;
  /** Response cache, shared with the registration-agency service in production. */
  cache?: TtlCache<CachedResponse>;
  contactEmail?: string;
  fetch: typeof globalThis.fetch;
  pacer?: Pacer;
  /** Style-verdict cache (24 h), separate from the response cache. */
  styleVerdicts?: TtlCache<StyleVerdict>;
  /** Server version for the User-Agent. Default: the framework-resolved package version. */
  version?: string;
}

/** What the style check concluded about one CSL style id. */
export type StyleVerdict = 'supported' | 'unsupported' | 'apa_variant_unconfirmed';

function buildUrl(path: string, params: Array<[string, string | number | undefined]>): string {
  const search = new URLSearchParams();
  for (const [key, value] of params) {
    if (value !== undefined && value !== '') search.append(key, String(value));
  }
  const query = search.toString();
  return `${BASE_URL}${path}${query ? `?${query}` : ''}`;
}

const joined = (values?: readonly string[]): string | undefined =>
  values?.length ? values.join(',') : undefined;

/** A `/dois` page of the records matching a composed query, newest first. */
const queryUrl = (query: string, fields: string, size: number): string =>
  buildUrl('/dois', [
    ['query', query],
    ['sort', '-created'],
    ['page[size]', size],
    ['fields[dois]', fields],
    ['affiliation', 'true'],
    ['publisher', 'true'],
  ]);

/**
 * Whether an upstream 400 is a query-string parse failure: a `parse_exception`,
 * a `token_mgr_error` lexical error (an unterminated quote or regex), or a
 * `failed to parse` value. Reads the body the HTTP boundary kept server-side.
 */
function isQueryParseError(error: unknown): error is McpError {
  if (!(error instanceof McpError) || error.data?.status !== 400) return false;
  const body = upstreamErrorBody(error) ?? '';
  return (
    body.includes('parse_exception') ||
    body.includes('token_mgr_error') ||
    body.includes('failed to parse')
  );
}

/** Whether an upstream error is an HTTP 5xx, classified `ServiceUnavailable`. */
function isUpstream5xx(error: unknown): error is McpError {
  return (
    error instanceof McpError &&
    error.code === JsonRpcErrorCode.ServiceUnavailable &&
    Number(error.data?.status) >= 500
  );
}

/** DataCite REST client. */
export class DataCiteService {
  readonly styleVerdicts: TtlCache<StyleVerdict>;
  private readonly client: UpstreamClient;
  private readonly pacer: Pacer;

  constructor(options: DataCiteServiceOptions) {
    const budget = options.budget ?? (options.contactEmail ? 800 : 400);
    this.pacer =
      options.pacer ??
      createPacer({
        name: 'datacite',
        limits: [{ requests: budget, perMs: 5 * MINUTE }],
        minStartGapMs: 100,
        maxConcurrent: 6,
        cooldown: COOLDOWN,
      });
    this.styleVerdicts = options.styleVerdicts ?? new TtlCache<StyleVerdict>();
    this.client = new UpstreamClient({
      service: 'DataCite',
      fetch: options.fetch,
      cache: options.cache ?? new TtlCache<CachedResponse>(),
      pacer: this.pacer,
      cooldown: COOLDOWN,
      userAgent: userAgent(options.version ?? config.mcpServerVersion, options.contactEmail),
    });
  }

  /** Releases the pacer's timer and rejects queued waiters. */
  dispose(): void {
    this.pacer.dispose();
  }

  /** One page of a `/dois` search, with the included client objects. */
  searchWorks(request: WorkSearchRequest, ctx: Context): Promise<RawDoiList> {
    const { filters } = request;
    const url = buildUrl('/dois', [
      ['query', request.query],
      ['resource-type-id', joined(filters.resourceTypeIds)],
      ['client-id', joined(filters.clientIds)],
      ['provider-id', joined(filters.providerIds)],
      ['affiliation-id', filters.affiliationId],
      ['affiliation-country', filters.affiliationCountry],
      ['funded-by', filters.fundedBy],
      [
        'include-funder-child-organizations',
        filters.includeFunderChildOrganizations ? 'true' : undefined,
      ],
      ['license', joined(filters.licenses)],
      ['has-citations', filters.minCitations],
      ['sort', request.sort],
      ['page[size]', request.size],
      'cursor' in request.page
        ? ['page[cursor]', request.page.cursor]
        : ['page[number]', request.page.number],
      ['disable-facets', request.facets ? 'false' : undefined],
      ['fields[dois]', SEARCH_FIELDS],
      ['include', 'client'],
      ['affiliation', 'true'],
      ['publisher', 'true'],
    ]);
    return this.search<RawDoiList>(url, 'searchWorks', 5 * MINUTE, request.callerQuery, ctx);
  }

  /** The full public record for one DOI and its repository, or `undefined` when DataCite holds none. */
  async getWork(
    doi: string,
    ctx: Context,
  ): Promise<{ client?: RawClientResource; record: RawDoiResource } | undefined> {
    const url = buildUrl('/dois', [
      ['query', doiQuery(doi)],
      ['sort', '-created'],
      ['include', 'client'],
      ['affiliation', 'true'],
      ['publisher', 'true'],
      ['page[size]', 1],
    ]);
    const list = await this.getJson<RawDoiList>(url, 'getWork', 15 * MINUTE, ctx);
    const record = list.data.find((item) => item.attributes.doi?.toLowerCase() === doi);
    if (!record) return;
    const clientId = record.relationships?.client?.data?.id;
    const client = list.included?.find((item) => item.id === clientId);
    return { record, ...(client && { client }) };
  }

  /** One DOI's record with the given `fields[dois]`, or `undefined` when DataCite holds none. */
  async getRecord(doi: string, fields: string, ctx: Context): Promise<RawDoiResource | undefined> {
    const url = buildUrl('/dois', [
      ['query', doiQuery(doi)],
      ['sort', '-created'],
      ['fields[dois]', fields],
      ['affiliation', 'true'],
      ['publisher', 'true'],
      ['page[size]', 1],
    ]);
    const list = await this.getJson<RawDoiList>(url, 'getRecord', 15 * MINUTE, ctx);
    return list.data.find((item) => item.attributes.doi?.toLowerCase() === doi);
  }

  /** Records matching a composed query, newest first — the reverse-relation lookup. */
  queryRecords(query: string, fields: string, size: number, ctx: Context): Promise<RawDoiList> {
    return this.getJson<RawDoiList>(
      queryUrl(query, fields, size),
      'queryRecords',
      15 * MINUTE,
      ctx,
    );
  }

  /**
   * Records for a set of DOIs, in `ids=` batches of {@link HYDRATE_BATCH}, at most
   * {@link HYDRATE_CONCURRENCY} in flight. `ids=` silently drops DOIs it does not
   * hold, so the result is keyed rather than positional. A DOI containing a comma
   * would split the `ids` list, so those go through one `doi:("…")` query instead.
   *
   * Without `deadline`, every request is retried and any failure throws. With it
   * (epoch ms), each request gets one attempt: past the deadline no further batch
   * is sent and those in flight are cancelled, and the DOIs of a batch that did not
   * answer — cancelled, timed out, or failed as an outage — come back in
   * `unanswered`. A spent request budget, a cancelled call, and any other failure
   * still throw.
   */
  async hydrate(
    dois: readonly string[],
    fields: string,
    ctx: Context,
    deadline?: number,
  ): Promise<Hydration> {
    const plain = dois.filter((doi) => !doi.includes(','));
    const withComma = dois.filter((doi) => doi.includes(','));
    const jobs: Array<{ dois: string[]; url: string }> = [];
    for (let i = 0; i < plain.length; i += HYDRATE_BATCH) {
      const batch = plain.slice(i, i + HYDRATE_BATCH);
      const url = buildUrl('/dois', [
        ['ids', batch.join(',')],
        ['sort', '-created'],
        ['fields[dois]', fields],
        ['affiliation', 'true'],
        ['publisher', 'true'],
        ['page[size]', HYDRATE_BATCH],
      ]);
      jobs.push({ dois: batch, url });
    }
    if (withComma.length > 0) {
      const url = queryUrl(anyPhrase('doi', withComma), fields, withComma.length);
      jobs.push({ dois: withComma, url });
    }

    /** Answers by job index, merged in job order so the result does not depend on timing. */
    const lists: RawDoiList[] = [];
    const unanswered = new Set<string>();
    /** Stops the workers and cancels what they have in flight: at the deadline, or on a failure. */
    const stop = new AbortController();
    const timer =
      deadline === undefined ? undefined : setTimeout(() => stop.abort(), deadline - Date.now());
    const options = deadline === undefined ? {} : { attempts: 1, signal: stop.signal };
    let next = 0;
    const worker = async () => {
      while (!stop.signal.aborted) {
        const index = next++;
        const job = jobs[index];
        if (!job) return;
        try {
          lists[index] = await this.getJson<RawDoiList>(
            job.url,
            'hydrate',
            15 * MINUTE,
            ctx,
            options,
          );
        } catch (error) {
          const skipped =
            deadline !== undefined &&
            !ctx.signal.aborted &&
            (stop.signal.aborted ||
              (isUnanswered(error) && error.code !== JsonRpcErrorCode.RateLimited));
          if (!skipped) {
            stop.abort();
            throw error;
          }
          for (const doi of job.dois) unanswered.add(doi);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, jobs.length) }, worker));
    } finally {
      clearTimeout(timer);
    }
    for (const job of jobs.slice(next)) for (const doi of job.dois) unanswered.add(doi);
    const requested = new Set(dois);
    const records = new Map<string, RawDoiResource>();
    for (const item of lists.flatMap((list) => list.data)) {
      const doi = recordDoi(item);
      if (requested.has(doi)) records.set(doi, item);
    }
    return { records, unanswered };
  }

  /** One page (≤ 100) of Event Data events. */
  getEvents(request: EventRequest, ctx: Context): Promise<RawEventList> {
    const url = buildUrl('/events', [
      ['doi', request.doi],
      ['subj-id', request.subjId],
      ['relation-type-id', request.relationTypeIds.join(',')],
      ['page[size]', 100],
    ]);
    return this.getJson<RawEventList>(url, 'getEvents', 15 * MINUTE, ctx);
  }

  /** One page of repository accounts, by search or by id batch. */
  searchRepositories(request: RepositorySearchRequest, ctx: Context): Promise<RawRepositoryList> {
    const url = buildUrl('/repositories', [
      ['ids', joined(request.ids)],
      ['query', request.query],
      ['repository-type', joined(request.repositoryTypes)],
      ['certificate', joined(request.certificates)],
      ['software', request.software],
      ['client-type', request.clientType],
      ['provider-id', request.providerId],
      ['page[size]', request.size],
      ['page[number]', request.page],
    ]);
    return this.search<RawRepositoryList>(
      url,
      'searchRepositories',
      60 * MINUTE,
      request.callerQuery,
      ctx,
    );
  }

  /**
   * Content negotiation for one DOI: `/dois/<mime>/<doi>`. The MIME stays
   * unencoded in the path (an encoded slash 404s); the DOI is encoded whole.
   * A 400 is a result: every parameter is validated before it is sent, so
   * DataCite answers 400 only when its renderer fails on the record. A 5xx still
   * failing after retries carries `render_failed`, because DataCite answers both
   * a renderer fault on one record and a brief outage with 5xx. Its data names
   * the status only; the upstream body never reaches the caller.
   */
  async negotiate(
    doi: string,
    mediaType: string,
    params: { locale?: string; style?: string },
    ctx: Context,
  ): Promise<NegotiationResult> {
    const url = buildUrl(`/dois/${mediaType}/${encodeURIComponent(doi)}`, [
      ['style', params.style],
      ['locale', params.locale],
    ]);
    try {
      return await this.client.get(
        {
          url,
          operation: 'negotiate',
          acceptStatuses: [200, 204, 400, 404],
          ttlMs: (status) => (status === 200 ? 60 * MINUTE : 5 * MINUTE),
        },
        ctx,
        (response) => ({
          status: response.status as NegotiationResult['status'],
          body: response.body,
        }),
      );
    } catch (error) {
      if (!isUpstream5xx(error)) throw error;
      const { status, statusText, retryAfter } = error.data ?? {};
      throw serviceUnavailable(
        error.message,
        {
          status,
          ...(statusText !== undefined && { statusText }),
          ...(retryAfter !== undefined && { retryAfter }),
          reason: 'render_failed',
          retryable: true,
          ...ctx.recoveryFor('render_failed'),
        },
        { cause: error },
      );
    }
  }

  /** A GET answered 200 with a JSON body. */
  private getJson<T>(
    url: string,
    operation: string,
    ttlMs: number,
    ctx: Context,
    options: Pick<UpstreamRequest, 'attempts' | 'signal'> = {},
  ): Promise<T> {
    return this.client.get(
      { url, operation, acceptStatuses: [200], ttlMs: () => ttlMs, ...options },
      ctx,
      (response) => {
        try {
          return JSON.parse(response.body) as T;
        } catch (error) {
          throw internalError(`DataCite returned unparseable JSON for ${operation}.`, undefined, {
            cause: error,
          });
        }
      },
    );
  }

  /**
   * A search GET whose 400 parse error means the caller's syntax when the caller
   * wrote query syntax, and a malformed server-composed clause otherwise.
   */
  private async search<T>(
    url: string,
    operation: string,
    ttlMs: number,
    callerQuery: boolean,
    ctx: Context,
  ): Promise<T> {
    try {
      return await this.getJson<T>(url, operation, ttlMs, ctx);
    } catch (error) {
      if (!isQueryParseError(error)) throw error;
      if (!callerQuery) {
        throw internalError(
          'DataCite could not parse a query clause this server composed; this is a server bug, not an input error.',
          undefined,
          { cause: error },
        );
      }
      const position = /line (\d+), column (\d+)/.exec(upstreamErrorBody(error) ?? '');
      throw validationError(
        `DataCite could not parse the query syntax${position ? ` (line ${position[1]}, column ${position[2]})` : ''}: check for unbalanced parentheses or quotes, a dangling operator, or an unescaped reserved character.`,
        { reason: 'invalid_query', ...ctx.recoveryFor('invalid_query') },
        { cause: error },
      );
    }
  }
}

/** Production wiring for every network boundary; each field is overridable. */
export interface DataCiteServicesInit {
  budget?: number;
  cache?: TtlCache<CachedResponse>;
  contactEmail?: string;
  fetch?: typeof globalThis.fetch;
  pacer?: Pacer;
  raPacer?: Pacer;
  version?: string;
}

let _service: DataCiteService | undefined;

/**
 * Creates the DataCite and registration-agency services over one shared
 * response cache. Defaults read the server config; tests pass a fake `fetch`.
 */
export function initDataCiteServices(options: DataCiteServicesInit = {}): void {
  shutdownDataCiteServices();
  const serverConfig = getServerConfig();
  const contactEmail = options.contactEmail ?? serverConfig.contactEmail;
  const budget = options.budget ?? serverConfig.maxRequestsPer5Min;
  const shared = {
    cache: options.cache ?? new TtlCache<CachedResponse>(),
    fetch: options.fetch ?? globalThis.fetch,
    version: options.version ?? config.mcpServerVersion,
    ...(contactEmail && { contactEmail }),
  };
  _service = new DataCiteService({
    ...shared,
    ...(budget !== undefined && { budget }),
    ...(options.pacer && { pacer: options.pacer }),
  });
  initRegistrationAgencyService({ ...shared, ...(options.raPacer && { pacer: options.raPacer }) });
}

/** The initialized DataCite service. */
export function getDataCiteService(): DataCiteService {
  if (!_service) {
    throw new Error('DataCiteService not initialized — call initDataCiteServices() in setup()');
  }
  return _service;
}

/** Disposes both services' pacers. Wired through `createApp({ teardown })`. */
export function shutdownDataCiteServices(): void {
  _service?.dispose();
  _service = undefined;
  shutdownRegistrationAgencyService();
}
