/**
 * @fileoverview DataCite REST client: `/dois` search and lookups, `/events`,
 * `/repositories`, and content negotiation at `/dois/{mime}/{doi}`, all through
 * one paced, cached, retried HTTP boundary on `api.datacite.org`. Every `/dois`
 * call sends `affiliation=true&publisher=true` so the parsed shape never changes.
 * @module services/datacite/datacite-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { internalError, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
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
  UpstreamClient,
  userAgent,
} from '@/services/http/upstream-client.js';
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

/** Content-negotiation outcome: a body, or the 204 / 404 the path answered. */
export interface NegotiationResult {
  body: string;
  status: 200 | 204 | 404;
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

const parseJson =
  <T>(operation: string) =>
  (response: CachedResponse): T => {
    try {
      return JSON.parse(response.body) as T;
    } catch (error) {
      throw internalError(`DataCite returned unparseable JSON for ${operation}.`, undefined, {
        cause: error,
      });
    }
  };

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

/** Whether an upstream 400 is a query-string parse failure. */
function isQueryParseError(error: unknown): error is McpError {
  if (!(error instanceof McpError) || error.data?.status !== 400) return false;
  const body = String(error.data.body ?? '');
  return body.includes('parse_exception') || body.includes('failed to parse');
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
    const list = await this.client.get(
      { url, operation: 'getWork', acceptStatuses: [200], ttlMs: () => 15 * MINUTE },
      ctx,
      parseJson<RawDoiList>('getWork'),
    );
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
    const list = await this.client.get(
      { url, operation: 'getRecord', acceptStatuses: [200], ttlMs: () => 15 * MINUTE },
      ctx,
      parseJson<RawDoiList>('getRecord'),
    );
    return list.data.find((item) => item.attributes.doi?.toLowerCase() === doi);
  }

  /** Records matching a composed query, newest first — the reverse-relation lookup. */
  queryRecords(query: string, fields: string, size: number, ctx: Context): Promise<RawDoiList> {
    const url = buildUrl('/dois', [
      ['query', query],
      ['sort', '-created'],
      ['page[size]', size],
      ['fields[dois]', fields],
      ['affiliation', 'true'],
      ['publisher', 'true'],
    ]);
    return this.client.get(
      { url, operation: 'queryRecords', acceptStatuses: [200], ttlMs: () => 15 * MINUTE },
      ctx,
      parseJson<RawDoiList>('queryRecords'),
    );
  }

  /**
   * Records for a batch of DOIs, keyed by lowercase DOI. `ids=` takes up to 100 per
   * call and silently drops DOIs it does not hold, so the result is keyed rather
   * than positional. A DOI containing a comma would split the `ids` list, so those
   * go through a `doi:("…")` query instead.
   */
  async hydrate(
    dois: readonly string[],
    fields: string,
    ctx: Context,
  ): Promise<Map<string, RawDoiResource>> {
    const plain = dois.filter((doi) => !doi.includes(','));
    const withComma = dois.filter((doi) => doi.includes(','));
    const requests: Promise<RawDoiList>[] = [];
    for (let i = 0; i < plain.length; i += 100) {
      const batch = plain.slice(i, i + 100);
      const url = buildUrl('/dois', [
        ['ids', batch.join(',')],
        ['sort', '-created'],
        ['fields[dois]', fields],
        ['affiliation', 'true'],
        ['publisher', 'true'],
        ['page[size]', 100],
      ]);
      requests.push(
        this.client.get(
          { url, operation: 'hydrate', acceptStatuses: [200], ttlMs: () => 15 * MINUTE },
          ctx,
          parseJson<RawDoiList>('hydrate'),
        ),
      );
    }
    if (withComma.length > 0) {
      requests.push(this.queryRecords(anyPhrase('doi', withComma), fields, withComma.length, ctx));
    }
    const requested = new Set(dois);
    const records = new Map<string, RawDoiResource>();
    for (const list of await Promise.all(requests)) {
      for (const item of list.data) {
        const doi = (item.attributes.doi ?? item.id).toLowerCase();
        if (requested.has(doi)) records.set(doi, item);
      }
    }
    return records;
  }

  /** One page (≤ 100) of Event Data events. */
  getEvents(request: EventRequest, ctx: Context): Promise<RawEventList> {
    const url = buildUrl('/events', [
      ['doi', request.doi],
      ['subj-id', request.subjId],
      ['relation-type-id', request.relationTypeIds.join(',')],
      ['page[size]', 100],
    ]);
    return this.client.get(
      { url, operation: 'getEvents', acceptStatuses: [200], ttlMs: () => 15 * MINUTE },
      ctx,
      parseJson<RawEventList>('getEvents'),
    );
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
   */
  negotiate(
    doi: string,
    mediaType: string,
    params: { locale?: string; style?: string },
    ctx: Context,
  ): Promise<NegotiationResult> {
    const url = buildUrl(`/dois/${mediaType}/${encodeURIComponent(doi)}`, [
      ['style', params.style],
      ['locale', params.locale],
    ]);
    return this.client.get(
      {
        url,
        operation: 'negotiate',
        acceptStatuses: [200, 204, 404],
        ttlMs: (status) => (status === 200 ? 60 * MINUTE : 5 * MINUTE),
      },
      ctx,
      (response) => ({
        status: response.status as NegotiationResult['status'],
        body: response.body,
      }),
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
      return await this.client.get(
        { url, operation, acceptStatuses: [200], ttlMs: () => ttlMs },
        ctx,
        parseJson<T>(operation),
      );
    } catch (error) {
      if (!isQueryParseError(error)) throw error;
      if (!callerQuery) {
        throw internalError(
          'DataCite could not parse a query clause this server composed; this is a server bug, not an input error.',
          undefined,
          { cause: error },
        );
      }
      const position = /line (\d+), column (\d+)/.exec(String(error.data?.body ?? ''));
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
