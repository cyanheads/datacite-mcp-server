/**
 * @fileoverview `datacite_search_repositories` — find DataCite repository
 * accounts by text and registry facets, or look up known repository ids, and
 * return the repositoryId that work search filters take.
 * @module mcp-server/tools/definitions/search-repositories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDataCiteService } from '@/services/datacite/datacite-service.js';
import { mapRepository } from '@/services/datacite/mappers.js';
import { anyPhrase, composeQuery, singleLine } from '@/services/datacite/query-builder.js';
import {
  FIELD_OF_SCIENCE_IDS,
  fieldOfScienceLabels,
  resolveFieldOfScience,
} from '@/services/reference/fields-of-science.js';
import {
  CERTIFICATE_IDS,
  CLIENT_TYPE_IDS,
  REPOSITORY_TYPE_IDS,
  resolveCertificate,
  resolveClientType,
  resolveRepositoryType,
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
import { blockquote, flattenInline, num, orNA } from './_text.js';

const AppliedFiltersSchema = z
  .object({
    field_of_science: z.string().optional().describe('Subject clause as sent.'),
    repository_types: z.string().optional().describe('repository-type as sent.'),
    certificates: z.string().optional().describe('certificate as sent.'),
    software: z.string().optional().describe('software as sent.'),
    client_type: z.string().optional().describe('client-type as sent.'),
    provider_id: z.string().optional().describe('provider-id as sent.'),
    repository_ids: z.string().optional().describe('ids as sent.'),
  })
  .describe('Every applied filter as sent upstream; {} when none.');

type AppliedFilters = z.infer<typeof AppliedFiltersSchema>;

export const searchRepositoriesTool = tool('datacite_search_repositories', {
  title: 'Search DataCite repositories',
  description:
    "Find DataCite repository accounts by name or description text, field of science, repository type, certification (e.g. CoreTrustSeal), software platform, client type, or parent provider, or look up known repository IDs. Returns each repository's repositoryId — the value datacite_search_works takes in repository_ids — with its providerId, name, type, certificates, software, subjects, homepage, and re3data link. To rank repositories by how many works they hold on a topic, run datacite_search_works with that topic and include_facets: true; its repositories facet lists the top ten with counts.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'DataCite rejects the syntax of the query input (unbalanced parentheses or quotes, dangling operator).',
      severity: 'notice',
      thrownBy: 'service',
      recovery:
        'Fix the query syntax, or search a plain repository name; datacite_list_reference topic query_syntax lists operators.',
    },
    {
      reason: 'conflicting_lookup',
      code: JsonRpcErrorCode.ValidationError,
      when: 'repository_ids combined with query or any filter.',
      severity: 'notice',
      recovery:
        'Look up known ids with repository_ids alone, or search with query and filters alone; an id lookup ignores filters.',
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
    query: optionalString(z.string().max(MAX_CHARS.query)).describe(
      'Text matched against repository names, alternate names, and descriptions. Query-string syntax is accepted.',
    ),
    field_of_science: blankAsUnset(
      enumish(FIELD_OF_SCIENCE_IDS, resolveFieldOfScience).optional(),
    ).describe(
      'An OECD Fields of Science id or label the repository lists among its subjects, e.g. earth_and_related_environmental_sciences. List: datacite_list_reference topic fields_of_science.',
    ),
    repository_types: optionalArray(
      enumish(REPOSITORY_TYPE_IDS, resolveRepositoryType),
      6,
    ).describe(
      'Repository types (any match): institutional, disciplinary, multidisciplinary, project-related, governmental, other.',
    ),
    certificates: optionalArray(enumish(CERTIFICATE_IDS, resolveCertificate), 7).describe(
      'Certificates (any match): CoreTrustSeal, WDS, DSA, DINI, RatSWD, CLARIN, DIN 31644; any case.',
    ),
    software: optionalString(z.string().max(MAX_CHARS.phrase)).describe(
      'Software platform slug, lowercased: dataverse, dspace, invenio, ckan, open_journal_systems_ojs, … (free-form upstream; see datacite_list_reference topic software_platforms).',
    ),
    client_type: blankAsUnset(enumish(CLIENT_TYPE_IDS, resolveClientType).optional()).describe(
      'Account type: repository, periodical, igsnCatalog, or raidRegistry. Omitted: all.',
    ),
    provider_id: optionalString(providerIdString()).describe(
      'Parent provider id, e.g. dryad — the providerId a repository carries. Any case.',
    ),
    repository_ids: optionalArray(repositoryIdString(), 25).describe(
      'Known repository ids to look up in one batch, shaped provider.repository (e.g. dryad.dryad); any case. Use alone — an id lookup ignores query and filters.',
    ),
    limit: blankAsUnset(z.number().int().min(1).max(100).default(20)).describe(
      'Repositories per page, 1–100.',
    ),
    page: blankAsUnset(z.number().int().min(1).default(1)).describe(
      'Page number. Past the last page the list is empty.',
    ),
  }),

  output: z.object({
    repositories: z
      .array(
        z
          .object({
            repositoryId: z
              .string()
              .describe('Repository id — pass to datacite_search_works repository_ids.'),
            name: z.string().describe('Repository name.'),
            alternateName: z.string().optional().describe('Alternate name or acronym.'),
            providerId: z.string().optional().describe('Parent provider id (provider_ids filter).'),
            clientType: z
              .string()
              .optional()
              .describe('repository, periodical, igsnCatalog, or raidRegistry.'),
            repositoryTypes: z
              .array(z.string())
              .describe('Repository types, e.g. disciplinary (repository_types filter values).'),
            certificates: z.array(z.string()).describe('Certificates held.'),
            software: z
              .string()
              .optional()
              .describe('Software platform, as the registry displays it.'),
            subjects: z.array(z.string()).describe('Subject labels the repository lists.'),
            language: z.array(z.string()).describe('Language codes.'),
            url: z.string().optional().describe('Homepage.'),
            re3data: z.string().optional().describe('re3data registry DOI URL.'),
            opendoar: z.string().optional().describe('OpenDOAR id.'),
            description: z.string().optional().describe('Description as registered.'),
            year: z.number().optional().describe('Year the account was created.'),
            isActive: z.boolean().optional().describe('Whether the account is active.'),
          })
          .describe('One repository account.'),
      )
      .describe('Repositories on this page, ordered by name.'),
    nextPage: z.number().optional().describe('Next page number, when more repositories match.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total repositories matching.'),
    orderApplied: z
      .literal('name')
      .describe('Result order — always by name, as the registry returns it.'),
    appliedFilters: AppliedFiltersSchema,
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, the page is past the end, or a requested repository id matched no account.',
      ),
  },
  enrichmentTrailer: {
    orderApplied: { label: 'order' },
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
    const applied: AppliedFilters = {};
    const query = input.query ? singleLine(input.query) : undefined;
    const software = input.software?.toLowerCase();

    let ids: string[] | undefined;
    if (input.repository_ids) {
      const searching = [
        query,
        input.field_of_science,
        input.repository_types,
        input.certificates,
        software,
        input.client_type,
        input.provider_id,
      ].some((value) => value !== undefined);
      if (searching) {
        throw ctx.fail(
          'conflicting_lookup',
          'repository_ids cannot be combined with query or filters: DataCite answers an id lookup without applying them.',
          ctx.recoveryFor('conflicting_lookup'),
        );
      }
      ids = [...new Set(input.repository_ids.map((id) => id.toLowerCase()))];
      applied.repository_ids = `ids=${ids.join(',')}`;
    }

    const providerId = input.provider_id?.toLowerCase();
    if (providerId) applied.provider_id = `provider-id=${providerId}`;

    const clauses: string[] = [];
    if (query) clauses.push(`(${query})`);
    if (input.field_of_science) {
      const clause = anyPhrase('subjects.subject', fieldOfScienceLabels(input.field_of_science));
      clauses.push(clause);
      applied.field_of_science = clause;
    }
    const repositoryTypes = input.repository_types && [...new Set(input.repository_types)];
    if (repositoryTypes) applied.repository_types = `repository-type=${repositoryTypes.join(',')}`;
    const certificates = input.certificates && [...new Set(input.certificates)];
    if (certificates) applied.certificates = `certificate=${certificates.join(',')}`;
    if (software) applied.software = `software=${software}`;
    if (input.client_type) applied.client_type = `client-type=${input.client_type}`;

    ctx.enrich({ orderApplied: 'name', appliedFilters: applied });

    // An id batch returns every requested id on one page, whatever limit says.
    const size = ids ? Math.max(input.limit, ids.length) : input.limit;
    const list = await getDataCiteService().searchRepositories(
      {
        callerQuery: query !== undefined,
        page: input.page,
        size,
        ...(ids && { ids }),
        ...(clauses.length > 0 && { query: composeQuery(clauses) }),
        ...(repositoryTypes && { repositoryTypes }),
        ...(certificates && { certificates }),
        ...(software && { software }),
        ...(input.client_type && { clientType: input.client_type }),
        ...(providerId && { providerId }),
      },
      ctx,
    );
    const total = list.meta.total ?? 0;
    ctx.enrich.total(total);

    const repositories = list.data.map(mapRepository);
    const nextPage = input.page * size < total ? input.page + 1 : undefined;

    const notices: string[] = [];
    if (total === 0) {
      notices.push('No DataCite repositories matched.');
      if (software) {
        notices.push(
          'Software slugs are free-form lowercase ids; see datacite_list_reference topic software_platforms.',
        );
      }
      if (query) {
        notices.push(
          'Repository text search covers names and descriptions only; to find repositories by what they publish, run datacite_search_works with include_facets: true.',
        );
      }
    } else if ((input.page - 1) * size >= total) {
      notices.push(
        `Page ${input.page} is past the end of the results; the last page is ${num(Math.ceil(total / size))}, so request that page or an earlier one.`,
      );
    }
    // DataCite drops an unknown id from the batch without saying so.
    if (ids && input.page === 1) {
      const returned = new Set(repositories.map((r) => r.repositoryId.toLowerCase()));
      const missing = ids.filter((id) => !returned.has(id));
      if (missing.length > 0) {
        notices.push(
          `No DataCite repository has the id${missing.length === 1 ? '' : 's'} ${missing.join(', ')}; check the spelling, or search by name with query.`,
        );
      }
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('Repository search completed', { total, returned: repositories.length });
    return { repositories, ...(nextPage !== undefined && { nextPage }) };
  },

  format: (result) => {
    const lines = [
      `**${result.repositories.length} repositories on this page** (ordered by name)`,
      '',
    ];
    const list = (values: string[], empty: string) =>
      values.length > 0 ? values.map(flattenInline).join(', ') : empty;
    for (const r of result.repositories) {
      lines.push(`### ${flattenInline(r.name)} (${flattenInline(r.repositoryId)})`);
      lines.push(
        `- **Provider:** ${orNA(r.providerId)} · **Client type:** ${orNA(r.clientType)} · **Types:** ${list(r.repositoryTypes, 'none listed')} · **Certificates:** ${list(r.certificates, 'none')}`,
        `- **Software:** ${orNA(r.software)} · **Languages:** ${list(r.language, 'none listed')} · **Since:** ${orNA(r.year)} · **Active:** ${r.isActive === undefined ? 'Not available' : r.isActive}`,
      );
      if (r.alternateName) lines.push(`- **Also known as:** ${flattenInline(r.alternateName)}`);
      lines.push(
        `- **Homepage:** ${orNA(r.url)} · **re3data:** ${orNA(r.re3data)} · **OpenDOAR:** ${orNA(r.opendoar)}`,
      );
      lines.push(
        `- **Subjects:** ${r.subjects.length ? r.subjects.map(flattenInline).join('; ') : 'none listed'}`,
      );
      if (r.description) lines.push('', blockquote(r.description));
      lines.push('');
    }
    lines.push(
      result.nextPage !== undefined ? `**Next page:** page ${result.nextPage}` : '**Last page.**',
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
