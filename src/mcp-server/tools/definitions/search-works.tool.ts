/**
 * @fileoverview `datacite_search_works` — search DataCite DOI metadata by text or
 * query syntax plus structured filters, in ranked pages (first 10,000 matches)
 * or a registration-ordered cursor walk over the whole result set, with
 * optional facet counts.
 * @module mcp-server/tools/definitions/search-works
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor, upstreamCursorToken } from '@/services/datacite/cursor.js';
import {
  getDataCiteService,
  type WorkSearchFilters,
} from '@/services/datacite/datacite-service.js';
import { mapWorkRow } from '@/services/datacite/mappers.js';
import {
  looksLikeFunderId,
  looksLikeOrcid,
  looksLikeRor,
  normalizeFunderId,
  normalizeLanguage,
  normalizeOrcid,
  normalizeRor,
} from '@/services/datacite/normalize.js';
import {
  affiliationNameClause,
  anyPhrase,
  composeQuery,
  escapeQueryText,
  funderIdClause,
  nameTokensClause,
  orcidClause,
  phrase,
  singleLine,
  stableHash,
  yearRangeClause,
} from '@/services/datacite/query-builder.js';
import type { RawClientResource, RawFacet } from '@/services/datacite/types.js';
import {
  FIELD_OF_SCIENCE_IDS,
  fieldOfScienceLabels,
  resolveFieldOfScience,
} from '@/services/reference/fields-of-science.js';
import { unknownFieldPrefix } from '@/services/reference/query-syntax.js';
import {
  RESOURCE_TYPE_IDS,
  resolveResourceType,
  SORT_ORDER_IDS,
  SORT_ORDERS,
  type SortOrder,
} from '@/services/reference/vocabularies.js';
import {
  blankAsUnset,
  enumish,
  MAX_CHARS,
  optionalArray,
  optionalString,
  providerIdString,
  repositoryIdString,
} from './_schemas.js';
import { blockquote, flattenInline, num, numOrNA, orNA, tableCell } from './_text.js';

/** Page numbers reach only this many matches upstream. */
const PAGE_CEILING = 10_000;

const resolveSort = (value: string) =>
  SORT_ORDER_IDS.find(
    (id) =>
      id ===
      value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_'),
  );

const FacetSchema = z
  .array(
    z
      .object({
        id: z.string().describe('Facet value id — the form the matching filter takes.'),
        title: z.string().describe('Display title.'),
        count: z.number().describe('Matching works with this value.'),
      })
      .describe('One facet bucket.'),
  )
  .describe('Top values (10, resource types can list more), with counts.');

const AppliedFiltersSchema = z
  .object({
    resource_types: z.string().optional().describe('resource-type-id as sent.'),
    creator: z.string().optional().describe('Creator clause as sent.'),
    affiliation: z
      .string()
      .optional()
      .describe('affiliation-id or affiliation-name clause as sent.'),
    affiliation_country: z.string().optional().describe('affiliation-country as sent.'),
    funder: z.string().optional().describe('funded-by or funder clause as sent.'),
    subject: z.string().optional().describe('Subject clause as sent.'),
    fields_of_science: z.string().optional().describe('Field-of-science clause as sent.'),
    repository_ids: z.string().optional().describe('client-id as sent.'),
    provider_ids: z.string().optional().describe('provider-id as sent.'),
    licenses: z.string().optional().describe('license as sent.'),
    language: z.string().optional().describe('Language clause as sent.'),
    place: z.string().optional().describe('Place clause as sent.'),
    published: z.string().optional().describe('Publication-year clause as sent.'),
    min_citations: z.string().optional().describe('has-citations as sent.'),
  })
  .describe('Every applied filter as sent upstream; {} when none.');

type AppliedFilters = z.infer<typeof AppliedFiltersSchema>;

const facetList = (list: RawFacet[] | undefined) =>
  (list ?? []).map((f) => ({ id: f.id, title: f.title ?? f.id, count: f.count }));

export const searchWorksTool = tool('datacite_search_works', {
  title: 'Search DataCite works',
  description:
    'Search DataCite DOI metadata for datasets, software, samples, workflows, and other research outputs. Combine plain words (`text`) or OpenSearch query syntax (`query`) with filters for resource type, creator (ORCID iD or name), affiliation (ROR ID or name), affiliation country, funder (ROR ID, Crossref Funder ID, or name), subject, field of science, repository, provider, license, language, geographic place, publication-year range, and minimum citation count. Returns the total match count and compact rows — DOI, title, first creators, year, type, repository, licenses, and citation/view/download counts — plus optional top facet counts. Page numbers reach the first 10,000 ranked matches; pass cursor "*" to walk any result set in full, in registration order.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'DataCite rejects the syntax of the query input (unbalanced parentheses or quotes, dangling operator).',
      severity: 'notice',
      thrownBy: 'service',
      recovery:
        'Fix the query syntax, or move plain words to text, which escapes every reserved character; datacite_list_reference topic query_syntax lists field paths and operators.',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A filter value is malformed: an ORCID iD failing its checksum, a ror.org or 10.13039/ value that is not a ROR ID or Crossref Funder ID, a language outside ISO 639-1, a creator or funder with no letters or digits, a reversed year range, or include_child_funders without a ROR funder.',
      severity: 'notice',
      recovery:
        'Correct the filter the error names to the form it states (identifier forms: datacite_list_reference topic identifier_formats), then retry.',
    },
    {
      reason: 'page_ceiling',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page × limit exceeds 10,000, or the upstream reports a page other than the one requested.',
      severity: 'notice',
      recovery:
        'Page numbers reach only the first 10,000 matches; narrow the filters, or restart with cursor "*" to walk the whole result set in registration order.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'cursor is neither "*" nor an envelope this tool returned, belongs to a different query or filter set, or the upstream restarted the walk.',
      severity: 'notice',
      recovery:
        'Pass cursor "*" to start a walk, or pass the nextCursor from the previous page unchanged with the same query and filters.',
    },
    {
      reason: 'conflicting_paging',
      code: JsonRpcErrorCode.ValidationError,
      when: 'cursor combined with page or sort.',
      severity: 'notice',
      recovery:
        'A cursor walk runs in registration order and ignores ranking; drop page and sort, or drop cursor to use ranked pages.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "This deployment's shared DataCite request budget is spent: its request queue could not start a request before the call's deadline, or DataCite answered HTTP 429.",
      retryable: true,
      thrownBy: 'service',
      recovery:
        "Wait the number of seconds this error states, then retry; this deployment's shared DataCite request budget is spent for the current 5-minute window.",
    },
  ],

  input: z.object({
    text: optionalString(z.string().max(MAX_CHARS.query)).describe(
      'Plain words and phrases, searched literally: every query-syntax character is escaped, so "Climate change: impacts" works and text can never cause a syntax error. Terms are ANDed.',
    ),
    query: optionalString(z.string().max(MAX_CHARS.query)).describe(
      'OpenSearch query-string syntax — field paths (titles.title:"…", creators.name:…, relatedIdentifiers.relationType:…), AND/OR/NOT, ranges, wildcards. Field paths: datacite_list_reference topic query_syntax. ANDed with text and the filters.',
    ),
    resource_types: optionalArray(enumish(RESOURCE_TYPE_IDS, resolveResourceType), 10).describe(
      'resourceTypeGeneral values (any match): dataset, software, computational-notebook, workflow, model, physical-object, … PascalCase accepted. Full list: datacite_list_reference topic resource_types.',
    ),
    creator: optionalString(z.string().max(MAX_CHARS.phrase)).describe(
      'A creator ORCID iD (0000-0002-1825-0097, 16 digits, or an orcid.org URL; checksum verified) or a name — every name token must appear in one creator field.',
    ),
    affiliation: optionalString(z.string().max(MAX_CHARS.phrase)).describe(
      'A ROR ID (021nxhr62 or a ror.org URL) — matches creator and contributor affiliations — or an affiliation name phrase.',
    ),
    affiliation_country: optionalString(
      z
        .string()
        .regex(
          /^\s*[A-Za-z]{2}\s*$/,
          'Expected a two-letter ISO 3166-1 alpha-2 code such as DE or US; alpha-3 codes and country names match nothing upstream.',
        ),
    ).describe(
      'ISO 3166-1 alpha-2 country of a creator or contributor affiliation, any case (DE, us). Alpha-3 codes and names are rejected.',
    ),
    funder: optionalString(z.string().max(MAX_CHARS.phrase)).describe(
      'A funder ROR ID, a Crossref Funder ID (10.13039/100000001, its doi.org URL, or the bare digits), or a funder name.',
    ),
    include_child_funders: z
      .boolean()
      .default(false)
      .describe("Also match the ROR funder's child organizations. Only with a ROR funder."),
    subject: optionalString(z.string().max(MAX_CHARS.phrase)).describe(
      'A subject phrase, matched case-insensitively against subject terms.',
    ),
    fields_of_science: optionalArray(
      enumish(FIELD_OF_SCIENCE_IDS, resolveFieldOfScience),
      10,
    ).describe(
      'OECD Fields of Science ids or labels (any match), e.g. computer_and_information_sciences or "Earth and related environmental sciences". List: datacite_list_reference topic fields_of_science.',
    ),
    repository_ids: optionalArray(repositoryIdString(), 10).describe(
      'Repository ids (any match), shaped provider.repository — e.g. dryad.dryad or cern.zenodo — as datacite_search_repositories returns them in repositoryId. Any case.',
    ),
    provider_ids: optionalArray(providerIdString(), 10).describe(
      'Provider ids (any match), e.g. dryad — the providerId datacite_search_repositories returns. Any case.',
    ),
    licenses: optionalArray(
      z
        .string()
        .trim()
        .max(MAX_CHARS.id)
        .regex(
          /^\s*[A-Za-z0-9.+_-]+\s*$/,
          'Expected an SPDX-style license id without spaces, such as cc-by-4.0, cc0-1.0, or mit; common ids: datacite_list_reference topic licenses.',
        ),
      10,
    ).describe(
      "The work's own license ids (any match), SPDX-style: cc-by-4.0, cc0-1.0, mit. Lowercased, then matched exactly; common ids: datacite_list_reference topic licenses.",
    ),
    language: optionalString(
      z
        .string()
        .regex(
          /^\s*[A-Za-z]{2}\s*$/,
          'Expected a two-letter ISO 639-1 code such as en or de; three-letter codes and language names are not matched.',
        ),
    ).describe('ISO 639-1 language code of the work, any case (en, de).'),
    place: optionalString(z.string().max(MAX_CHARS.phrase)).describe(
      'A geographic place phrase, matched against deposited place names.',
    ),
    published_from: blankAsUnset(z.number().int().min(1000).max(2100).optional()).describe(
      'Earliest publication year (inclusive). Alone, the range is open-ended.',
    ),
    published_to: blankAsUnset(z.number().int().min(1000).max(2100).optional()).describe(
      'Latest publication year (inclusive). Alone, the range is open-ended.',
    ),
    min_citations: blankAsUnset(z.number().int().min(1).optional()).describe(
      'Only works DataCite records at least this many citations for.',
    ),
    sort: blankAsUnset(enumish(SORT_ORDER_IDS, resolveSort).optional()).describe(
      'relevance, newest, oldest, recently_updated, most_cited, most_viewed, or most_downloaded. Omitted: relevance when text or query is set, else newest. Not with cursor.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(100).default(20)).describe(
      'Rows per page, 1–100.',
    ),
    page: blankAsUnset(z.number().int().min(1).optional()).describe(
      'Ranked page number, 1 when omitted. page × limit may not exceed 10,000; not with cursor.',
    ),
    cursor: optionalString(
      z
        .string()
        .max(MAX_CHARS.cursor)
        .regex(
          /^\s*(?:\*|[A-Za-z0-9_-]+)\s*$/,
          'Expected "*" to start a walk, or the nextCursor of the previous page, unchanged.',
        ),
    ).describe(
      'Cursor walk over the full result set in registration order: "*" to start, then the nextCursor of the previous page, unchanged, with the same query and filters. Not with page or sort.',
    ),
    include_facets: z
      .boolean()
      .default(false)
      .describe(
        'Add top facet counts (resource types, years, repositories, providers, affiliations, fields of science, licenses). Adds 2–8 s.',
      ),
  }),

  output: z.object({
    works: z
      .array(
        z
          .object({
            doi: z.string().describe('DOI, lowercase — pass to datacite_get_work.'),
            title: z.string().optional().describe('First title.'),
            creators: z.array(z.string()).describe('First five creator names.'),
            creatorCount: z.number().describe('Total creators.'),
            publicationYear: z.number().optional().describe('Publication year.'),
            resourceTypeGeneral: z
              .string()
              .optional()
              .describe('resourceTypeGeneral, e.g. Dataset.'),
            resourceType: z.string().optional().describe('Free-text resource type.'),
            publisher: z.string().optional().describe('Publisher name.'),
            repositoryId: z.string().optional().describe('Repository id (repository_ids filter).'),
            repositoryName: z.string().optional().describe('Repository name.'),
            providerId: z
              .string()
              .optional()
              .describe("The repository's provider id (provider_ids filter)."),
            version: z.string().optional().describe('Version string.'),
            licenses: z
              .array(z.string())
              .describe("The work's own license ids; empty when none declared."),
            citationCount: z
              .number()
              .optional()
              .describe(
                'Citations DataCite records for this DOI. Absent when DataCite did not report it.',
              ),
            viewCount: z
              .number()
              .optional()
              .describe('Views the repository reported. Absent when DataCite did not report it.'),
            downloadCount: z
              .number()
              .optional()
              .describe(
                'Downloads the repository reported. Absent when DataCite did not report it.',
              ),
            versionCount: z
              .number()
              .optional()
              .describe('Versions of this DOI. Absent when DataCite did not report it.'),
            created: z
              .string()
              .optional()
              .describe(
                'When the DOI record was created in DataCite (ISO 8601); the newest and oldest sorts and cursor walks order by it.',
              ),
            landingUrl: z.string().optional().describe('Landing page URL.'),
            descriptionSnippet: z
              .string()
              .optional()
              .describe('First 300 characters of the abstract, else of the first description.'),
          })
          .describe('One matching work.'),
      )
      .describe('Matching works on this page.'),
    nextPage: z
      .number()
      .optional()
      .describe('Next ranked page number, when more results lie within the 10,000 ceiling.'),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Pass as cursor, unchanged and with the same query and filters, to read the next page of a walk; absent on the last page.',
      ),
    facets: z
      .object({
        resourceTypes: FacetSchema.describe('Resource types (resource_types ids).'),
        publicationYears: FacetSchema.describe('Publication years.'),
        repositories: FacetSchema.describe('Repositories (repository_ids).'),
        providers: FacetSchema.describe('Providers (provider_ids).'),
        affiliations: FacetSchema.describe('Creator affiliations (ROR ids).'),
        fieldsOfScience: FacetSchema.describe('Fields of science (fields_of_science ids).'),
        licenses: FacetSchema.describe('License ids.'),
      })
      .optional()
      .describe('Top facet counts — only with include_facets.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total works matching the query and filters.'),
    effectiveQuery: z.string().describe('The composed query string sent upstream.'),
    sortApplied: z
      .enum(SORT_ORDER_IDS)
      .describe('The sort order applied; a cursor walk is always oldest (registration order).'),
    appliedFilters: AppliedFiltersSchema,
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, paging stops short of the total, or the page is past the end.',
      ),
  },
  enrichmentTrailer: {
    sortApplied: { label: 'sort' },
    appliedFilters: {
      render: (filters: AppliedFilters) => {
        const entries = Object.entries(filters).filter(([, value]) => value !== undefined);
        return entries.length === 0
          ? '**Applied filters:** none'
          : `**Applied filters:**\n${entries.map(([key, value]) => `- ${key} → ${flattenInline(String(value))}`).join('\n')}`;
      },
    },
  },

  async handler(input, ctx) {
    /** Error data naming the rejected field and the form it expects — never the rejected value. */
    const expected = (field: string, form: string) => ({
      field,
      recovery: {
        hint: `Set ${field} to ${form} (datacite_list_reference topic identifier_formats lists every accepted form), then retry.`,
      },
    });

    const clauses: string[] = [];
    const filters: WorkSearchFilters = {};
    const applied: AppliedFilters = {};
    /** Adds a query clause and echoes it as the filter's applied value. */
    const addClause = (filter: keyof AppliedFilters, clause: string) => {
      clauses.push(clause);
      applied[filter] = clause;
    };
    const query = input.query ? singleLine(input.query) : undefined;
    const text = input.text ? escapeQueryText(input.text) : undefined;
    if (query) clauses.push(`(${query})`);
    if (text) clauses.push(`(${text})`);

    if (input.resource_types) {
      filters.resourceTypeIds = [...new Set(input.resource_types)];
      applied.resource_types = `resource-type-id=${filters.resourceTypeIds.join(',')}`;
    }

    let creatorIsName = false;
    if (input.creator) {
      if (looksLikeOrcid(input.creator)) {
        const orcid = normalizeOrcid(input.creator);
        if (!orcid) {
          throw ctx.fail(
            'invalid_filter',
            'creator is shaped like an ORCID iD but fails the ISO 7064 mod 11-2 checksum.',
            expected('creator', 'a valid ORCID iD such as 0000-0002-1825-0097, or a creator name'),
          );
        }
        addClause('creator', orcidClause(orcid));
      } else {
        if (!/[\p{L}\p{N}]/u.test(input.creator)) {
          throw ctx.fail(
            'invalid_filter',
            'creator contains no letters or digits.',
            expected('creator', 'an ORCID iD or a creator name'),
          );
        }
        creatorIsName = true;
        addClause('creator', nameTokensClause('creators.name', input.creator));
      }
    }

    if (input.affiliation) {
      if (looksLikeRor(input.affiliation)) {
        const ror = normalizeRor(input.affiliation);
        if (!ror) {
          throw ctx.fail(
            'invalid_filter',
            'affiliation carries a ror.org prefix but is not a ROR ID.',
            expected(
              'affiliation',
              'a ROR ID such as 021nxhr62 (bare or a ror.org URL), or an affiliation name',
            ),
          );
        }
        filters.affiliationId = ror;
        applied.affiliation = `affiliation-id=${ror}`;
      } else {
        addClause('affiliation', affiliationNameClause(singleLine(input.affiliation)));
      }
    }

    if (input.affiliation_country) {
      filters.affiliationCountry = input.affiliation_country.toUpperCase();
      applied.affiliation_country = `affiliation-country=${filters.affiliationCountry}`;
    }

    let funderRor: string | undefined;
    if (input.funder) {
      if (looksLikeRor(input.funder)) {
        funderRor = normalizeRor(input.funder);
        if (!funderRor) {
          throw ctx.fail(
            'invalid_filter',
            'funder carries a ror.org prefix but is not a ROR ID.',
            expected(
              'funder',
              'a ROR ID such as 021nxhr62, a Crossref Funder ID such as 10.13039/100000001, or a funder name',
            ),
          );
        }
        filters.fundedBy = funderRor;
        applied.funder = `funded-by=${funderRor}${input.include_child_funders ? ' (+ child organizations)' : ''}`;
      } else if (looksLikeFunderId(input.funder)) {
        const funderId = normalizeFunderId(input.funder);
        if (!funderId) {
          throw ctx.fail(
            'invalid_filter',
            'funder carries the 10.13039/ prefix but is not a Crossref Funder ID.',
            expected(
              'funder',
              'a Crossref Funder ID such as 10.13039/100000001 (10.13039/ followed by digits)',
            ),
          );
        }
        addClause('funder', funderIdClause(funderId));
      } else {
        if (!/[\p{L}\p{N}]/u.test(input.funder)) {
          throw ctx.fail(
            'invalid_filter',
            'funder contains no letters or digits.',
            expected('funder', 'a ROR ID, a Crossref Funder ID, or a funder name'),
          );
        }
        addClause('funder', nameTokensClause('fundingReferences.funderName', input.funder));
      }
    }
    if (input.include_child_funders) {
      if (!funderRor) {
        throw ctx.fail(
          'invalid_filter',
          'include_child_funders applies only when funder is a ROR ID.',
          expected(
            'funder',
            'a ROR ID such as 021nxhr62 when include_child_funders is true, or set include_child_funders to false',
          ),
        );
      }
      filters.includeFunderChildOrganizations = true;
    }

    if (input.subject) {
      addClause('subject', `subjects.subject:${phrase(singleLine(input.subject))}`);
    }

    if (input.fields_of_science) {
      const phrases = [...new Set(input.fields_of_science)]
        .flatMap(fieldOfScienceLabels)
        .map((label) => `FOS: ${label}`);
      addClause('fields_of_science', anyPhrase('subjects.subject', phrases));
    }

    if (input.repository_ids) {
      filters.clientIds = [...new Set(input.repository_ids.map((id) => id.toLowerCase()))];
      applied.repository_ids = `client-id=${filters.clientIds.join(',')}`;
    }

    if (input.provider_ids) {
      filters.providerIds = [...new Set(input.provider_ids.map((id) => id.toLowerCase()))];
      applied.provider_ids = `provider-id=${filters.providerIds.join(',')}`;
    }

    if (input.licenses) {
      filters.licenses = [...new Set(input.licenses.map((l) => l.toLowerCase()))];
      applied.licenses = `license=${filters.licenses.join(',')}`;
    }

    if (input.language) {
      const language = normalizeLanguage(input.language);
      if (!language) {
        throw ctx.fail(
          'invalid_filter',
          'language is not an ISO 639-1 code.',
          expected('language', 'a two-letter ISO 639-1 code such as en or de'),
        );
      }
      addClause('language', `language:${language}`);
    }

    if (input.place) {
      addClause('place', `geoLocations.geoLocationPlace:${phrase(singleLine(input.place))}`);
    }

    if (input.published_from !== undefined || input.published_to !== undefined) {
      if (
        input.published_from !== undefined &&
        input.published_to !== undefined &&
        input.published_from > input.published_to
      ) {
        throw ctx.fail(
          'invalid_filter',
          'published_from is later than published_to, so the year range is reversed.',
          {
            field: 'published_from',
            recovery: {
              hint: 'Set published_from to a year no later than published_to (swap the two if they were reversed), then retry.',
            },
          },
        );
      }
      addClause('published', yearRangeClause(input.published_from, input.published_to));
    }

    if (input.min_citations !== undefined) {
      filters.minCitations = input.min_citations;
      applied.min_citations = `has-citations=${input.min_citations}`;
    }

    // Paging mode.
    const cursorMode = input.cursor !== undefined;
    if (cursorMode && (input.page !== undefined || input.sort !== undefined)) {
      throw ctx.fail(
        'conflicting_paging',
        `cursor cannot be combined with ${input.page !== undefined ? 'page' : 'sort'}.`,
        ctx.recoveryFor('conflicting_paging'),
      );
    }
    const page = input.page ?? 1;
    if (!cursorMode && page * input.limit > PAGE_CEILING) {
      throw ctx.fail(
        'page_ceiling',
        `page ${page} × limit ${input.limit} = ${page * input.limit} exceeds the ${num(PAGE_CEILING)}-match ceiling of ranked paging.`,
        ctx.recoveryFor('page_ceiling'),
      );
    }

    const effectiveQuery = composeQuery(clauses);
    const fingerprint = stableHash(JSON.stringify({ q: effectiveQuery, f: filters }));
    let cursorToken: string | undefined;
    let cursorFloor: number | undefined;
    let deliveredBefore = 0;
    if (input.cursor !== undefined && input.cursor !== '*') {
      const envelope = decodeCursor(input.cursor);
      if (!envelope) {
        throw ctx.fail(
          'invalid_cursor',
          'cursor is neither "*" nor a nextCursor this tool returned.',
          {
            recovery: {
              hint: 'Pass cursor "*" to start a walk, or pass the nextCursor from the previous page unchanged.',
            },
          },
        );
      }
      if (envelope.q !== fingerprint) {
        throw ctx.fail('invalid_cursor', 'cursor belongs to a different query or filter set.', {
          recovery: {
            hint: 'Repeat the exact query and filters that produced this cursor, or start a new walk with cursor "*".',
          },
        });
      }
      cursorToken = envelope.t;
      cursorFloor = envelope.c;
      deliveredBefore = envelope.n;
    }

    const sortApplied: SortOrder = cursorMode
      ? 'oldest'
      : (input.sort ?? (query || text ? 'relevance' : 'newest'));
    ctx.enrich.echo(effectiveQuery);
    ctx.enrich({ sortApplied, appliedFilters: applied });

    const list = await getDataCiteService().searchWorks(
      {
        query: effectiveQuery,
        callerQuery: query !== undefined,
        filters,
        page: cursorMode ? { cursor: cursorToken ?? '1' } : { number: page },
        size: input.limit,
        sort: SORT_ORDERS[sortApplied],
        facets: input.include_facets,
      },
      ctx,
    );
    const total = list.meta.total ?? 0;
    ctx.enrich.total(total);

    if (!cursorMode && typeof list.meta.page === 'number' && list.meta.page !== page) {
      throw ctx.fail(
        'page_ceiling',
        `DataCite served page ${list.meta.page} instead of the requested page ${page}.`,
        ctx.recoveryFor('page_ceiling'),
      );
    }
    const firstCreated = Date.parse(list.data[0]?.attributes.created ?? '');
    if (cursorFloor !== undefined && firstCreated < cursorFloor) {
      throw ctx.fail(
        'invalid_cursor',
        'DataCite restarted the walk from the beginning instead of continuing it.',
        {
          recovery: {
            hint: 'Start the walk again with cursor "*"; the previous position could not be resumed.',
          },
        },
      );
    }

    const clients = new Map<string, RawClientResource>((list.included ?? []).map((c) => [c.id, c]));
    const works = list.data.map((record) => mapWorkRow(record, clients));

    let nextPage: number | undefined;
    let nextCursor: string | undefined;
    if (cursorMode) {
      // DataCite can link a next page from the full page that ends the walk; the row count decides.
      const token = upstreamCursorToken(list.links?.next);
      const delivered = deliveredBefore + works.length;
      const lastCreated = Date.parse(list.data.at(-1)?.attributes.created ?? '');
      if (token && works.length > 0 && delivered < (list.meta.total ?? Number.POSITIVE_INFINITY)) {
        nextCursor = encodeCursor({
          t: token,
          q: fingerprint,
          c: Number.isNaN(lastCreated) ? 0 : lastCreated,
          n: delivered,
        });
      }
    } else if (page * input.limit < total && (page + 1) * input.limit <= PAGE_CEILING) {
      nextPage = page + 1;
    }

    const notices: string[] = [];
    if (total === 0) {
      notices.push('No DataCite works matched.');
      const unknownField = query ? unknownFieldPrefix(query) : undefined;
      if (unknownField) {
        notices.push(
          `"${flattenInline(unknownField)}:" is not a DataCite field, so the query searched a field that does not exist; put plain words in text instead, or see datacite_list_reference topic query_syntax.`,
        );
      }
      if (filters.licenses) {
        notices.push(
          "License ids must match DataCite's lowercase SPDX ids exactly; check them against datacite_list_reference topic licenses.",
        );
      }
      if (filters.clientIds || filters.providerIds) {
        notices.push('Confirm the repository or provider ids with datacite_search_repositories.');
      }
      if (creatorIsName) {
        notices.push(
          "Name matching needs every token in one creator field; try a surname alone or the creator's ORCID iD.",
        );
      }
      if (Object.keys(applied).length >= 3) {
        notices.push(
          'Several filters are ANDed together; drop one at a time to find the one excluding everything.',
        );
      }
    } else if (!cursorMode && nextPage === undefined && page * input.limit < total) {
      notices.push(
        `Ranked pages stop at the first ${num(PAGE_CEILING)} of ${num(total)} matches; restart with cursor "*" to walk them all in registration order, or narrow the filters.`,
      );
    } else if (!cursorMode && (page - 1) * input.limit >= total) {
      notices.push(
        `Page ${page} is past the end of the results; at limit ${input.limit} the last page is ${num(Math.ceil(total / input.limit))}, so request that page or an earlier one.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('Work search completed', { total, returned: works.length, cursorMode });
    return {
      works,
      ...(nextPage !== undefined && { nextPage }),
      ...(nextCursor !== undefined && { nextCursor }),
      ...(input.include_facets && {
        facets: {
          resourceTypes: facetList(list.meta.resourceTypes),
          publicationYears: facetList(list.meta.published),
          repositories: facetList(list.meta.clients),
          providers: facetList(list.meta.providers),
          affiliations: facetList(list.meta.affiliations),
          fieldsOfScience: facetList(list.meta.fieldsOfScience),
          licenses: facetList(list.meta.licenses),
        },
      }),
    };
  },

  format: (result) => {
    const lines = [`**${result.works.length} works on this page**`, ''];
    for (const w of result.works) {
      lines.push(`### ${flattenInline(w.title ?? w.doi)}`);
      const repository = w.repositoryId
        ? `${w.repositoryName ? `${flattenInline(w.repositoryName)} ` : ''}(${flattenInline(w.repositoryId)})${w.providerId ? `, provider ${flattenInline(w.providerId)}` : ''}`
        : 'Not available';
      const creators =
        w.creators.length > 0
          ? `${w.creators.map(flattenInline).join('; ')}${w.creatorCount > w.creators.length ? ` +${num(w.creatorCount - w.creators.length)} more` : ''}`
          : 'Not available';
      lines.push(
        `- **DOI:** ${w.doi} · **Year:** ${orNA(w.publicationYear)} · **Type:** ${orNA(w.resourceTypeGeneral)}${w.resourceType ? ` (${flattenInline(w.resourceType)})` : ''} · **Version:** ${orNA(w.version)} · **Created:** ${orNA(w.created)}`,
        `- **Repository:** ${repository} · **Publisher:** ${orNA(w.publisher)}`,
        `- **Licenses:** ${w.licenses.length > 0 ? w.licenses.map(flattenInline).join(', ') : 'none declared'} · **Citations:** ${numOrNA(w.citationCount)} · **Views:** ${numOrNA(w.viewCount)} · **Downloads:** ${numOrNA(w.downloadCount)} · **Versions:** ${numOrNA(w.versionCount)}`,
        `- **Creators (${num(w.creatorCount)}):** ${creators}`,
        `- **Landing page:** ${orNA(w.landingUrl)}`,
      );
      if (w.descriptionSnippet) lines.push('', blockquote(w.descriptionSnippet));
      lines.push('');
    }
    if (result.facets) {
      lines.push('## Facets');
      const groups: Array<[string, typeof result.facets.licenses]> = [
        ['Resource types', result.facets.resourceTypes],
        ['Publication years', result.facets.publicationYears],
        ['Repositories', result.facets.repositories],
        ['Providers', result.facets.providers],
        ['Affiliations', result.facets.affiliations],
        ['Fields of science', result.facets.fieldsOfScience],
        ['Licenses', result.facets.licenses],
      ];
      for (const [name, buckets] of groups) {
        lines.push(
          `**${name}:** ${buckets.length > 0 ? buckets.map((b) => `${tableCell(b.id)} (${tableCell(b.title)}) — ${num(b.count)}`).join('; ') : 'none'}`,
        );
      }
      lines.push('');
    }
    if (result.nextPage !== undefined) lines.push(`**Next page:** page ${result.nextPage}`);
    if (result.nextCursor !== undefined) lines.push(`**Next cursor:** ${result.nextCursor}`);
    if (result.nextPage === undefined && result.nextCursor === undefined)
      lines.push('**Last page.**');
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
