/**
 * @fileoverview The guidance a `found: false` answer carries for each miss
 * reason, shared by `datacite_get_work` and `datacite_get_citation`, and the
 * output fields both declare for the miss arm.
 * @module mcp-server/tools/definitions/_miss
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { MissClassification } from '@/services/doi-ra/doi-ra-service.js';

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

/** The guidance for a miss; `purpose` selects the other-agency next step. */
export function missGuidance(
  doi: string,
  miss: MissClassification,
  purpose: 'record' | 'citation',
): string {
  switch (miss.missReason) {
    case 'other_agency':
      return purpose === 'record'
        ? `${doi} is registered with ${miss.registrationAgency}, not DataCite, so DataCite holds no deposited metadata for it. To find DataCite datasets or software linked to it, call datacite_trace_relations with this DOI.`
        : `${doi} is registered with ${miss.registrationAgency}, not DataCite, so DataCite cannot format it. Request it from ${miss.registrationAgency}'s own content negotiation at https://doi.org/${doi} (for example with Accept: text/x-bibliography), or call datacite_trace_relations to find DataCite works linked to it.`;
    case 'does_not_exist':
      return `No agency has registered ${doi}. Check it for typos or truncation, or find the work by title with datacite_search_works (text).`;
    case 'not_public':
      return `${doi} is a DataCite DOI without public (Findable) metadata — it may be in Registered or Draft state, or registered minutes ago. Retry later, or search by title with datacite_search_works.`;
    case 'unclassified':
      return `DataCite holds no public record for ${doi}, and the registration-agency lookup did not answer. Check the DOI, or search by title with datacite_search_works.`;
  }
}
