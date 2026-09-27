/**
 * @fileoverview The guidance a `found: false` answer carries for each miss
 * reason, shared by `datacite_get_work` and `datacite_get_citation`, and the
 * output fields both declare for the miss arm.
 * @module mcp-server/tools/definitions/_miss
 */

import { z } from '@cyanheads/mcp-ts-core';
import { doiUrl } from '@/services/datacite/normalize.js';
import type { MissClassification } from '@/services/doi-ra/doi-ra-service.js';
import {
  CITATION_FORMAT_LABELS,
  CITATION_FORMATS,
  type CitationFormat,
  CROSS_AGENCY_FORMATS,
} from '@/services/reference/citation.js';

export const MISS_REASONS = [
  'other_agency',
  'does_not_exist',
  'not_public',
  'unclassified',
] as const;

/** Output fields of the miss arm. */
export const missFields = {
  registrationAgency: z
    .string()
    .optional()
    .describe(
      'Registration agency that holds the DOI (e.g. Crossref, mEDRA, DataCite), when known. Miss arm only.',
    ),
  missReason: z
    .enum(MISS_REASONS)
    .optional()
    .describe(
      'Why DataCite holds no public record: another agency registered it, no agency did, it is a DataCite DOI without public (Findable) metadata, or the agency lookup did not answer. Miss arm only.',
    ),
  guidance: z.string().optional().describe('The next step for this miss. Miss arm only.'),
};

/**
 * The guidance for a miss. `purpose` is `'record'` for a record lookup, or the
 * citation format requested, which sets the other-agency next step: that
 * format's media type when the agency serves it too, else CSL JSON.
 */
export function missGuidance(
  doi: string,
  miss: MissClassification,
  purpose: 'record' | CitationFormat,
): string {
  switch (miss.missReason) {
    case 'other_agency': {
      const agency = miss.registrationAgency;
      if (purpose === 'record') {
        return `${doi} is registered with ${agency}, not DataCite, so DataCite holds no deposited metadata for it. To find DataCite datasets or software linked to it, call datacite_trace_relations with this DOI.`;
      }
      const cannot = `${doi} is registered with ${agency}, not DataCite, so DataCite cannot format it`;
      const where = `from ${agency}'s own content negotiation at ${doiUrl(doi)}`;
      const trace = 'or call datacite_trace_relations to find DataCite works linked to it.';
      return CROSS_AGENCY_FORMATS.has(purpose)
        ? `${cannot}. Request it ${where} (for example with Accept: ${CITATION_FORMATS[purpose]}), ${trace}`
        : `${cannot}, and only DataCite's content negotiation serves ${CITATION_FORMAT_LABELS[purpose]}. Request CSL JSON or BibTeX ${where} (for example with Accept: ${CITATION_FORMATS.csl_json}), ${trace}`;
    }
    case 'does_not_exist':
      return `No agency has registered ${doi}. Check it for typos or truncation, or find the work by title with datacite_search_works (text).`;
    case 'not_public':
      return `${doi} is a DataCite DOI without public (Findable) metadata — it may be in Registered or Draft state, or registered minutes ago. Retry later, or search by title with datacite_search_works.`;
    case 'unclassified':
      return `DataCite holds no public record for ${doi}, and the registration-agency lookup did not answer. Check the DOI, or search by title with datacite_search_works.`;
  }
}
