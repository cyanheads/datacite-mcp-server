/**
 * @fileoverview Query-string composition for `/dois` and `/repositories`: literal
 * escaping for plain text, quoted phrases, the clauses each filter becomes, the
 * DOI forms a reverse relation lookup ORs together, and the stable hash a work
 * cursor carries.
 * @module services/datacite/query-builder
 */

import { type Bbox, bboxHalves } from './bbox.js';

/**
 * Characters OpenSearch query-string syntax reserves (escaped with a backslash),
 * minus `/`: DataCite escapes `/` itself before parsing, so a pre-escaped `\/`
 * reaches the parser as `\\/`, a literal backslash followed by an unterminated regex.
 */
const RESERVED_RE = /[+\-=&|!(){}[\]^"~*?:\\]/g;

/**
 * One line break, CRLF counted once: any character a reader may split a line on.
 * That is LF, VT, FF, CR, NEL, U+2028, and U+2029 (every mandatory break in
 * Unicode line breaking, UAX #14), plus U+001C–U+001E, which Python's
 * `str.splitlines` also splits on.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: U+001C–U+001E are matched on purpose; Python's str.splitlines breaks lines on them.
const LINE_BREAK_RE = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u{2028}\u{2029}]/gu;

/** `value` with every line break as `\n`, so one split or collapse covers them all. */
export const normalizeLineBreaks = (value: string): string => value.replace(LINE_BREAK_RE, '\n');

/** Collapses each run of line breaks to one space; query syntax reads both as whitespace. */
export const singleLine = (value: string): string =>
  normalizeLineBreaks(value).replace(/\n+/g, ' ').trim();

/**
 * Plain words and phrases as a query clause that can never be a syntax error:
 * every reserved character but `/` escaped (DataCite escapes that one), `<` and
 * `>` (which cannot be escaped) removed, and standalone `AND` / `OR` / `NOT`
 * lowercased so they read as words.
 */
export function escapeQueryText(text: string): string {
  return singleLine(text)
    .replace(/[<>]/g, ' ')
    .replace(/\b(AND|OR|NOT)\b/g, (word) => word.toLowerCase())
    .replace(RESERVED_RE, (char) => `\\${char}`)
    .replace(/\s+/g, ' ')
    .trim();
}

/** A double-quoted phrase with `"` and `\` escaped. */
export const phrase = (value: string): string => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** `field:("a" OR "b" …)` over the given phrases. */
export const anyPhrase = (field: string, values: readonly string[]): string =>
  `${field}:(${values.map(phrase).join(' OR ')})`;

/**
 * Slop of a name proximity phrase. DataCite indexes consecutive values of an
 * array field (one per creator or funding reference) 100 token positions apart,
 * so any slop below 100 keeps every token inside one value; 50 still absorbs
 * reordered words, initials, and middle names.
 */
export const NAME_PROXIMITY_SLOP = 50;

/**
 * A name matched as a proximity phrase within one value of an analyzed array
 * field — `creators.name:"Carberry, Josiah"~50` — so word order and middle names
 * do not matter but tokens cannot split across two creators or two funders.
 * Inside the quotes only `"` and `\` are special.
 */
export const nameProximityClause = (field: string, name: string): string =>
  `${field}:${phrase(singleLine(name))}~${NAME_PROXIMITY_SLOP}`;

/**
 * Characters a wildcard term over a keyword field escapes: the reserved set
 * (`*` and `?` included, so a caller's wildcard characters match literally) and
 * whitespace, which would otherwise end the term. `<`, `>`, and `/` stay bare:
 * inside a term that opens with `*` none of them is syntax.
 */
const WILDCARD_ESCAPE_RE = new RegExp(`${RESERVED_RE.source}|\\s`, 'g');

/** A letter that starts a word: not after a letter, mark, digit, or apostrophe. */
const WORD_START_RE = /(?<![\p{L}\p{M}\p{N}'’])\p{L}/u;
const EVERY_WORD_START_RE = new RegExp(WORD_START_RE, 'gu');
const capitalize = (letter: string) => letter.toUpperCase();

/** The case forms a place is tried in: as typed, lower, upper, every word capitalized, first word capitalized. */
function placeCaseForms(place: string): string[] {
  const lower = place.toLowerCase();
  return [
    ...new Set([
      place,
      lower,
      place.toUpperCase(),
      lower.replace(EVERY_WORD_START_RE, capitalize),
      lower.replace(WORD_START_RE, capitalize),
    ]),
  ];
}

/**
 * Longest case form a place is matched as a substring with. OpenSearch refuses
 * to determinize a `*…*` term whose cost (about length² ÷ the period of any
 * repeat in it) passes its budget; a 500-character run of one letter fails,
 * while every form of this length passes.
 */
export const PLACE_SUBSTRING_MAX_CHARS = 250;

/** A place matched as one exact, case-sensitive deposited name. */
export const exactPlaceClause = (place: string): string =>
  `geoLocations.geoLocationPlace:${phrase(place)}`;

/**
 * A place matched in `geoLocations.geoLocationPlace`, an exact, case-sensitive
 * keyword upstream (DataCite escapes `/`, so no regex). Normally a substring
 * match: one `*…*` wildcard per distinct case form, ORed, with whitespace runs
 * as one escaped space, plus the value exactly as typed, since a deposited name
 * can hold a whitespace run or a no-break space; uppercase `AND` / `OR` / `NOT`
 * keep their case, since an escaped space makes them part of the term. A form
 * longer than {@link PLACE_SUBSTRING_MAX_CHARS} makes it {@link exactPlaceClause}
 * instead. `place` must be nonempty; an empty one would match every place.
 */
export function placeClause(place: string): { clause: string; match: 'substring' | 'exact' } {
  const forms = [...new Set([place, ...placeCaseForms(place.replace(/\s+/g, ' '))])];
  if (forms.some((form) => form.length > PLACE_SUBSTRING_MAX_CHARS)) {
    return { clause: exactPlaceClause(place), match: 'exact' };
  }
  const terms = forms.map((form) => `*${form.replace(WILDCARD_ESCAPE_RE, (char) => `\\${char}`)}*`);
  return { clause: `geoLocations.geoLocationPlace:(${terms.join(' OR ')})`, match: 'substring' };
}

/** Both stored forms of an ORCID iD, bare and as an orcid.org URL. */
export const orcidClause = (orcid: string): string =>
  anyPhrase('creators.nameIdentifiers.nameIdentifier', [orcid, `https://orcid.org/${orcid}`]);

/** Both stored forms of a Crossref Funder ID, bare and as a doi.org URL. */
export const funderIdClause = (funderId: string): string =>
  anyPhrase('fundingReferences.funderIdentifier', [funderId, `https://doi.org/${funderId}`]);

/** An affiliation name matched on creators and contributors. */
export const affiliationNameClause = (name: string): string =>
  `(creators.affiliation.name:${phrase(name)} OR contributors.affiliation.name:${phrase(name)})`;

/** `publicationYear:[from TO to]`, `*` for an open bound. */
export const yearRangeClause = (from?: number, to?: number): string =>
  `publicationYear:[${from ?? '*'} TO ${to ?? '*'}]`;

const POINT_PATH = 'geoLocations.geoLocationPoint';
const BOX_PATH = 'geoLocations.geoLocationBox';
const VERTEX_PATH = 'geoLocations.geoLocationPolygon.polygonPoint';

/**
 * Works depositing a point inside `bbox`, a box intersecting it, or a polygon
 * vertex inside it. The coordinate paths are numeric and take negative bounds
 * unescaped. A `west` greater than `east` crosses the antimeridian: point and
 * vertex longitudes match on either side of ±180, and a box matches when it
 * reaches into either part. A record's `geoLocations` are indexed as one flat
 * array, so each range can match a different location; `locationInBbox` checks
 * a row's own locations.
 */
export function bboxClause(bbox: Bbox): string {
  const { west, south, east, north } = bbox;
  const longitude = (field: string) => {
    const ranges = bboxHalves(bbox).map((half) => `${field}:[${half.west} TO ${half.east}]`);
    return ranges.length === 1 ? ranges[0] : `(${ranges.join(' OR ')})`;
  };
  const vertexIn = (path: string) =>
    `(${path}.pointLatitude:[${south} TO ${north}] AND ${longitude(`${path}.pointLongitude`)})`;
  const boxLongitude =
    west <= east
      ? `${BOX_PATH}.westBoundLongitude:[* TO ${east}] AND ${BOX_PATH}.eastBoundLongitude:[${west} TO *]`
      : `(${BOX_PATH}.eastBoundLongitude:[${west} TO *] OR ${BOX_PATH}.westBoundLongitude:[* TO ${east}])`;
  const box = `(${boxLongitude} AND ${BOX_PATH}.southBoundLatitude:[* TO ${north}] AND ${BOX_PATH}.northBoundLatitude:[${south} TO *])`;
  return `(${vertexIn(POINT_PATH)} OR ${box} OR ${vertexIn(VERTEX_PATH)})`;
}

/** The exact-DOI query `doi:"<doi>"`. */
export const doiQuery = (doi: string): string => `doi:${phrase(doi)}`;

/** A DOI in the five forms depositors store it: bare, and as http(s) doi.org / dx.doi.org URLs. */
export const doiForms = (doi: string): string[] => [
  doi,
  `https://doi.org/${doi}`,
  `http://doi.org/${doi}`,
  `https://dx.doi.org/${doi}`,
  `http://dx.doi.org/${doi}`,
];

/**
 * Records whose assertion lists point at any of `dois` in any stored form,
 * optionally narrowed to relation types (case-sensitive upstream).
 */
export function reverseRelationQuery(
  dois: readonly string[],
  relationTypes?: readonly string[],
): string {
  const forms = dois.flatMap(doiForms);
  const branch = (field: string, types: string) => {
    const target = anyPhrase(field, forms);
    return relationTypes?.length
      ? `(${target} AND ${types}:(${relationTypes.join(' OR ')}))`
      : `(${target})`;
  };
  return `(${branch('relatedIdentifiers.relatedIdentifier', 'relatedIdentifiers.relationType')} OR ${branch('relatedItems.relatedItemIdentifier.relatedItemIdentifier', 'relatedItems.relationType')})`;
}

/** ANDs clauses together; `*` when there are none. */
export const composeQuery = (clauses: readonly string[]): string =>
  clauses.length === 0 ? '*' : clauses.join(' AND ');

/**
 * A short stable hash (cyrb53) of a string — the cursor's query fingerprint. Not
 * a security boundary: it only detects a cursor replayed under another query.
 */
export function stableHash(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
