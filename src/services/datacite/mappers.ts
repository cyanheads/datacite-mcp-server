/**
 * @fileoverview Raw DataCite resources → tool output shapes. Absent upstream
 * values stay absent (never coerced to `''`, `0`, or `false`), except the full
 * record's `counts` block, which defaults DataCite's computed counts to zero.
 * @module services/datacite/mappers
 */

import { normalizeOrcid, normalizeRor } from './normalize.js';
import type {
  RawClientResource,
  RawCreator,
  RawDoiAttributes,
  RawDoiResource,
  RawGeoLocation,
} from './types.js';

/** A non-blank trimmed string, else `undefined`. */
export const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

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
export const publicationYear = (attributes: RawDoiAttributes): number | undefined => {
  const raw = attributes.publicationYear;
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : undefined;
  const digits = raw?.trim();
  return digits && /^\d+$/.test(digits) ? Number(digits) : undefined;
};

export const firstTitle = (attributes: RawDoiAttributes): string | undefined =>
  attributes.titles?.map((t) => text(t.title)).find((t) => t !== undefined);

const publisherName = (attributes: RawDoiAttributes): string | undefined =>
  typeof attributes.publisher === 'string'
    ? text(attributes.publisher)
    : text(attributes.publisher?.name);

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
  landingUrl?: string;
  licenses: string[];
  providerId?: string;
  publicationYear?: number;
  publisher?: string;
  repositoryId?: string;
  repositoryName?: string;
  resourceType?: string;
  resourceTypeGeneral?: string;
  title?: string;
  version?: string;
  versionCount?: number;
  viewCount?: number;
}

const SNIPPET_LENGTH = 300;

/** One `/dois` search hit as a compact row. */
export function mapWorkRow(
  record: RawDoiResource,
  clients: ReadonlyMap<string, RawClientResource>,
): WorkRow {
  const a = record.attributes;
  const clientId = record.relationships?.client?.data?.id;
  const client = clientId ? clients.get(clientId) : undefined;
  const creators = (a.creators ?? []).map((c) => text(c.name)).filter((n): n is string => !!n);
  const descriptions = a.descriptions ?? [];
  const description = text(
    (
      descriptions.find((d) => d.descriptionType === 'Abstract' && text(d.description)) ??
      descriptions.find((d) => text(d.description))
    )?.description,
  );
  const snippet =
    description && description.length > SNIPPET_LENGTH
      ? `${sliceSafe(description, SNIPPET_LENGTH).trimEnd()}…`
      : description;
  return {
    doi: (a.doi ?? record.id).toLowerCase(),
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
    licenses: (a.rightsList ?? [])
      .map((r) => text(r.rightsIdentifier))
      .filter((l): l is string => !!l),
    ...opt('citationCount', finite(a.citationCount)),
    ...opt('viewCount', finite(a.viewCount)),
    ...opt('downloadCount', finite(a.downloadCount)),
    ...opt('versionCount', finite(a.versionCount)),
    ...opt('created', text(a.created)),
    ...opt('landingUrl', text(a.url)),
    ...opt('descriptionSnippet', snippet),
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

function mapPerson(raw: RawCreator, withRole: boolean): Person | undefined {
  const name =
    text(raw.name) ?? [text(raw.givenName), text(raw.familyName)].filter(Boolean).join(' ');
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
    const affName = text(aff.name);
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
    ...opt('givenName', text(raw.givenName)),
    ...opt('familyName', text(raw.familyName)),
    ...(withRole ? opt('contributorType', text(raw.contributorType)) : {}),
    ...opt('orcid', orcid),
    otherIdentifiers,
    affiliations,
  };
}

function mapGeoLocation(raw: RawGeoLocation) {
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
  if (!place && !point && !boxOut) return;
  return { ...opt('place', place), ...opt('point', point), ...opt('box', boxOut) };
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

export interface TruncatedList {
  field: string;
  shown: number;
  total: number;
}

/** Maps a full `/dois` record to the found arm of `datacite_get_work`, with list caps applied. */
export function mapWork(record: RawDoiResource, client: RawClientResource | undefined) {
  const a = record.attributes;
  const doi = (a.doi ?? record.id).toLowerCase();
  const truncatedLists: TruncatedList[] = [];
  const cap = <T>(field: keyof typeof RECORD_LIST_CAPS, items: T[]): T[] => {
    const limit = RECORD_LIST_CAPS[field];
    if (items.length <= limit) return items;
    truncatedLists.push({ field, shown: limit, total: items.length });
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
  const relatedIdentifierCounts: Record<string, number> = {};
  for (const r of relatedIdentifiers) {
    relatedIdentifierCounts[r.relationType] = (relatedIdentifierCounts[r.relationType] ?? 0) + 1;
  }

  const contentUrls = (Array.isArray(a.contentUrl) ? a.contentUrl : [a.contentUrl])
    .map(text)
    .filter((u): u is string => !!u);
  const publisherRor =
    typeof a.publisher === 'object' &&
    a.publisher &&
    text(a.publisher.publisherIdentifierScheme)?.toUpperCase() === 'ROR'
      ? rorFromUri(a.publisher.publisherIdentifier)
      : undefined;
  const publisher = publisherName(a);
  const clientId = record.relationships?.client?.data?.id;

  const work = {
    doiUrl: `https://doi.org/${doi}`,
    ...opt('landingUrl', text(a.url)),
    ...(contentUrls.length > 0 && { contentUrls }),
    titles: (a.titles ?? []).flatMap((t) => {
      const title = text(t.title);
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
        const subject = text(s.subject);
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
        const funderName = text(f.funderName);
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
      (a.geoLocations ?? []).flatMap((g) => mapGeoLocation(g) ?? []),
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
    sizes: (a.sizes ?? []).map(text).filter((s): s is string => !!s),
    formats: (a.formats ?? []).map(text).filter((f): f is string => !!f),
    alternateIdentifiers: (a.identifiers ?? []).flatMap((i) => {
      const identifier = text(i.identifier);
      const identifierType = text(i.identifierType);
      return identifier && identifierType ? [{ identifier, identifierType }] : [];
    }),
    relatedIdentifiers: cap('relatedIdentifiers', relatedIdentifiers),
    relatedIdentifierCounts,
    relatedItems: cap(
      'relatedItems',
      (a.relatedItems ?? []).flatMap((item) => {
        const relationType = text(item.relationType);
        if (!relationType) return [];
        return [
          {
            relationType,
            ...opt('relatedItemType', text(item.relatedItemType)),
            ...opt('identifier', text(item.relatedItemIdentifier?.relatedItemIdentifier)),
            ...opt('identifierType', text(item.relatedItemIdentifier?.relatedItemIdentifierType)),
            ...opt('title', item.titles?.map((t) => text(t.title)).find(Boolean)),
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
  return { doi, work, truncatedLists };
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
    repositoryTypes: (a.repositoryType ?? []).map(text).filter((t): t is string => !!t),
    certificates: (a.certificate ?? []).map(text).filter((c): c is string => !!c),
    ...opt('software', text(a.software)),
    subjects: (a.subjects ?? []).map((s) => text(s.subject)).filter((s): s is string => !!s),
    language: (a.language ?? []).map(text).filter((l): l is string => !!l),
    ...opt('url', text(a.url)),
    ...opt('re3data', text(a.re3data)),
    ...opt('opendoar', text(a.opendoar)),
    ...opt('description', text(a.description)),
    ...opt('year', typeof a.year === 'number' ? a.year : undefined),
    ...opt('isActive', typeof a.isActive === 'boolean' ? a.isActive : undefined),
  };
}
