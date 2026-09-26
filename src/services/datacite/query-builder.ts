/**
 * @fileoverview Query-string composition for `/dois` and `/repositories`: literal
 * escaping for plain text, quoted phrases, the clauses each filter becomes, the
 * DOI forms a reverse relation lookup ORs together, and the stable hash a work
 * cursor carries.
 * @module services/datacite/query-builder
 */

/** Characters OpenSearch query-string syntax reserves (escaped with a backslash). */
const RESERVED_RE = /[+\-=&|!(){}[\]^"~*?:\\/]/g;

/** Any line break, including the Unicode line and paragraph separators. */
const LINE_BREAK_RE = /[\r\n\p{Zl}\p{Zp}]+/gu;

/** Collapses line breaks to a space; query syntax reads both as whitespace. */
export const singleLine = (value: string): string => value.replace(LINE_BREAK_RE, ' ').trim();

/**
 * Plain words and phrases as a query clause that can never be a syntax error:
 * every reserved character escaped, `<` and `>` (which cannot be escaped)
 * removed, and standalone `AND` / `OR` / `NOT` lowercased so they read as words.
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
 * A name matched token by token within one field — `creators.name:(smith AND j)`
 * — so word order and initials do not matter.
 */
export function nameTokensClause(field: string, name: string): string {
  const tokens = escapeQueryText(name.replace(/,/g, ' ')).split(' ').filter(Boolean);
  return `${field}:(${tokens.join(' AND ')})`;
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
 * Records whose `relatedIdentifiers` point at any of `dois` in any stored form,
 * optionally narrowed to relation types (case-sensitive upstream).
 */
export function reverseRelationQuery(
  dois: readonly string[],
  relationTypes?: readonly string[],
): string {
  const target = anyPhrase('relatedIdentifiers.relatedIdentifier', dois.flatMap(doiForms));
  return relationTypes?.length
    ? `${target} AND relatedIdentifiers.relationType:(${relationTypes.join(' OR ')})`
    : target;
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
