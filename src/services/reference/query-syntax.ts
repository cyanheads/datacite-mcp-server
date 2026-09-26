/**
 * @fileoverview DataCite `/dois` query-string field paths — the ones verified live
 * (listed to callers) and the wider set treated as known when checking a
 * zero-hit query for a `word:` prefix that names no field.
 * @module services/reference/query-syntax
 */

/** Field paths verified live against `/dois`, with what each matches. */
export const VERIFIED_QUERY_FIELDS: ReadonlyArray<{ description: string; value: string }> = [
  { value: 'titles.title', description: 'Title text (analyzed).' },
  { value: 'creators.name', description: 'Creator name, "Family, Given" as deposited.' },
  {
    value: 'creators.nameIdentifiers.nameIdentifier',
    description: 'Creator identifier as stored — an ORCID iD bare or as an orcid.org URL.',
  },
  { value: 'creators.affiliation.name', description: 'Creator affiliation name.' },
  { value: 'contributors.name', description: 'Contributor name.' },
  { value: 'publisher.name', description: 'Publisher name.' },
  { value: 'subjects.subject', description: 'Subject keyword or classification label (analyzed).' },
  { value: 'descriptions.description', description: 'Abstract and other descriptions.' },
  { value: 'fundingReferences.funderName', description: 'Funder name.' },
  { value: 'fundingReferences.awardNumber', description: 'Grant or award number.' },
  { value: 'geoLocations.geoLocationPlace', description: 'Free-text place name.' },
  { value: 'language', description: 'ISO 639-1 language code.' },
  { value: 'publicationYear', description: 'Year; ranges as publicationYear:[2020 TO 2022].' },
  { value: 'types.resourceTypeGeneral', description: 'resourceTypeGeneral, e.g. Dataset.' },
  {
    value: 'relatedIdentifiers.relatedIdentifier',
    description: 'A related identifier exactly as stored (bare DOI or a doi.org URL).',
  },
  {
    value: 'relatedIdentifiers.relationType',
    description: 'Relation type — case-sensitive (IsSupplementTo, not issupplementto).',
  },
  { value: 'citationCount', description: 'Citation count; ranges as citationCount:[10 TO *].' },
  { value: 'doi', description: 'The DOI, lowercase.' },
];

/** Field paths recognized when deciding whether a zero-hit query named a nonexistent field. */
export const KNOWN_QUERY_FIELDS = new Set([
  ...VERIFIED_QUERY_FIELDS.map((field) => field.value),
  'contributors.affiliation.name',
  'contributors.contributorType',
  'contributors.nameIdentifiers.nameIdentifier',
  'creators.affiliation.affiliationIdentifier',
  'creators.familyName',
  'creators.givenName',
  'creators.nameType',
  'dates.date',
  'dates.dateType',
  'descriptions.descriptionType',
  'formats',
  'fundingReferences.awardTitle',
  'fundingReferences.funderIdentifier',
  'identifiers.identifier',
  'identifiers.identifierType',
  'relatedIdentifiers.relatedIdentifierType',
  'rightsList.rights',
  'rightsList.rightsIdentifier',
  'sizes',
  'subjects.subjectScheme',
  'types.resourceType',
  'url',
  'version',
  'viewCount',
  'downloadCount',
  'created',
  'updated',
  'registered',
  'published',
]);

/**
 * The first `word:` prefix in a caller query that names no known field, ignoring
 * quoted phrases, escaped colons, and URL schemes.
 */
export function unknownFieldPrefix(query: string): string | undefined {
  const unquoted = query.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  for (const match of unquoted.matchAll(/(?:^|[\s(+!-])([A-Za-z_][\w.]*):(?!\/\/)/g)) {
    const field = match[1] as string;
    if (!KNOWN_QUERY_FIELDS.has(field)) return field;
  }
  return;
}
