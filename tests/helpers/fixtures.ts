/**
 * @fileoverview Recorded upstream fixtures (under `tests/fixtures/`, trimmed to
 * the fields each call requests) plus the few payloads DataCite was never
 * observed returning, built here and marked as constructed. DataCite metadata is
 * CC0, so recorded records are kept verbatim apart from trimming.
 * @module tests/helpers/fixtures
 */

import { readFileSync } from 'node:fs';
import type { RawDoiList, RawDoiResource } from '@/services/datacite/types.js';
import { json } from './harness.js';

/**
 * A fixture's raw text, by path relative to `tests/fixtures/`.
 *
 * Recorded files:
 * - `datacite/errors/` — `parse-exception-query.json` and
 *   `parse-exception-repositories.json` (HTTP 400 `parse_exception`, "line 1,
 *   column 12"), `failed-to-parse-date.json` (HTTP 400 `failed to parse`),
 *   `transient-500-claims-400.json` (HTTP 500 whose body says `"status":400` /
 *   `[503] No server available`), `negotiation-404.json`.
 * - `datacite/works/` — `search-glacier.json` (3 rows + included client
 *   `gbif.col` → provider `gbif`), `facets.json` (every mapped facet group,
 *   `total` 135809087), `page-ceiling-clamped.json` (page 101 requested,
 *   `meta.page` 100, total 61388), `page-last-reachable.json` (page 100 × 100),
 *   `cursor-first.json` / `cursor-garbage-restart.json` / `cursor-sort-ignored.json`
 *   (identical rows and `links.next` token), `record-dryad-234.json` (full record).
 * - `datacite/graph/` — `root-dryad-8515.json`, `reverse-ppat-1000446.json` (the
 *   dryad.8515 record asserting `IsCitedBy` ppat.1000446), `events-dryad-8515.json`
 *   (3 `datacite-crossref` events to ppat.1000446), `hydrate-linking-copies.json`
 *   (dryad.8515 with client; nature12373 and science.1259855 as `levriero` copies
 *   with `client: null`), `article-events.json` (3 Crossref + 2 GBIF objects of
 *   the 118 `subj-id` events of 10.1016/j.jag.2021.102408), `article-reverse.json`
 *   (0 hits), `hydrate-dryad-234-gbif-hnhrg3.json`.
 * - `datacite/repositories/` — `query-glacier.json`,
 *   `filters-coretrustseal-dataverse.json`, `fos-earth-sciences.json` (28 total),
 *   `ids-ethz-wgms-dryad.json` (`ethz.wgms` belongs to provider `kadq`).
 * - `datacite/citations/` — dryad.8515 renderings: `-default.html` (APA; the
 *   upstream answered `mla`, `IEEE`, `apa-single-spaced`,
 *   `chicago-fullnote-bibliography`, and an unknown style byte-identically),
 *   `-ieee.html`, `-ieee-de-DE.html`, `-modern-language-association.html`,
 *   `-csl.json`; the canary 10.5061/dryad.234: `canary-dryad-234-default.html`,
 *   `-mla.html`, `-ieee-de-DE.html`; `zenodo-3509134-bibtex.bib` (the BibTeX
 *   DataCite serves for 10.5281/zenodo.3509134).
 * - `doi-ra/` — `crossref.json`, `datacite.json`, `does-not-exist.json`.
 */
export function fixtureText(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8');
}

/** A fixture parsed as JSON; a fresh object on every call, safe to mutate. */
export function fixtureJson<T = unknown>(path: string): T {
  return JSON.parse(fixtureText(path)) as T;
}

/** A recorded JSON body as a `Response` (status 200 unless given). */
export const fixtureResponse = (path: string, init: ResponseInit = {}): Response =>
  json(fixtureText(path), init);

/**
 * Constructed — DataCite's 429 was never triggered live, so its body and headers
 * are unknown. This follows the JSON:API error shape DataCite uses elsewhere.
 * `retryAfter` is sent verbatim as the `Retry-After` header: delta-seconds
 * (`'5'`) or an HTTP-date (`new Date(...).toUTCString()`); omit it for an
 * unhinted 429.
 */
export function rateLimitResponse(retryAfter?: string): Response {
  return json(
    { errors: [{ status: '429', title: 'Too Many Requests' }] },
    {
      status: 429,
      ...(retryAfter !== undefined && { headers: { 'Retry-After': retryAfter } }),
    },
  );
}

/** Constructed — a `/dois` page with no hits, shaped like the recorded zero-hit pages. */
export function emptyDoiList(): RawDoiList {
  // `totalPages` is sent upstream but not read by the server, so the raw type omits it.
  const meta = { total: 0, totalPages: 0, page: 1 };
  return { data: [], meta, links: {} };
}

/** A `/dois` list page over the given records, `total` defaulting to their count. */
export function doiList(
  records: RawDoiResource[],
  meta: Partial<RawDoiList['meta']> = {},
  links: RawDoiList['links'] = {},
): RawDoiList {
  const pageMeta = { total: records.length, totalPages: 1, page: 1, ...meta };
  return { data: records, meta: pageMeta, links };
}

/**
 * Constructed — a DataCite record asserting a relation to `target` through a
 * URL-typed related identifier, the way depositors store a DOI as a doi.org URL
 * (`{ relationType, relatedIdentifier: "https://doi.org/…", relatedIdentifierType:
 * "URL" }`). The entry shape follows recorded records; the live reverse counts
 * for one article DOI were 0 bare-form hits and 3 URL-form hits.
 */
export function urlFormRelatedRecord(options: {
  client?: string | null;
  doi: string;
  relationType: string;
  target: string;
  title?: string;
}): RawDoiResource {
  const { doi, relationType, target, title, client = 'dryad.dryad' } = options;
  return {
    id: doi,
    type: 'dois',
    attributes: {
      doi,
      ...(title !== undefined && { titles: [{ title }] }),
      relatedIdentifiers: [
        { relationType, relatedIdentifier: target, relatedIdentifierType: 'URL' },
      ],
      citationCount: 0,
      versionCount: 0,
    },
    relationships: { client: { data: client === null ? null : { id: client, type: 'clients' } } },
  };
}

/**
 * Constructed — `10.5061/dryad.8515/<part>`, a Dryad file DOI asserting it
 * `IsPartOf` the dataset 10.5061/dryad.8515 (whose record counts `partCount` 2).
 * Part 1 stores the parent bare and DOI-typed; part 2 stores it the way
 * {@link urlFormRelatedRecord} does, as a URL-typed doi.org URL in upper case.
 * Fields follow `REVERSE_FIELDS`.
 */
export function dryad8515Part(part: 1 | 2): RawDoiResource {
  const doi = `10.5061/dryad.8515/${part}`;
  const record = urlFormRelatedRecord({
    doi,
    relationType: 'IsPartOf',
    target: 'https://doi.org/10.5061/DRYAD.8515',
    title: `Data from: A new malaria agent in African hominids. — file ${part}`,
  });
  if (part === 1) {
    record.attributes.relatedIdentifiers = [
      {
        relationType: 'IsPartOf',
        relatedIdentifier: '10.5061/dryad.8515',
        relatedIdentifierType: 'DOI',
      },
    ];
  }
  record.attributes.types = { resourceTypeGeneral: 'Dataset', resourceType: 'dataset' };
  record.attributes.publicationYear = 2011;
  return record;
}

/** Constructed — the reverse-relation page for 10.5061/dryad.8515: its two file DOIs. */
export const dryad8515ReversePage = (): RawDoiList => doiList([dryad8515Part(1), dryad8515Part(2)]);

/**
 * Constructed — the DataCite record for the GBIF dataset 10.15468/s6ctus, one of
 * the objects in the recorded `article-events.json`. Its hydration was never
 * recorded, so the title is a placeholder; the shape and the `gbif.gbif` client
 * follow the recorded 10.15468/hnhrg3 record. Fields follow `NODE_FIELDS`.
 */
export function gbifS6ctusRecord(): RawDoiResource {
  return {
    id: '10.15468/s6ctus',
    type: 'dois',
    attributes: {
      doi: '10.15468/s6ctus',
      titles: [{ title: 'GBIF occurrence dataset s6ctus (constructed)' }],
      publicationYear: 2025,
      types: { resourceTypeGeneral: 'Dataset', resourceType: 'OCCURRENCE' },
      citationCount: 12,
      versionCount: 0,
    },
    relationships: { client: { data: { id: 'gbif.gbif', type: 'clients' } } },
  };
}

/**
 * Constructed — another agency's DOI as `/dois?ids=` returns it: a DataCite
 * linking copy with `client: null`, shaped after the recorded nature12373 copy
 * in `hydrate-linking-copies.json`. Stands in for the copies of the journal
 * articles the traces use (10.1016/j.jag.2021.102408,
 * 10.1371/journal.ppat.1000446), which were never recorded.
 */
export function linkingCopyRecord(options: {
  citationCount?: number;
  doi: string;
  publicationYear: number;
  title: string;
}): RawDoiResource {
  const { doi, title, publicationYear, citationCount = 0 } = options;
  return {
    id: doi,
    type: 'dois',
    attributes: {
      doi,
      titles: [{ title }],
      types: { resourceTypeGeneral: 'Text', resourceType: 'JournalArticle' },
      publicationYear,
      citationCount,
      versionCount: 0,
    },
    relationships: { client: { data: null } },
  };
}
