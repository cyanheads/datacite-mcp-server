/**
 * @fileoverview DataCite `/dois` query-string field paths — the ones verified live
 * (listed to callers) and the wider set treated as known when checking a
 * zero-hit query for a `word:` prefix that names no field.
 * @module services/reference/query-syntax
 */

/** The deposited-coordinate paths, each verified live as a numeric range field: what each holds, and a range on it. */
const COORDINATE_FIELDS = [
  ['geoLocations.geoLocationPoint.pointLatitude', 'Point latitude', '[-20 TO -15]'],
  ['geoLocations.geoLocationPoint.pointLongitude', 'Point longitude', '[-115.5 TO -105.5]'],
  [
    'geoLocations.geoLocationBox.westBoundLongitude',
    'Box western edge, a longitude',
    '[* TO -105.5]',
  ],
  [
    'geoLocations.geoLocationBox.eastBoundLongitude',
    'Box eastern edge, a longitude',
    '[-115.5 TO *]',
  ],
  ['geoLocations.geoLocationBox.southBoundLatitude', 'Box southern edge, a latitude', '[* TO -15]'],
  ['geoLocations.geoLocationBox.northBoundLatitude', 'Box northern edge, a latitude', '[-20 TO *]'],
  [
    'geoLocations.geoLocationPolygon.polygonPoint.pointLatitude',
    'Polygon vertex latitude',
    '[-20 TO -15]',
  ],
  [
    'geoLocations.geoLocationPolygon.polygonPoint.pointLongitude',
    'Polygon vertex longitude',
    '[-115.5 TO -105.5]',
  ],
] as const;

/** Why coordinate clauses ANDed together can match across locations: `geoLocations` is not a nested field upstream. */
const FLAT_ARRAY_CAVEAT =
  "A work's locations are indexed as one flat list, so clauses ANDed on two coordinate paths can each match a different location or polygon vertex; datacite_search_works bbox flags such works with inBbox false.";

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
  {
    value: 'rightsList.rightsUri',
    description:
      'License or rights URI exactly as deposited, case-sensitive; the licenses filter reads only rightsIdentifier. Wildcards match a substring, so one path covers http and https, deed and legalcode forms (rightsList.rightsUri:*creativecommons.org/licenses/by/4.0*).',
  },
  {
    value: 'geoLocations.geoLocationPlace',
    description:
      'Place name exactly as deposited, case-sensitive: "Svalbard" matches neither "svalbard" nor "Svalbard, Norway". Wildcards match a substring, with spaces escaped (geoLocations.geoLocationPlace:*Gulf\\ of\\ Mexico*).',
  },
  ...COORDINATE_FIELDS.map(([value, what, range]) => ({
    value,
    description: `${what} in decimal degrees, numeric: ranges take negative bounds unescaped (${value}:${range}). ${FLAT_ARRAY_CAVEAT}`,
  })),
  { value: 'language', description: 'ISO 639-1 language code.' },
  { value: 'publicationYear', description: 'Year; ranges as publicationYear:[2020 TO 2022].' },
  {
    value: 'created',
    description: 'Record creation timestamp; ranges as created:[2026-10-16 TO *].',
  },
  {
    value: 'updated',
    description: 'Metadata update timestamp; ranges as updated:[2026-10-16 TO *].',
  },
  {
    value: 'registered',
    description: 'DOI registration timestamp; ranges as registered:[2026-10-16 TO *].',
  },
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
  // OpenSearch's field-existence query, _exists_:<field path>.
  '_exists_',
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
  // The related-item paths datacite_trace_relations queries for reverse relations.
  'relatedItems.relatedItemIdentifier.relatedItemIdentifier',
  'relatedItems.relationType',
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
 * `query` with each double-quoted phrase replaced by a space, in one pass: a
 * backslash escapes the character after it, and a quote that never closes
 * leaves the rest of the query as written. A phrase regex would rescan the
 * tail from every escaped quote after an unclosed one, quadratic in its length.
 */
function blankQuotedPhrases(query: string): string {
  let result = '';
  let kept = 0;
  let open = query.indexOf('"');
  while (open !== -1) {
    let at = open + 1;
    while (at < query.length && query[at] !== '"') at += query[at] === '\\' ? 2 : 1;
    if (at >= query.length) break;
    result += `${query.slice(kept, open)} `;
    kept = at + 1;
    open = query.indexOf('"', kept);
  }
  return result + query.slice(kept);
}

/**
 * The first `word:` prefix in a caller query that names no known field, ignoring
 * quoted phrases, escaped colons, and URL schemes.
 */
export function unknownFieldPrefix(query: string): string | undefined {
  const unquoted = blankQuotedPhrases(query);
  for (const match of unquoted.matchAll(/(?:^|[\s(+!-])([A-Za-z_][\w.]*):(?!\/\/)/g)) {
    const field = match[1] as string;
    if (!KNOWN_QUERY_FIELDS.has(field)) return field;
  }
  return;
}
