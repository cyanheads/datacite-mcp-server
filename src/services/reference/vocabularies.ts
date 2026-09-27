/**
 * @fileoverview Static DataCite vocabularies: resource types, relation types with
 * their inverses and groups, related-identifier, date, and contributor types,
 * repository types, certificates, client types, software platforms, common
 * license ids, ISO 639-1 language codes, and search sort orders. Read by the
 * input canonicalizers and by `datacite_list_reference`.
 * @module services/reference/vocabularies
 */

import { buildResolver } from './lookup.js';

/** The 34 resourceTypeGeneral values present in the index, as the `resource-type-id` filter spells them. */
export const RESOURCE_TYPE_IDS = [
  'audiovisual',
  'award',
  'book',
  'book-chapter',
  'collection',
  'computational-notebook',
  'conference-paper',
  'conference-proceeding',
  'data-paper',
  'dataset',
  'dissertation',
  'event',
  'image',
  'instrument',
  'interactive-resource',
  'journal',
  'journal-article',
  'model',
  'other',
  'output-management-plan',
  'peer-review',
  'physical-object',
  'poster',
  'preprint',
  'presentation',
  'project',
  'report',
  'service',
  'software',
  'sound',
  'standard',
  'study-registration',
  'text',
  'workflow',
] as const;
export type ResourceTypeId = (typeof RESOURCE_TYPE_IDS)[number];

/** PascalCase resourceTypeGeneral label for a kebab id (`journal-article` → `JournalArticle`). */
export const resourceTypeLabel = (id: string): string =>
  id.replace(/(^|-)([a-z])/g, (_match, _sep: string, letter: string) => letter.toUpperCase());

export const resolveResourceType = buildResolver(RESOURCE_TYPE_IDS.map((id) => ({ id })));

/** Relation-type groups, in display order. */
export type RelationGroup =
  | 'versions'
  | 'parts'
  | 'citations'
  | 'derivation'
  | 'documentation'
  | 'other';

interface RelationTypeEntry {
  group: RelationGroup;
  id: string;
  inverse?: string;
  note?: string;
}

const RELATION_TYPE_TABLE = [
  { id: 'HasVersion', inverse: 'IsVersionOf', group: 'versions' },
  { id: 'IsVersionOf', inverse: 'HasVersion', group: 'versions' },
  { id: 'IsNewVersionOf', inverse: 'IsPreviousVersionOf', group: 'versions' },
  { id: 'IsPreviousVersionOf', inverse: 'IsNewVersionOf', group: 'versions' },
  { id: 'HasPart', inverse: 'IsPartOf', group: 'parts' },
  { id: 'IsPartOf', inverse: 'HasPart', group: 'parts' },
  { id: 'Cites', inverse: 'IsCitedBy', group: 'citations' },
  { id: 'IsCitedBy', inverse: 'Cites', group: 'citations' },
  { id: 'References', inverse: 'IsReferencedBy', group: 'citations' },
  { id: 'IsReferencedBy', inverse: 'References', group: 'citations' },
  { id: 'IsSupplementTo', inverse: 'IsSupplementedBy', group: 'citations' },
  { id: 'IsSupplementedBy', inverse: 'IsSupplementTo', group: 'citations' },
  { id: 'IsDerivedFrom', inverse: 'IsSourceOf', group: 'derivation' },
  { id: 'IsSourceOf', inverse: 'IsDerivedFrom', group: 'derivation' },
  { id: 'Documents', inverse: 'IsDocumentedBy', group: 'documentation' },
  { id: 'IsDocumentedBy', inverse: 'Documents', group: 'documentation' },
  { id: 'Describes', inverse: 'IsDescribedBy', group: 'documentation' },
  { id: 'IsDescribedBy', inverse: 'Describes', group: 'documentation' },
  { id: 'HasMetadata', inverse: 'IsMetadataFor', group: 'documentation' },
  { id: 'IsMetadataFor', inverse: 'HasMetadata', group: 'documentation' },
  { id: 'Continues', inverse: 'IsContinuedBy', group: 'other' },
  { id: 'IsContinuedBy', inverse: 'Continues', group: 'other' },
  { id: 'Compiles', inverse: 'IsCompiledBy', group: 'other' },
  { id: 'IsCompiledBy', inverse: 'Compiles', group: 'other' },
  { id: 'IsVariantFormOf', inverse: 'IsOriginalFormOf', group: 'other' },
  { id: 'IsOriginalFormOf', inverse: 'IsVariantFormOf', group: 'other' },
  { id: 'IsIdenticalTo', inverse: 'IsIdenticalTo', group: 'other' },
  { id: 'Reviews', inverse: 'IsReviewedBy', group: 'other' },
  { id: 'IsReviewedBy', inverse: 'Reviews', group: 'other' },
  { id: 'Requires', inverse: 'IsRequiredBy', group: 'other' },
  { id: 'IsRequiredBy', inverse: 'Requires', group: 'other' },
  { id: 'Obsoletes', inverse: 'IsObsoletedBy', group: 'other' },
  { id: 'IsObsoletedBy', inverse: 'Obsoletes', group: 'other' },
  { id: 'Collects', inverse: 'IsCollectedBy', group: 'other' },
  { id: 'IsCollectedBy', inverse: 'Collects', group: 'other' },
  { id: 'HasTranslation', inverse: 'IsTranslationOf', group: 'other' },
  { id: 'IsTranslationOf', inverse: 'HasTranslation', group: 'other' },
  { id: 'IsPublishedIn', group: 'other', note: 'No inverse in the schema.' },
  {
    id: 'Other',
    group: 'other',
    note: 'Not a schema value; seen in a handful of records.',
  },
] as const satisfies readonly RelationTypeEntry[];

/** The DataCite schema relationTypes plus the non-schema `Other`, each with its inverse and group. */
export const RELATION_TYPES: readonly RelationTypeEntry[] = RELATION_TYPE_TABLE;

export type RelationTypeId = (typeof RELATION_TYPE_TABLE)[number]['id'];
export const RELATION_TYPE_IDS = RELATION_TYPE_TABLE.map((entry) => entry.id) as [
  RelationTypeId,
  ...RelationTypeId[],
];

const INVERSES = new Map(RELATION_TYPES.map((entry) => [entry.id, entry.inverse ?? entry.id]));

/** The type the other side of a relation asserts (`HasPart` → `IsPartOf`); a type with no inverse is its own. */
export const inverseRelationType = (id: string): string => INVERSES.get(id) ?? id;

export const resolveRelationType = buildResolver(RELATION_TYPE_IDS.map((id) => ({ id })));

/** The relation types Event Data carries (the citation family). */
export const CITATION_RELATION_TYPES: readonly RelationTypeId[] = [
  'Cites',
  'IsCitedBy',
  'References',
  'IsReferencedBy',
  'IsSupplementTo',
  'IsSupplementedBy',
];

/** Kebab form Event Data uses (`IsCitedBy` → `is-cited-by`). */
export const relationTypeKebab = (id: string): string =>
  id.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

/** related-identifier types of the current DataCite schema. */
export const IDENTIFIER_TYPES = [
  'ARK',
  'arXiv',
  'bibcode',
  'CSTR',
  'DOI',
  'EAN13',
  'EISSN',
  'Handle',
  'IGSN',
  'ISBN',
  'ISSN',
  'ISTC',
  'LISSN',
  'LSID',
  'PMID',
  'PURL',
  'RAiD',
  'RRID',
  'SWHID',
  'UPC',
  'URL',
  'URN',
  'w3id',
] as const;

export const DATE_TYPES = [
  'Accepted',
  'Available',
  'Collected',
  'Copyrighted',
  'Coverage',
  'Created',
  'Issued',
  'Other',
  'Submitted',
  'Updated',
  'Valid',
  'Withdrawn',
] as const;

export const CONTRIBUTOR_TYPES = [
  'ContactPerson',
  'DataCollector',
  'DataCurator',
  'DataManager',
  'Distributor',
  'Editor',
  'HostingInstitution',
  'Other',
  'Producer',
  'ProjectLeader',
  'ProjectManager',
  'ProjectMember',
  'RegistrationAgency',
  'RegistrationAuthority',
  'RelatedPerson',
  'Researcher',
  'ResearchGroup',
  'RightsHolder',
  'Sponsor',
  'Supervisor',
  'Translator',
  'WorkPackageLeader',
] as const;

/** `/repositories` `repository-type` values (exact lowercase upstream). */
export const REPOSITORY_TYPE_IDS = [
  'institutional',
  'disciplinary',
  'multidisciplinary',
  'project-related',
  'governmental',
  'other',
] as const;
export const resolveRepositoryType = buildResolver(REPOSITORY_TYPE_IDS.map((id) => ({ id })));

/** `/repositories` `certificate` values (exact-case upstream). */
export const CERTIFICATE_IDS = [
  'CoreTrustSeal',
  'WDS',
  'DSA',
  'DINI',
  'RatSWD',
  'CLARIN',
  'DIN 31644',
] as const;
export const resolveCertificate = buildResolver(CERTIFICATE_IDS.map((id) => ({ id })));

/** `/repositories` `client-type` values. */
export const CLIENT_TYPE_IDS = ['repository', 'periodical', 'igsnCatalog', 'raidRegistry'] as const;
export const CLIENT_TYPE_LABELS: Record<(typeof CLIENT_TYPE_IDS)[number], string> = {
  repository: 'Repository',
  periodical: 'Periodical',
  igsnCatalog: 'IGSN ID Catalog',
  raidRegistry: 'RAiD Registry',
};
export const resolveClientType = buildResolver(
  CLIENT_TYPE_IDS.map((id) => ({ id, aliases: [CLIENT_TYPE_LABELS[id]] })),
);

/** Observed repository software slugs; the upstream vocabulary is free-form. */
export const SOFTWARE_PLATFORMS: ReadonlyArray<{ label: string; value: string }> = [
  { value: 'dataverse', label: 'Dataverse' },
  { value: 'dspace', label: 'DSpace' },
  { value: 'invenio', label: 'Invenio' },
  { value: 'ckan', label: 'CKAN' },
  { value: 'eprints', label: 'EPrints' },
  { value: 'opus', label: 'OPUS' },
  { value: 'pure', label: 'Pure' },
  { value: 'figshare', label: 'Figshare' },
  { value: 'islandora', label: 'Islandora' },
  { value: 'fedora', label: 'Fedora' },
  { value: 'samvera', label: 'Samvera' },
  { value: 'mycore', label: 'MyCoRe' },
  { value: 'open_journal_systems_ojs', label: 'Open Journal Systems (OJS)' },
  { value: 'other', label: 'Other' },
];

/** Common lowercase SPDX-style license ids in the index; not exhaustive. */
export const LICENSES: ReadonlyArray<{ label: string; value: string }> = [
  { value: 'cc-by-4.0', label: 'Creative Commons Attribution 4.0' },
  { value: 'cc0-1.0', label: 'Creative Commons Zero 1.0 (public domain dedication)' },
  { value: 'cc-by-nc-4.0', label: 'Creative Commons Attribution-NonCommercial 4.0' },
  { value: 'cc-by-sa-4.0', label: 'Creative Commons Attribution-ShareAlike 4.0' },
  { value: 'cc-by-nc-sa-4.0', label: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0' },
  {
    value: 'cc-by-nc-nd-4.0',
    label: 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0',
  },
  { value: 'cc-by-nd-4.0', label: 'Creative Commons Attribution-NoDerivatives 4.0' },
  { value: 'cc-by-3.0', label: 'Creative Commons Attribution 3.0' },
  { value: 'cc-by-nc-3.0', label: 'Creative Commons Attribution-NonCommercial 3.0' },
  { value: 'cc-by-sa-3.0', label: 'Creative Commons Attribution-ShareAlike 3.0' },
  { value: 'cc-by-nc-sa-3.0', label: 'Creative Commons Attribution-NonCommercial-ShareAlike 3.0' },
  { value: 'mit', label: 'MIT License' },
  { value: 'apache-2.0', label: 'Apache License 2.0' },
  { value: 'bsd-3-clause', label: 'BSD 3-Clause License' },
  { value: 'odbl-1.0', label: 'Open Data Commons Open Database License 1.0' },
  { value: 'notspecified', label: 'DataCite: no license specified' },
  { value: 'pdm', label: 'DataCite: Public Domain Mark' },
];

/** ISO 639-1 two-letter language codes. */
export const ISO_639_1 = new Set(
  (
    'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy ' +
    'da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu ' +
    'hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb ' +
    'lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om ' +
    'or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ' +
    'ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'
  ).split(' '),
);

/** Search sort orders and the upstream `sort` value each sends. */
export const SORT_ORDERS = {
  relevance: 'relevance',
  newest: '-created',
  oldest: 'created',
  recently_updated: '-updated',
  most_cited: '-citation-count',
  most_viewed: '-view-count',
  most_downloaded: '-download-count',
} as const;
export type SortOrder = keyof typeof SORT_ORDERS;
export const SORT_ORDER_IDS = Object.keys(SORT_ORDERS) as [SortOrder, ...SortOrder[]];
