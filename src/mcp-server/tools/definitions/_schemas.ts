/**
 * @fileoverview Input-schema building blocks shared by the tool definitions:
 * blank-as-unset wrappers for form clients, enum-ish fields that canonicalize
 * case and punctuation before the advertised `z.enum` checks them, length
 * ceilings for free-text and identifier inputs, and the identifier patterns
 * several tools share. Each pattern admits every raw form its handler
 * normalizes (any case, surrounding whitespace); a check finer than the pattern
 * stays in the handler with its typed reason.
 * @module mcp-server/tools/definitions/_schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

const isBlank = (value: unknown): boolean => typeof value === 'string' && value.trim() === '';

/**
 * Length ceilings for string inputs, checked on the trimmed value and advertised
 * as `maxLength`. Each sits well past any real value; together they bound the
 * text a handler scans and the URL it sends upstream, whatever the transport's
 * body limit.
 */
export const MAX_CHARS = {
  /** `text` and `query`: keeps the percent-encoded query inside an upstream URL. */
  query: 2000,
  /** Names and phrases: creator, affiliation, funder, subject, place, software. */
  phrase: 500,
  doi: 500,
  /** A work-search cursor envelope, which wraps a DOI-bearing upstream token. */
  cursor: 2048,
  /** CSL style ids; the longest in the CSL repository runs to 119 characters. */
  style: 200,
  /** Repository, provider, and license ids. */
  id: 100,
} as const;

/**
 * A blank or whitespace-only string is "unset": mapped to `undefined` before the
 * inner schema runs, so defaults apply and validators never see it.
 */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (isBlank(value) ? undefined : value), schema);

/** An optional string: trimmed, blank treated as unset, then checked by `inner`. */
export const optionalString = (inner: z.ZodString = z.string()) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() || undefined : value),
    inner.optional(),
  );

/**
 * A DOI in any form the handler normalizes — any case, then `10.` after an
 * optional doi.org URL, `doi:`, or `info:doi/` prefix. The handler lowercases;
 * the exact check (registrant digits, a suffix after the slash, `%2F` decoding)
 * runs there too and answers a near-miss with `invalid_doi`.
 */
export const doiString = () =>
  z
    .string()
    .trim()
    .max(MAX_CHARS.doi)
    .regex(
      /^\s*(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/(?:[Dd][Xx]\.)?[Dd][Oo][Ii]\.[Oo][Rr][Gg]\/)?(?:[Dd][Oo][Ii]:\s*|[Ii][Nn][Ff][Oo]:[Dd][Oo][Ii]\/)?10\.\S+\s*$/,
      'Expected a DOI such as 10.5061/dryad.234 — bare, with a doi: or info:doi/ prefix, or as a doi.org URL. To find a DataCite DOI by title, search with datacite_search_works (text).',
    );

/** A repository id, `provider.repository`, in any case. */
export const repositoryIdString = () =>
  z
    .string()
    .trim()
    .max(MAX_CHARS.id)
    .regex(
      /^\s*[A-Za-z0-9-]+\.[A-Za-z0-9-]+\s*$/,
      'Expected a repository id shaped provider.repository, such as dryad.dryad or cern.zenodo; datacite_search_repositories returns it as repositoryId.',
    );

/** A provider id — letters, digits, and hyphens — in any case. */
export const providerIdString = () =>
  z
    .string()
    .trim()
    .max(MAX_CHARS.id)
    .regex(
      /^\s*[A-Za-z0-9-]+\s*$/,
      'Expected a provider id of letters, digits, and hyphens, such as dryad; datacite_search_repositories returns it as providerId.',
    );

/**
 * An enum whose input is canonicalized first — any case, hyphens, underscores,
 * or spaces — so the advertised values stay exact while callers' spellings
 * resolve. An unknown value reaches the enum unchanged and is rejected naming it.
 */
export const enumish = <const T extends readonly [string, ...string[]]>(
  values: T,
  resolve: (value: string) => T[number] | undefined,
) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? (resolve(value) ?? value.trim()) : value),
    z.enum(values),
  );

/** An optional array: blank entries dropped, an array left empty treated as unset. */
export const optionalArray = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess((value) => {
    if (!Array.isArray(value)) return value;
    const kept = value.filter((entry) => !isBlank(entry));
    return kept.length === 0 ? undefined : kept;
  }, z.array(item).max(max).optional());
