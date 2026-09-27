/**
 * @fileoverview Identifier normalizers for the checks finer than a schema
 * pattern: DOI, ORCID iD, ROR ID, Crossref Funder ID, and ISO 639-1 language.
 * Each normalizes what is certain (case, prefixes, URL forms) and reports what
 * is not as `undefined`, leaving the caller to raise its typed reason. Also
 * builds a DOI's doi.org URL, the inverse of reading one.
 * @module services/datacite/normalize
 */

import { ISO_639_1 } from '@/services/reference/vocabularies.js';

const DOI_RE = /^10\.\d{4,9}\/\S+$/;
const DOI_URL_PREFIX_RE = /^https?:\/\/(?:dx\.)?doi\.org\//i;
const ROR_RE = /^0[a-z0-9]{6}\d{2}$/;
const ROR_PREFIX_RE = /^(?:https?:\/\/)?(?:www\.)?ror\.org\//i;
const ORCID_PREFIX_RE = /^(?:https?:\/\/)?(?:www\.)?orcid\.org\//i;
const ORCID_SHAPE_RE = /^\d{4}-?\d{4}-?\d{4}-?\d{3}[\dXx]$/;
const FUNDER_PREFIX = '10.13039/';

function decodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * A DOI in its canonical form — trimmed, `doi:` / `info:doi/` / doi.org URL
 * prefix stripped, lowercased — or `undefined` when the result is not a DOI.
 * A doi.org URL is percent-decoded, as doi.org reads it; any other form only
 * when it is not already DOI-shaped (`10.5061%2Fdryad.234`), so a literal `%`
 * in a DOI suffix survives.
 */
export function normalizeDoi(value: string): string | undefined {
  const trimmed = value.trim();
  const written = trimmed.replace(DOI_URL_PREFIX_RE, '').replace(/^(?:info:doi\/|doi:)\s*/i, '');
  const decode = DOI_URL_PREFIX_RE.test(trimmed) || !DOI_RE.test(written.trim());
  const doi = (decode ? decodeUri(written) : written).trim().toLowerCase();
  return DOI_RE.test(doi) ? doi : undefined;
}

/** Runs of characters a URL path cannot carry bare: everything outside RFC 3986 `pchar` and `/`. */
const DOI_URL_ESCAPE_RE = /[^A-Za-z0-9\-._~!$&'()*+,;=:@/]+/g;

/**
 * The doi.org URL of a canonical DOI, percent-encoded as the DOI Handbook
 * specifies (UTF-8, every byte outside the path characters escaped) except that
 * `/` and `,` stay bare, so `#`, `?`, and a literal `%` remain part of the DOI.
 */
export const doiUrl = (doi: string): string =>
  `https://doi.org/${doi.replace(DOI_URL_ESCAPE_RE, (run) => encodeURIComponent(run))}`;

/** A doi.org / dx.doi.org URL reduced to its DOI, else `undefined`. */
export function doiFromUrl(value: string): string | undefined {
  return DOI_URL_PREFIX_RE.test(value.trim()) ? normalizeDoi(value) : undefined;
}

/**
 * `value` without its trailing slashes. An index scan, not `/\/+$/`, which
 * backtracks quadratically on a long run of slashes that does not end the value.
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/** Whether `value` is shaped like an ORCID iD (bare or URL), valid or not. */
export const looksLikeOrcid = (value: string): boolean =>
  ORCID_PREFIX_RE.test(value.trim()) || ORCID_SHAPE_RE.test(value.trim());

/** ISO 7064 mod 11-2 check character for the first 15 digits of an ORCID iD. */
function orcidCheckCharacter(digits: string): string {
  let total = 0;
  for (const digit of digits) total = (total + Number(digit)) * 2;
  const result = (12 - (total % 11)) % 11;
  return result === 10 ? 'X' : String(result);
}

/** An ORCID iD as `0000-0002-1825-0097` with its checksum verified, else `undefined`. */
export function normalizeOrcid(value: string): string | undefined {
  const bare = trimTrailingSlashes(value.trim().replace(ORCID_PREFIX_RE, ''))
    .replace(/-/g, '')
    .toUpperCase();
  if (!/^\d{15}[\dX]$/.test(bare)) return;
  if (orcidCheckCharacter(bare.slice(0, 15)) !== bare[15]) return;
  return bare.replace(/(.{4})(?=.)/g, '$1-');
}

/** Whether `value` carries a ror.org prefix or is shaped like a bare ROR ID. */
export const looksLikeRor = (value: string): boolean =>
  ROR_PREFIX_RE.test(value.trim()) || ROR_RE.test(value.trim().toLowerCase());

/** A ROR ID as its lowercase bare id, else `undefined`. */
export function normalizeRor(value: string): string | undefined {
  const bare = trimTrailingSlashes(value.trim().replace(ROR_PREFIX_RE, '')).toLowerCase();
  return ROR_RE.test(bare) ? bare : undefined;
}

/** Whether `value` is shaped like a Crossref Funder ID (prefixed, URL, or bare digits). */
export const looksLikeFunderId = (value: string): boolean => {
  const trimmed = value.trim().replace(DOI_URL_PREFIX_RE, '');
  return trimmed.startsWith(FUNDER_PREFIX) || /^[1-9]\d*$/.test(trimmed);
};

/** A Crossref Funder ID as `10.13039/<digits>`, else `undefined`. */
export function normalizeFunderId(value: string): string | undefined {
  const trimmed = value.trim().replace(DOI_URL_PREFIX_RE, '');
  const digits = trimmed.startsWith(FUNDER_PREFIX) ? trimmed.slice(FUNDER_PREFIX.length) : trimmed;
  return /^[1-9]\d*$/.test(digits) ? `${FUNDER_PREFIX}${digits}` : undefined;
}

/** An ISO 639-1 code lowercased, else `undefined`. */
export function normalizeLanguage(value: string): string | undefined {
  const code = value.trim().toLowerCase();
  return ISO_639_1.has(code) ? code : undefined;
}
