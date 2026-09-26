/**
 * @fileoverview Raw DataCite REST (JSON:API) response shapes. Every attribute is
 * optional unless the API guarantees it — records are depositor-supplied and
 * sparse.
 * @module services/datacite/types
 */

export interface RawNameIdentifier {
  nameIdentifier?: string | null;
  nameIdentifierScheme?: string | null;
  schemeUri?: string | null;
}

export interface RawAffiliation {
  affiliationIdentifier?: string | null;
  affiliationIdentifierScheme?: string | null;
  name?: string | null;
}

export interface RawCreator {
  affiliation?: RawAffiliation[] | null;
  contributorType?: string | null;
  familyName?: string | null;
  givenName?: string | null;
  name?: string | null;
  nameIdentifiers?: RawNameIdentifier[] | null;
  nameType?: string | null;
}

export interface RawTitle {
  lang?: string | null;
  title?: string | null;
  titleType?: string | null;
}

export interface RawPublisher {
  name?: string | null;
  publisherIdentifier?: string | null;
  publisherIdentifierScheme?: string | null;
}

export interface RawRelatedIdentifier {
  relatedIdentifier?: string | null;
  relatedIdentifierType?: string | null;
  relationType?: string | null;
  resourceTypeGeneral?: string | null;
}

export interface RawRelatedItem {
  relatedItemIdentifier?: {
    relatedItemIdentifier?: string | null;
    relatedItemIdentifierType?: string | null;
  } | null;
  relatedItemType?: string | null;
  relationType?: string | null;
  titles?: RawTitle[] | null;
}

export interface RawRights {
  rights?: string | null;
  rightsIdentifier?: string | null;
  rightsUri?: string | null;
}

export interface RawDescription {
  description?: string | null;
  descriptionType?: string | null;
  lang?: string | null;
}

export interface RawSubject {
  classificationCode?: string | null;
  subject?: string | null;
  subjectScheme?: string | null;
}

export interface RawDate {
  date?: string | null;
  dateInformation?: string | null;
  dateType?: string | null;
}

export interface RawFundingReference {
  awardNumber?: string | null;
  awardTitle?: string | null;
  awardUri?: string | null;
  funderIdentifier?: string | null;
  funderIdentifierType?: string | null;
  funderName?: string | null;
}

type Coordinate = number | string | null;

export interface RawGeoLocation {
  geoLocationBox?: {
    eastBoundLongitude?: Coordinate;
    northBoundLatitude?: Coordinate;
    southBoundLatitude?: Coordinate;
    westBoundLongitude?: Coordinate;
  } | null;
  geoLocationPlace?: string | null;
  geoLocationPoint?: { pointLatitude?: Coordinate; pointLongitude?: Coordinate } | null;
}

export interface RawTypes {
  resourceType?: string | null;
  resourceTypeGeneral?: string | null;
}

/** Attributes of a `dois` resource; which appear depends on `fields[dois]`. */
export interface RawDoiAttributes {
  citationCount?: number | null;
  container?: unknown;
  contentUrl?: string[] | string | null;
  contributors?: RawCreator[] | null;
  created?: string | null;
  creators?: RawCreator[] | null;
  dates?: RawDate[] | null;
  descriptions?: RawDescription[] | null;
  doi?: string | null;
  downloadCount?: number | null;
  formats?: string[] | null;
  fundingReferences?: RawFundingReference[] | null;
  geoLocations?: RawGeoLocation[] | null;
  identifiers?: Array<{ identifier?: string | null; identifierType?: string | null }> | null;
  language?: string | null;
  partCount?: number | null;
  partOfCount?: number | null;
  publicationYear?: number | string | null;
  publisher?: RawPublisher | string | null;
  referenceCount?: number | null;
  registered?: string | null;
  relatedIdentifiers?: RawRelatedIdentifier[] | null;
  relatedItems?: RawRelatedItem[] | null;
  rightsList?: RawRights[] | null;
  schemaVersion?: string | null;
  sizes?: string[] | null;
  subjects?: RawSubject[] | null;
  titles?: RawTitle[] | null;
  types?: RawTypes | null;
  updated?: string | null;
  url?: string | null;
  version?: string | null;
  versionCount?: number | null;
  versionOfCount?: number | null;
  viewCount?: number | null;
}

export interface RawRelationship {
  data?: { id: string; type: string } | null;
}

export interface RawDoiResource {
  attributes: RawDoiAttributes;
  id: string;
  relationships?: { client?: RawRelationship } | null;
  type: string;
}

export interface RawClientResource {
  attributes: {
    alternateName?: string | null;
    certificate?: string[] | null;
    clientType?: string | null;
    description?: string | null;
    isActive?: boolean | null;
    language?: string[] | null;
    name?: string | null;
    opendoar?: string | null;
    re3data?: string | null;
    repositoryType?: string[] | null;
    software?: string | null;
    subjects?: RawSubject[] | null;
    url?: string | null;
    year?: number | null;
  };
  id: string;
  relationships?: { provider?: RawRelationship } | null;
  type: string;
}

/** One facet bucket. */
export interface RawFacet {
  count: number;
  id: string;
  title?: string;
}

export interface RawDoiListMeta {
  affiliations?: RawFacet[];
  clients?: RawFacet[];
  fieldsOfScience?: RawFacet[];
  licenses?: RawFacet[];
  page?: number | null;
  providers?: RawFacet[];
  published?: RawFacet[];
  resourceTypes?: RawFacet[];
  total?: number;
}

export interface RawDoiList {
  data: RawDoiResource[];
  included?: RawClientResource[];
  links?: { next?: string | null; self?: string } | null;
  meta: RawDoiListMeta;
}

export interface RawRepositoryList {
  data: RawClientResource[];
  meta: { page?: number | null; total?: number };
}

export interface RawEvent {
  attributes: {
    'obj-id'?: string | null;
    'relation-type-id'?: string | null;
    'source-id'?: string | null;
    'subj-id'?: string | null;
  };
  id: string;
}

export interface RawEventList {
  data: RawEvent[];
  meta: { total?: number };
}
