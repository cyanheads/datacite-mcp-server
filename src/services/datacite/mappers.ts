/**
 * @fileoverview Raw DataCite resources → tool output shapes. Absent upstream
 * values stay absent (never coerced to `''`, `0`, or `false`), except the full
 * record's `counts` block, which defaults DataCite's computed counts to zero.
 * @module services/datacite/mappers
 */

import { RELATION_TYPE_IDS, type RelationTypeId } from '@/services/reference/vocabularies.js';
import { type Bbox, locationInBbox } from './bbox.js';
import { htmlToText } from './html-text.js';
import { doiUrl, normalizeOrcid, normalizeRor } from './normalize.js';
import type {
  RawClientResource,
  RawCreator,
  RawDoiAttributes,
  RawDoiResource,
  RawGeoLocation,
  RawPublisher,
} from './types.js';

/** A non-blank trimmed string, else `undefined`. */
export const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** The non-blank trimmed strings of a list, blanks and non-strings dropped. */
const texts = (values: readonly unknown[] | null | undefined): string[] =>
  (values ?? []).flatMap((value) => text(value) ?? []);

/** A record's DOI, lowercase. */
export const recordDoi = (record: RawDoiResource): string =>
  (record.attributes.doi ?? record.id).toLowerCase();

const finite = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const count = (value: number | null | undefined): number => finite(value) ?? 0;

/** Spreads `{ [key]: value }` only when `value` is defined. */
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

/** Cuts `value` to at most `limit` UTF-16 units without splitting a surrogate pair. */
function sliceSafe(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const last = value.charCodeAt(limit - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

/** An integer year, or a string of decimal digits; anything else (blank, `n.d.`, `1e3`) is absent. */
const yearOf = (raw: number | string | null | undefined): number | undefined => {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : undefined;
  const digits = raw?.trim();
  return digits && /^\d+$/.test(digits) ? Number(digits) : undefined;
};

/** The record's publication year, read as {@link yearOf} reads each related item's. */
export const publicationYear = (attributes: RawDoiAttributes): number | undefined =>
  yearOf(attributes.publicationYear);

export const firstTitle = (attributes: RawDoiAttributes): string | undefined =>
  attributes.titles?.map((t) => plainText(t.title)).find((t) => t !== undefined);

/**
 * Deposited display text as plain text: recognized formatting tags stripped,
 * character references decoded once, whitespace collapsed; blank afterwards is
 * absent. Titles, names, publishers, funders, and subject terms take it;
 * identifiers, URIs, place names (the place filter matches them exactly as
 * deposited), and descriptions do not.
 */
const plainText = (value: unknown): string | undefined =>
  typeof value === 'string' ? text(htmlToText(value)) : undefined;

/** A publisher name from its plain-string or object form: the record's and each related item's. */
const publisherText = (publisher: RawPublisher | string | null | undefined): string | undefined =>
  plainText(typeof publisher === 'string' ? publisher : publisher?.name);

const publisherName = (attributes: RawDoiAttributes): string | undefined =>
  publisherText(attributes.publisher);

const rorFromUri = (value: string | null | undefined): string | undefined =>
  value ? normalizeRor(value) : undefined;

const clientProvider = (client: RawClientResource | undefined): string | undefined =>
  client?.relationships?.provider?.data?.id;

// ─── Search rows ────────────────────────────────────────────────────────────

export interface WorkRow {
  citationCount?: number;
  created?: string;
  creatorCount: number;
  creators: string[];
  descriptionSnippet?: string;
  doi: string;
  downloadCount?: number;
  /** Set only when the search has a `bbox`: whether one of the work's own locations lies in or intersects it. */
  inBbox?: boolean;
  landingUrl?: string;
  licenses: string[];
  providerId?: string;
  publicationYear?: number;
  publisher?: string;
  repositoryId?: string;
  repositoryName?: string;
  resourceType?: string;
  resourceTypeGeneral?: string;
  /** Every deposited `rightsUri`, in deposit order; absent when the record deposits none. */
  rightsUris?: string[];
  title?: string;
  version?: string;
  versionCount?: number;
  viewCount?: number;
}

const SNIPPET_LENGTH = 300;

/** A malformed polygon has no shape to test; its row is judged by its other locations. */
const ignoreMalformedPolygon = (): void => undefined;

/**
 * One `/dois` search hit as a compact row. With `bbox`, the row also says whether
 * one of its own deposited locations lies in or intersects the box; each location
 * is parsed, tested, and dropped, so none is kept on the row.
 */
export function mapWorkRow(
  record: RawDoiResource,
  clients: ReadonlyMap<string, RawClientResource>,
  bbox?: Bbox,
): WorkRow {
  const a = record.attributes;
  const clientId = record.relationships?.client?.data?.id;
  const client = clientId ? clients.get(clientId) : undefined;
  const creators = (a.creators ?? []).flatMap((c) => plainText(c.name) ?? []);
  const descriptions = a.descriptions ?? [];
  const description = plainText(
    (
      descriptions.find((d) => d.descriptionType === 'Abstract' && text(d.description)) ??
      descriptions.find((d) => text(d.description))
    )?.description,
  );
  const snippet =
    description && description.length > SNIPPET_LENGTH
      ? `${sliceSafe(description, SNIPPET_LENGTH).trimEnd()}…`
      : description;
  const rightsUris = texts(a.rightsList?.map((r) => r.rightsUri));
  return {
    doi: recordDoi(record),
    ...opt('title', firstTitle(a)),
    creators: creators.slice(0, 5),
    creatorCount: creators.length,
    ...opt('publicationYear', publicationYear(a)),
    ...opt('resourceTypeGeneral', text(a.types?.resourceTypeGeneral)),
    ...opt('resourceType', text(a.types?.resourceType)),
    ...opt('publisher', publisherName(a)),
    ...opt('repositoryId', clientId),
    ...opt('repositoryName', text(client?.attributes.name)),
    ...opt('providerId', clientProvider(client)),
    ...opt('version', text(a.version)),
    licenses: texts(a.rightsList?.map((r) => r.rightsIdentifier)),
    ...(rightsUris.length > 0 && { rightsUris }),
    ...opt('citationCount', finite(a.citationCount)),
    ...opt('viewCount', finite(a.viewCount)),
    ...opt('downloadCount', finite(a.downloadCount)),
    ...opt('versionCount', finite(a.versionCount)),
    ...opt('created', text(a.created)),
    ...opt('landingUrl', text(a.url)),
    ...opt('descriptionSnippet', snippet),
    ...(bbox && {
      inBbox: (a.geoLocations ?? []).some((raw) => {
        const location = mapGeoLocation(raw, ignoreMalformedPolygon);
        return location !== undefined && locationInBbox(location, bbox);
      }),
    }),
  };
}

// ─── Full record ────────────────────────────────────────────────────────────

export interface Person {
  affiliations: Array<{ name: string; rorId?: string }>;
  contributorType?: string;
  familyName?: string;
  givenName?: string;
  name: string;
  nameType?: string;
  orcid?: string;
  otherIdentifiers: Array<{ identifier: string; scheme?: string }>;
}

/** A creator or contributor: its names and affiliation names as {@link plainText}, its identifiers as deposited. */
function mapPerson(raw: RawCreator, withRole: boolean): Person | undefined {
  const givenName = plainText(raw.givenName);
  const familyName = plainText(raw.familyName);
  const name = plainText(raw.name) ?? [givenName, familyName].filter(Boolean).join(' ');
  if (!name) return;
  let orcid: string | undefined;
  const otherIdentifiers: Person['otherIdentifiers'] = [];
  for (const id of raw.nameIdentifiers ?? []) {
    const identifier = text(id.nameIdentifier);
    if (!identifier) continue;
    const scheme = text(id.nameIdentifierScheme);
    const normalized = scheme?.toUpperCase() === 'ORCID' ? normalizeOrcid(identifier) : undefined;
    if (normalized && !orcid) orcid = normalized;
    else otherIdentifiers.push({ identifier, ...opt('scheme', scheme) });
  }
  const affiliations = (raw.affiliation ?? []).flatMap((aff) => {
    const affName = plainText(aff.name);
    if (!affName) return [];
    const rorId =
      text(aff.affiliationIdentifierScheme)?.toUpperCase() === 'ROR'
        ? rorFromUri(aff.affiliationIdentifier)
        : undefined;
    return [{ name: affName, ...opt('rorId', rorId) }];
  });
  return {
    name,
    ...opt('nameType', text(raw.nameType)),
    ...opt('givenName', givenName),
    ...opt('familyName', familyName),
    ...(withRole ? opt('contributorType', text(raw.contributorType)) : {}),
    ...opt('orcid', orcid),
    otherIdentifiers,
    affiliations,
  };
}

function mapGeoLocation(raw: RawGeoLocation, omitPolygon: () => void) {
  const num = (value: unknown): number | undefined => {
    if (value === null || value === undefined || value === '') return;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };
  const lat = num(raw.geoLocationPoint?.pointLatitude);
  const lon = num(raw.geoLocationPoint?.pointLongitude);
  const box = raw.geoLocationBox;
  const west = num(box?.westBoundLongitude);
  const east = num(box?.eastBoundLongitude);
  const south = num(box?.southBoundLatitude);
  const north = num(box?.northBoundLatitude);
  const place = text(raw.geoLocationPlace);
  const point =
    lat !== undefined && lon !== undefined ? { latitude: lat, longitude: lon } : undefined;
  const boxOut =
    west !== undefined && east !== undefined && south !== undefined && north !== undefined
      ? { west, east, south, north }
      : undefined;
  const coordinate = (rawPoint: { pointLatitude?: unknown; pointLongitude?: unknown }) => {
    const latitude = num(rawPoint.pointLatitude);
    const longitude = num(rawPoint.pointLongitude);
    return latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined;
  };
  let polygon:
    | {
        points: Array<{ latitude: number; longitude: number }>;
        inPolygonPoint?: { latitude: number; longitude: number };
      }
    | undefined;
  if (raw.geoLocationPolygon != null) {
    const points: Array<{ latitude: number; longitude: number }> = [];
    let inPolygonPoint: { latitude: number; longitude: number } | undefined;
    let malformed = false;
    for (const member of raw.geoLocationPolygon) {
      if (member.polygonPoint) {
        const vertex = coordinate(member.polygonPoint);
        if (vertex) points.push(vertex);
        else malformed = true;
      } else if (!member.inPolygonPoint) malformed = true;
      if (member.inPolygonPoint) {
        const interior = coordinate(member.inPolygonPoint);
        if (interior && !inPolygonPoint) inPolygonPoint = interior;
        else malformed = true;
      }
    }
    if (malformed || points.length === 0) omitPolygon();
    else polygon = { points, ...opt('inPolygonPoint', inPolygonPoint) };
  }
  if (!place && !point && !boxOut && !polygon) return;
  return {
    ...opt('place', place),
    ...opt('point', point),
    ...opt('box', boxOut),
    ...opt('polygon', polygon),
  };
}

/** Caps on the long lists of a full record; the full count is always reported. */
export const RECORD_LIST_CAPS = {
  creators: 100,
  contributors: 100,
  relatedIdentifiers: 100,
  relatedItems: 25,
  subjects: 100,
  fundingReferences: 100,
  geoLocations: 50,
} as const;

/** Where one relation type's `relatedIdentifiers` continue past the default cap. */
export interface RelationTypeContinuation {
  /** First unread offset into the entries of this type alone. */
  nextOffset: number;
  relationType: RelationTypeId;
  shown: number;
  total: number;
}

export interface TruncatedList {
  /** `relatedIdentifiers` only: each vocabulary type with entries past the cap. */
  byRelationType?: RelationTypeContinuation[];
  field: string;
  nextOffset: number;
  shown: number;
  total: number;
}

/** A selectable capped list in a deposited record. */
export type RecordList = keyof typeof RECORD_LIST_CAPS;

/** Paging of one selected list; offsets address valid mapped entries (after `relationTypes`). */
export interface RecordListPage {
  list: RecordList;
  nextOffset?: number;
  offset: number;
  /** The `relatedIdentifiers` relation types kept before paging. */
  relationTypes?: RelationTypeId[];
  total: number;
}

/** One list to page; `relationTypes` keeps the `relatedIdentifiers` entries asserting those types. */
export interface RecordListSelection {
  list: RecordList;
  offset: number;
  relationTypes?: readonly RelationTypeId[];
}

const RELATION_TYPE_SET: ReadonlySet<string> = new Set(RELATION_TYPE_IDS);
const isRelationTypeId = (type: string): type is RelationTypeId => RELATION_TYPE_SET.has(type);

/** Entries per relation type. A Map: relationType is depositor text, and a plain object would read `constructor` off its prototype. */
function countRelationTypes(entries: readonly { relationType: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { relationType } of entries) {
    counts.set(relationType, (counts.get(relationType) ?? 0) + 1);
  }
  return counts;
}

/** Maps a full `/dois` record to the found arm of `datacite_get_work`, with list caps applied. */
export function mapWork(
  record: RawDoiResource,
  client: RawClientResource | undefined,
  selection?: RecordListSelection,
) {
  const a = record.attributes;
  const doi = recordDoi(record);
  const truncatedLists: TruncatedList[] = [];
  let omittedGeoLocationPolygons = 0;
  let listPage: RecordListPage | undefined;
  const cap = <T>(field: keyof typeof RECORD_LIST_CAPS, items: T[]): T[] => {
    const limit = RECORD_LIST_CAPS[field];
    if (selection?.list === field) {
      const offset = selection.offset;
      const page = items.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      listPage = {
        list: field,
        ...(field === 'relatedIdentifiers' &&
          selection.relationTypes && { relationTypes: [...selection.relationTypes] }),
        offset,
        total: items.length,
        ...(nextOffset < items.length && { nextOffset }),
      };
      return page;
    }
    if (items.length <= limit) return items;
    truncatedLists.push({ field, shown: limit, total: items.length, nextOffset: limit });
    return items.slice(0, limit);
  };

  const relatedIdentifiers = (a.relatedIdentifiers ?? []).flatMap((r) => {
    const relationType = text(r.relationType);
    const relatedIdentifier = text(r.relatedIdentifier);
    if (!relationType || !relatedIdentifier) return [];
    return [
      {
        relationType,
        relatedIdentifier,
        ...opt('relatedIdentifierType', text(r.relatedIdentifierType)),
        ...opt('resourceTypeGeneral', text(r.resourceTypeGeneral)),
      },
    ];
  });
  const relationCounts = countRelationTypes(relatedIdentifiers);
  // Matched exactly: the upstream stores relationType case-sensitively, as relatedIdentifierCounts keys it.
  const relationFilter = selection?.relationTypes && new Set<string>(selection.relationTypes);

  const contentUrls = texts(Array.isArray(a.contentUrl) ? a.contentUrl : [a.contentUrl]);
  const publisherRor =
    typeof a.publisher === 'object' &&
    a.publisher &&
    text(a.publisher.publisherIdentifierScheme)?.toUpperCase() === 'ROR'
      ? rorFromUri(a.publisher.publisherIdentifier)
      : undefined;
  const publisher = publisherName(a);
  const clientId = record.relationships?.client?.data?.id;

  const work = {
    doiUrl: doiUrl(doi),
    ...opt('landingUrl', text(a.url)),
    ...(contentUrls.length > 0 && { contentUrls }),
    titles: (a.titles ?? []).flatMap((t) => {
      const title = plainText(t.title);
      return title
        ? [{ title, ...opt('titleType', text(t.titleType)), ...opt('lang', text(t.lang)) }]
        : [];
    }),
    creators: cap(
      'creators',
      (a.creators ?? []).flatMap((c) => mapPerson(c, false) ?? []),
    ),
    contributors: cap(
      'contributors',
      (a.contributors ?? []).flatMap((c) => mapPerson(c, true) ?? []),
    ),
    ...(publisher && { publisher: { name: publisher, ...opt('rorId', publisherRor) } }),
    ...opt('publicationYear', publicationYear(a)),
    ...opt('resourceTypeGeneral', text(a.types?.resourceTypeGeneral)),
    ...opt('resourceType', text(a.types?.resourceType)),
    ...opt('version', text(a.version)),
    ...opt('language', text(a.language)),
    dates: (a.dates ?? []).flatMap((d) => {
      const date = text(d.date);
      const dateType = text(d.dateType);
      return date && dateType
        ? [{ date, dateType, ...opt('dateInformation', text(d.dateInformation)) }]
        : [];
    }),
    subjects: cap(
      'subjects',
      (a.subjects ?? []).flatMap((s) => {
        const subject = plainText(s.subject);
        return subject
          ? [
              {
                subject,
                ...opt('scheme', text(s.subjectScheme)),
                ...opt('classificationCode', text(s.classificationCode)),
              },
            ]
          : [];
      }),
    ),
    descriptions: (a.descriptions ?? []).flatMap((d) => {
      const description = text(d.description);
      return description
        ? [
            {
              description,
              ...opt('descriptionType', text(d.descriptionType)),
              ...opt('lang', text(d.lang)),
            },
          ]
        : [];
    }),
    fundingReferences: cap(
      'fundingReferences',
      (a.fundingReferences ?? []).flatMap((f) => {
        const funderName = plainText(f.funderName);
        return funderName
          ? [
              {
                funderName,
                ...opt('funderIdentifier', text(f.funderIdentifier)),
                ...opt('funderIdentifierType', text(f.funderIdentifierType)),
                ...opt('awardNumber', text(f.awardNumber)),
                ...opt('awardTitle', text(f.awardTitle)),
                ...opt('awardUri', text(f.awardUri)),
              },
            ]
          : [];
      }),
    ),
    geoLocations: cap(
      'geoLocations',
      (a.geoLocations ?? []).flatMap(
        (g) =>
          mapGeoLocation(g, () => {
            omittedGeoLocationPolygons++;
          }) ?? [],
      ),
    ),
    rights: (a.rightsList ?? []).flatMap((r) => {
      const entry = {
        ...opt('rights', text(r.rights)),
        ...opt('rightsUri', text(r.rightsUri)),
        ...opt('rightsIdentifier', text(r.rightsIdentifier)),
      };
      return Object.keys(entry).length > 0 ? [entry] : [];
    }),
    metadataLicense: 'CC0-1.0' as const,
    sizes: texts(a.sizes),
    formats: texts(a.formats),
    alternateIdentifiers: (a.identifiers ?? []).flatMap((i) => {
      const identifier = text(i.identifier);
      const identifierType = text(i.identifierType);
      return identifier && identifierType ? [{ identifier, identifierType }] : [];
    }),
    relatedIdentifiers: cap(
      'relatedIdentifiers',
      relationFilter
        ? relatedIdentifiers.filter((r) => relationFilter.has(r.relationType))
        : relatedIdentifiers,
    ),
    relatedIdentifierCounts: Object.fromEntries(relationCounts),
    relatedItems: cap(
      'relatedItems',
      (a.relatedItems ?? []).flatMap((item) => {
        const relationType = text(item.relationType);
        if (!relationType) return [];
        const creators = (item.creators ?? []).flatMap((c) => mapPerson(c, false) ?? []);
        const contributors = (item.contributors ?? []).flatMap((c) => mapPerson(c, true) ?? []);
        return [
          {
            relationType,
            ...opt('relatedItemType', text(item.relatedItemType)),
            ...opt('identifier', text(item.relatedItemIdentifier?.relatedItemIdentifier)),
            ...opt('identifierType', text(item.relatedItemIdentifier?.relatedItemIdentifierType)),
            ...opt('title', item.titles?.map((t) => plainText(t.title)).find(Boolean)),
            ...opt('volume', text(item.volume)),
            ...opt('issue', text(item.issue)),
            ...opt('number', text(item.number)),
            ...opt('numberType', text(item.numberType)),
            ...opt('firstPage', text(item.firstPage)),
            ...opt('lastPage', text(item.lastPage)),
            ...opt('edition', text(item.edition)),
            ...opt('publisher', publisherText(item.publisher)),
            ...opt('publicationYear', yearOf(item.publicationYear)),
            ...(creators.length > 0 && { creators }),
            ...(contributors.length > 0 && { contributors }),
          },
        ];
      }),
    ),
    counts: {
      citationCount: count(a.citationCount),
      referenceCount: count(a.referenceCount),
      versionCount: count(a.versionCount),
      versionOfCount: count(a.versionOfCount),
      partCount: count(a.partCount),
      partOfCount: count(a.partOfCount),
      viewCount: count(a.viewCount),
      downloadCount: count(a.downloadCount),
    },
    ...(clientId && {
      repository: {
        repositoryId: clientId,
        ...opt('name', text(client?.attributes.name)),
        ...opt('providerId', clientProvider(client)),
      },
    }),
    ...opt('registered', text(a.registered)),
    ...opt('created', text(a.created)),
    ...opt('updated', text(a.updated)),
    ...opt('schemaVersion', text(a.schemaVersion)),
  };
  /**
   * The capped prefix holds the first `shown` entries of each type in deposit order, so
   * `relation_types: [type]` from offset `shown` continues that type without a repeat or a gap.
   * A deposited type outside the vocabulary gets none: the input would not accept it.
   */
  const capped = truncatedLists.find((t) => t.field === 'relatedIdentifiers');
  if (capped) {
    const shownCounts = countRelationTypes(work.relatedIdentifiers);
    const byRelationType = [...relationCounts].flatMap(([relationType, total]) => {
      const shown = shownCounts.get(relationType) ?? 0;
      return shown < total && isRelationTypeId(relationType)
        ? [{ relationType, shown, total, nextOffset: shown }]
        : [];
    });
    if (byRelationType.length > 0) capped.byRelationType = byRelationType;
  }
  return { doi, work, truncatedLists, listPage, omittedGeoLocationPolygons };
}

// ─── Repositories ───────────────────────────────────────────────────────────

/** One `/repositories` account. */
export function mapRepository(resource: RawClientResource) {
  const a = resource.attributes;
  return {
    repositoryId: resource.id,
    name: text(a.name) ?? resource.id,
    ...opt('alternateName', text(a.alternateName)),
    ...opt('providerId', resource.relationships?.provider?.data?.id),
    ...opt('clientType', text(a.clientType)),
    repositoryTypes: texts(a.repositoryType),
    certificates: texts(a.certificate),
    ...opt('software', text(a.software)),
    subjects: texts(a.subjects?.map((s) => s.subject)),
    language: texts(a.language),
    ...opt('url', text(a.url)),
    ...opt('re3data', text(a.re3data)),
    ...opt('opendoar', text(a.opendoar)),
    ...opt('description', text(a.description)),
    ...opt('year', typeof a.year === 'number' ? a.year : undefined),
    ...opt('isActive', typeof a.isActive === 'boolean' ? a.isActive : undefined),
  };
}
