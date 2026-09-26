/**
 * @fileoverview The `datacite_list_reference` topics: each assembles its entries
 * and notes from the static vocabularies. Offline; no upstream request.
 * @module services/reference/topics
 */

import {
  CITATION_FORMAT_IDS,
  CITATION_FORMAT_LABELS,
  CITATION_FORMATS,
  CSL_LOCALES,
  CSL_PRIMARY_DIALECTS,
  FALLBACK_CITATION_STYLES,
  VERIFIED_CITATION_STYLES,
} from './citation.js';
import { FIELDS_OF_SCIENCE } from './fields-of-science.js';
import { VERIFIED_QUERY_FIELDS } from './query-syntax.js';
import {
  CERTIFICATE_IDS,
  CLIENT_TYPE_IDS,
  CLIENT_TYPE_LABELS,
  CONTRIBUTOR_TYPES,
  DATE_TYPES,
  IDENTIFIER_TYPES,
  LICENSES,
  RELATION_TYPES,
  REPOSITORY_TYPE_IDS,
  RESOURCE_TYPE_IDS,
  resourceTypeLabel,
  SOFTWARE_PLATFORMS,
  SORT_ORDERS,
} from './vocabularies.js';

export const REFERENCE_TOPICS = [
  'resource_types',
  'relation_types',
  'identifier_types',
  'date_types',
  'contributor_types',
  'fields_of_science',
  'licenses',
  'repository_types',
  'certificates',
  'software_platforms',
  'client_types',
  'sort_orders',
  'query_syntax',
  'citation_formats',
  'citation_styles',
  'citation_locales',
  'identifier_formats',
  'coverage',
] as const;
export type ReferenceTopic = (typeof REFERENCE_TOPICS)[number];

/** One vocabulary entry. */
export interface ReferenceEntry {
  description?: string;
  group?: string;
  inverse?: string;
  label?: string;
  value: string;
}

/** A topic's full content. */
export interface ReferenceContent {
  entries: ReferenceEntry[];
  notes: string[];
  title: string;
}

const ENUM_INPUT_NOTE =
  'Inputs accept the value in any case and with hyphens, underscores, or spaces (e.g. "JournalArticle", "journal_article", "Journal Article").';

const REPOSITORY_TYPE_DESCRIPTIONS: Record<(typeof REPOSITORY_TYPE_IDS)[number], string> = {
  institutional: 'Run by one institution for its own outputs.',
  disciplinary: 'Serves one discipline or research community.',
  multidisciplinary: 'Accepts outputs from any discipline.',
  'project-related': 'Serves one project or consortium.',
  governmental: 'Run by a government body.',
  other: 'Any other repository type.',
};

const CERTIFICATE_DESCRIPTIONS: Record<(typeof CERTIFICATE_IDS)[number], string> = {
  CoreTrustSeal: 'CoreTrustSeal trustworthy data repository certification.',
  WDS: 'World Data System membership (predecessor of CoreTrustSeal).',
  DSA: 'Data Seal of Approval (predecessor of CoreTrustSeal).',
  DINI: 'DINI certificate for open-access repositories (Germany).',
  RatSWD: 'German Data Forum (RatSWD) accredited research data centre.',
  CLARIN: 'CLARIN B-centre certification (language resources).',
  'DIN 31644': 'DIN 31644 / nestor seal for trustworthy digital archives.',
};

const SORT_DESCRIPTIONS: Record<keyof typeof SORT_ORDERS, string> = {
  relevance: 'Best match first. The default when text or query is set.',
  newest: 'Most recently registered first. The default without text or query.',
  oldest: 'Earliest registered first — the order a cursor walk always uses.',
  recently_updated: 'Most recently updated metadata first.',
  most_cited: 'Highest citation count first.',
  most_viewed: 'Highest view count first.',
  most_downloaded: 'Highest download count first.',
};

/** The content for one reference topic. */
export function getReferenceTopic(topic: ReferenceTopic): ReferenceContent {
  switch (topic) {
    case 'resource_types':
      return {
        title: 'Resource types (resourceTypeGeneral)',
        entries: RESOURCE_TYPE_IDS.map((value) => ({ value, label: resourceTypeLabel(value) })),
        notes: [
          'The 34 values present in the DataCite index, as the resource_types filter of datacite_search_works takes them.',
          ENUM_INPUT_NOTE,
        ],
      };
    case 'relation_types':
      return {
        title: 'Relation types',
        entries: RELATION_TYPES.map((entry) => ({
          value: entry.id,
          group: entry.group,
          ...(entry.inverse && { inverse: entry.inverse }),
          ...(entry.note && { description: entry.note }),
        })),
        notes: [
          'Edges returned by datacite_trace_relations keep the direction and relationType the asserting record gave; an edge is never inverted into its inverse type.',
          'Citation counts count IsCitedBy, IsReferencedBy, and IsSupplementTo on the cited DOI, or Cites, References, and IsSupplementedBy on the citing one.',
          'Event Data carries only the citations group (Cites, IsCitedBy, References, IsReferencedBy, IsSupplementTo, IsSupplementedBy).',
          'relatedIdentifiers.relationType in query syntax is case-sensitive; the relation_types input of datacite_trace_relations is not.',
        ],
      };
    case 'identifier_types':
      return {
        title: 'Related-identifier types',
        entries: IDENTIFIER_TYPES.map((value) => ({ value })),
        notes: [
          'The relatedIdentifierType values of the current DataCite schema. datacite_trace_relations reports them as node idType; a doi.org URL stored as a URL is normalized to its bare DOI.',
        ],
      };
    case 'date_types':
      return {
        title: 'Date types',
        entries: DATE_TYPES.map((value) => ({ value })),
        notes: ["The dateType values a record's dates carry in datacite_get_work."],
      };
    case 'contributor_types':
      return {
        title: 'Contributor types',
        entries: CONTRIBUTOR_TYPES.map((value) => ({ value })),
        notes: ["The contributorType values a record's contributors carry in datacite_get_work."],
      };
    case 'fields_of_science':
      return {
        title: 'Fields of Science and Technology (OECD FOS 2007)',
        entries: [...FIELDS_OF_SCIENCE.values()].map((field) => ({
          value: field.id,
          label: field.label,
          group: field.area,
          description: [
            `OECD ${field.code}`,
            ...(field.variants?.length
              ? [
                  `also matches the stored spelling ${field.variants.map((v) => `"${v}"`).join(', ')}`,
                ]
              : []),
          ].join('; '),
        })),
        notes: [
          'Pass the id or the label (a "FOS:" prefix is accepted) as fields_of_science on datacite_search_works or field_of_science on datacite_search_repositories.',
          'Work search matches the "FOS: <label>" subjects DataCite derives, as analyzed phrases, so one field covers its label with or without an Oxford comma and each listed spelling variant.',
          'An area id (natural_sciences, humanities, …) matches records tagged with the area itself; it does not expand to the fields under it.',
        ],
      };
    case 'licenses':
      return {
        title: 'License ids',
        entries: LICENSES.map(({ value, label }) => ({ value, label })),
        notes: [
          "DataCite stores a work's license as a lowercase SPDX-style rightsIdentifier; the licenses filter of datacite_search_works matches it exactly.",
          'This list holds the most common ids in the index and is not exhaustive; any SPDX id in lowercase is accepted, and a zero-hit search names the filter.',
          'notspecified and pdm are DataCite values, not SPDX ids.',
        ],
      };
    case 'repository_types':
      return {
        title: 'Repository types',
        entries: REPOSITORY_TYPE_IDS.map((value) => ({
          value,
          description: REPOSITORY_TYPE_DESCRIPTIONS[value],
        })),
        notes: ['The repository_types filter of datacite_search_repositories.', ENUM_INPUT_NOTE],
      };
    case 'certificates':
      return {
        title: 'Repository certificates',
        entries: CERTIFICATE_IDS.map((value) => ({
          value,
          description: CERTIFICATE_DESCRIPTIONS[value],
        })),
        notes: ['The certificates filter of datacite_search_repositories.', ENUM_INPUT_NOTE],
      };
    case 'software_platforms':
      return {
        title: 'Repository software platforms',
        entries: SOFTWARE_PLATFORMS.map(({ value, label }) => ({ value, label })),
        notes: [
          'The software filter of datacite_search_repositories takes the lowercase slug.',
          'The vocabulary is free-form upstream; these are the observed slugs, and a zero-hit search says so.',
        ],
      };
    case 'client_types':
      return {
        title: 'Client (account) types',
        entries: CLIENT_TYPE_IDS.map((value) => ({ value, label: CLIENT_TYPE_LABELS[value] })),
        notes: [
          'The client_type filter of datacite_search_repositories; omitted, every type is listed.',
        ],
      };
    case 'sort_orders':
      return {
        title: 'Work search sort orders',
        entries: (Object.keys(SORT_ORDERS) as (keyof typeof SORT_ORDERS)[]).map((value) => ({
          value,
          label: `sort=${SORT_ORDERS[value]}`,
          description: SORT_DESCRIPTIONS[value],
        })),
        notes: [
          'The sort input of datacite_search_works. The order is always sent explicitly and echoed as sortApplied, because the upstream default is not relevance and it ignores unknown values.',
          'A cursor walk (cursor "*") runs in registration order and rejects sort.',
        ],
      };
    case 'query_syntax':
      return {
        title: 'Query syntax (datacite_search_works query)',
        entries: VERIFIED_QUERY_FIELDS.map(({ value, description }) => ({ value, description })),
        notes: [
          'query takes OpenSearch query-string syntax: field:value, field:"exact phrase", AND / OR / NOT (uppercase), parentheses, ranges field:[a TO b], and wildcards (* ?).',
          'Reserved characters + - = && || > < ! ( ) { } [ ] ^ " ~ * ? : \\ / must be escaped with a backslash to be searched literally.',
          'The colon trap: "Climate change: impacts" reads change as a field name and silently returns zero. Put plain words in text instead — it escapes every reserved character and cannot produce a syntax error.',
          'A field that does not exist matches nothing rather than failing, so a misspelled field returns zero hits.',
        ],
      };
    case 'citation_formats':
      return {
        title: 'Citation formats',
        entries: CITATION_FORMAT_IDS.map((value) => ({
          value,
          label: CITATION_FORMAT_LABELS[value],
          description: CITATION_FORMATS[value],
        })),
        notes: [
          'The format input of datacite_get_citation. style and locale apply to text only.',
          'RDF/Turtle is documented upstream but answers 404, so it is not offered.',
        ],
      };
    case 'citation_styles':
      return {
        title: 'Citation styles (CSL)',
        entries: [
          ...VERIFIED_CITATION_STYLES.map((value) => ({
            value,
            group: 'verified',
            ...(value === 'apa' && { description: 'The default.' }),
          })),
          ...FALLBACK_CITATION_STYLES.map(({ value, note }) => ({
            value,
            group: 'falls back to APA',
            description: note,
          })),
        ],
        notes: [
          'Styles in the verified group render distinctly upstream; any other current independent CSL style id is accepted and checked on first use.',
          'The upstream renders an unknown, retired, dependent, or wrong-case style id as APA without saying so; datacite_get_citation detects that and rejects the style instead.',
          'Style ids are lowercase (IEEE is sent as ieee). A journal-specific dependent style needs its independent parent style id.',
        ],
      };
    case 'citation_locales':
      return {
        title: 'Citation locales (CSL)',
        entries: CSL_LOCALES.map(([value, label]) => ({ value, label })),
        notes: [
          `A bare language code selects its CSL primary dialect: ${Object.entries(
            CSL_PRIMARY_DIALECTS,
          )
            .filter(([language, locale]) => language !== locale)
            .map(([language, locale]) => `${language} → ${locale}`)
            .join(', ')}.`,
          'Omitted, the rendering is US English (en-US). A locale outside this list is rejected, because the upstream silently renders the whole citation as APA en-US for it.',
        ],
      };
    case 'identifier_formats':
      return {
        title: 'Accepted identifier forms',
        entries: [
          {
            value: 'DOI',
            label: '10.5061/dryad.234',
            description:
              'Also doi:…, info:doi/…, https://doi.org/…, http://dx.doi.org/…, or a %2F-encoded DOI. Trimmed, prefix stripped, decoded, lowercased; must match 10.<4–9 digits>/<suffix>.',
          },
          {
            value: 'ORCID iD',
            label: '0000-0002-1825-0097',
            description:
              'Also 16 digits without hyphens, https://orcid.org/…, orcid.org/…, or a lowercase x check digit. The ISO 7064 mod 11-2 checksum is verified.',
          },
          {
            value: 'ROR ID',
            label: '021nxhr62',
            description:
              'Also ror.org/… or https://ror.org/…, any case; 0 + 6 letters or digits + 2 digits.',
          },
          {
            value: 'Crossref Funder ID',
            label: '10.13039/100000001',
            description:
              'Also its doi.org URL forms, or the bare digits (not starting with 0), which become 10.13039/<digits>.',
          },
          {
            value: 'Country',
            label: 'DE',
            description: 'ISO 3166-1 alpha-2, any case. Alpha-3 codes and names are rejected.',
          },
          { value: 'Language', label: 'en', description: 'ISO 639-1, any case.' },
          {
            value: 'Repository ID',
            label: 'dryad.dryad',
            description:
              'provider.repository: letters, digits, and hyphens, any case. Find one with datacite_search_repositories.',
          },
          {
            value: 'Provider ID',
            label: 'dryad',
            description: 'Letters, digits, and hyphens, any case.',
          },
        ],
        notes: [
          'Every identifier input normalizes what is certain (case, prefixes, URL forms) and rejects what is not, naming the field and the expected form.',
          'creator, affiliation, and funder in datacite_search_works also take a plain name; an input shaped like an identifier is matched as one.',
        ],
      };
    case 'coverage':
      return {
        title: 'Coverage and limits',
        entries: [
          {
            value: 'findable_only',
            description:
              'Only Findable DOIs are public. Registered and Draft records are invisible, and a DOI in either state reads as not public.',
          },
          {
            value: 'other_agencies',
            description:
              "Other registration agencies' DOIs (Crossref, mEDRA, …) carry no DataCite metadata; they appear as relation-graph leaves and as found: false answers naming the agency.",
          },
          {
            value: 'page_ceiling',
            description:
              'Ranked page numbers reach the first 10,000 matches. cursor "*" walks any result set in full, in registration order only.',
          },
          {
            value: 'facets',
            description: 'Facets list the top 10 values per group (resource types can list more).',
          },
          {
            value: 'citation_accrual',
            description:
              'Citations accrue per DOI: a software concept DOI and each version DOI carry separate counts, and counts can trail the live record by a few events.',
          },
          {
            value: 'event_data',
            description:
              'Event Data (2026 scope) carries citation and reference links — mostly harvested from Crossref — plus parts, versions, and usage; relation tracing reads only its citation links.',
          },
          {
            value: 'relation_absence',
            description:
              'Relations exist only where depositors asserted them or a citation link was harvested; an absent edge or a zero count is not evidence that none exists.',
          },
          {
            value: 'rate_limits',
            description:
              'DataCite allows 500 requests per 5 minutes per server IP unidentified and 1,000 identified (contact email in the User-Agent). A deployment paces at 80% of its tier; when the budget is spent a call fails with RateLimited and states the seconds to wait.',
          },
        ],
        notes: [
          'DataCite metadata is CC0 1.0. The waiver covers the metadata only — the datasets, software, and papers it describes keep their own licenses, which datacite_get_work reports as work rights.',
        ],
      };
  }
}
