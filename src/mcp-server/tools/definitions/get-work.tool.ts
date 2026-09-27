/**
 * @fileoverview `datacite_get_work` — the full deposited DataCite metadata for
 * one DOI, with repository/provider and relation counts. A DOI DataCite does not
 * hold is a `found: false` answer naming the agency that does.
 * @module mcp-server/tools/definitions/get-work
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDataCiteService } from '@/services/datacite/datacite-service.js';
import { mapWork } from '@/services/datacite/mappers.js';
import { normalizeDoi } from '@/services/datacite/normalize.js';
import { getRegistrationAgencyService } from '@/services/doi-ra/doi-ra-service.js';
import { missFields, missGuidance } from './_miss.js';
import { doiString } from './_schemas.js';
import { blockquote, flattenInline, num, orNA } from './_text.js';

const PersonSchema = z
  .object({
    name: z.string().describe('Name as deposited, usually "Family, Given" for a person.'),
    nameType: z.string().optional().describe('Personal or Organizational, when deposited.'),
    givenName: z.string().optional().describe('Given name, when deposited.'),
    familyName: z.string().optional().describe('Family name, when deposited.'),
    contributorType: z
      .string()
      .optional()
      .describe(
        'Contributor role (contributors only), e.g. DataCurator; see datacite_list_reference topic contributor_types.',
      ),
    orcid: z
      .string()
      .optional()
      .describe('ORCID iD in 0000-0000-0000-0000 form, when deposited and valid.'),
    otherIdentifiers: z
      .array(
        z
          .object({
            identifier: z.string().describe('The identifier as deposited.'),
            scheme: z.string().optional().describe('Identifier scheme, e.g. ISNI or ROR.'),
          })
          .describe('A non-ORCID name identifier.'),
      )
      .describe('Other name identifiers.'),
    affiliations: z
      .array(
        z
          .object({
            name: z.string().describe('Affiliation name.'),
            rorId: z.string().optional().describe('ROR ID (bare), when deposited.'),
          })
          .describe('One affiliation.'),
      )
      .describe('Affiliations.'),
  })
  .describe('A creator or contributor.');

const found = (description: string) => `${description} Found arm only.`;

export const getWorkTool = tool('datacite_get_work', {
  title: 'Get DataCite work',
  description:
    'Fetch the full deposited DataCite metadata for one DOI: titles, creators and contributors with ORCID iDs and ROR affiliations, publisher, dates, version, subjects, descriptions, funding, geolocations, rights, sizes and formats, related identifiers with their relation types, repository and provider, and citation, reference, version, part, view, and download counts. Long lists are capped with their full counts reported; use datacite_trace_relations for the complete relation graph. A DOI DataCite does not hold returns found: false naming the registration agency that does, or saying the DOI does not exist.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_doi',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The doi input is not a DOI after normalization.',
      severity: 'notice',
      recovery:
        'Pass a DOI such as 10.5061/dryad.234 (bare, doi:, or a doi.org URL); to find one by title, call datacite_search_works with text.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "This deployment's shared DataCite request budget is spent: its request queue could not start a request before the call's deadline, or DataCite answered HTTP 429.",
      retryable: true,
      thrownBy: 'service',
      recovery:
        "Wait the number of seconds this error states, then retry; this deployment's shared DataCite request budget is spent for the current 5-minute window.",
    },
  ],

  input: z.object({
    doi: doiString().describe(
      'The DOI, e.g. 10.5061/dryad.234: 10., a 4–9 digit registrant, a slash, and a suffix. Accepted bare, with doi: or info:doi/ prefixes, as a doi.org / dx.doi.org URL, or %2F-encoded; case-insensitive.',
    ),
  }),

  output: z.object({
    found: z.boolean().describe('True when DataCite holds a public record for the DOI.'),
    doi: z.string().describe('The DOI, normalized to lowercase bare form.'),
    doiUrl: z
      .string()
      .optional()
      .describe(found('Resolver URL, https://doi.org/<doi>, with #, ?, and % percent-encoded.')),
    landingUrl: z.string().optional().describe(found("The repository's landing page.")),
    contentUrls: z
      .array(z.string())
      .optional()
      .describe(found('Direct content URLs, when deposited.')),
    titles: z
      .array(
        z
          .object({
            title: z.string().describe('Title text.'),
            titleType: z
              .string()
              .optional()
              .describe(
                'AlternativeTitle, Subtitle, TranslatedTitle, or Other; absent for the main title.',
              ),
            lang: z.string().optional().describe('Language of the title.'),
          })
          .describe('One title.'),
      )
      .optional()
      .describe(found('Every title, main title first.')),
    creators: z
      .array(PersonSchema)
      .optional()
      .describe(found('Creators, capped at 100 (full count in truncatedLists).')),
    contributors: z
      .array(PersonSchema)
      .optional()
      .describe(found('Contributors, capped at 100 (full count in truncatedLists).')),
    publisher: z
      .object({
        name: z.string().describe('Publisher name.'),
        rorId: z.string().optional().describe('Publisher ROR ID, when deposited.'),
      })
      .optional()
      .describe(found('Publisher.')),
    publicationYear: z.number().optional().describe(found('Publication year.')),
    resourceTypeGeneral: z
      .string()
      .optional()
      .describe(found('resourceTypeGeneral, e.g. Dataset or Software.')),
    resourceType: z
      .string()
      .optional()
      .describe(found('Free-text resource type the depositor gave.')),
    version: z.string().optional().describe(found('Version string.')),
    language: z
      .string()
      .optional()
      .describe(found('Language as deposited, usually an ISO 639-1 code such as en.')),
    dates: z
      .array(
        z
          .object({
            date: z.string().describe('Date or date range as deposited.'),
            dateType: z
              .string()
              .describe(
                'Issued, Created, Available, Collected, and so on; see datacite_list_reference topic date_types.',
              ),
            dateInformation: z.string().optional().describe('Free-text note on the date.'),
          })
          .describe('One date.'),
      )
      .optional()
      .describe(found('Dates.')),
    subjects: z
      .array(
        z
          .object({
            subject: z.string().describe('Subject term.'),
            scheme: z
              .string()
              .optional()
              .describe('Subject scheme, e.g. Fields of Science and Technology (FOS).'),
            classificationCode: z.string().optional().describe('Code within the scheme.'),
          })
          .describe('One subject.'),
      )
      .optional()
      .describe(found('Subjects, capped at 100 (full count in truncatedLists).')),
    descriptions: z
      .array(
        z
          .object({
            description: z.string().describe('Description text as deposited.'),
            descriptionType: z
              .string()
              .optional()
              .describe('Abstract, Methods, TechnicalInfo, and so on.'),
            lang: z.string().optional().describe('Language of the description.'),
          })
          .describe('One description.'),
      )
      .optional()
      .describe(found('Descriptions.')),
    fundingReferences: z
      .array(
        z
          .object({
            funderName: z.string().describe('Funder name.'),
            funderIdentifier: z
              .string()
              .optional()
              .describe('Funder identifier (ROR, Crossref Funder ID, …).'),
            funderIdentifierType: z
              .string()
              .optional()
              .describe('Scheme of funderIdentifier, e.g. ROR or Crossref Funder ID.'),
            awardNumber: z.string().optional().describe('Award or grant number.'),
            awardTitle: z.string().optional().describe('Award title.'),
            awardUri: z.string().optional().describe('Award URI.'),
          })
          .describe('One funding reference.'),
      )
      .optional()
      .describe(found('Funding, capped at 100 (full count in truncatedLists).')),
    geoLocations: z
      .array(
        z
          .object({
            place: z.string().optional().describe('Free-text place.'),
            point: z
              .object({
                latitude: z.number().describe('Latitude, decimal degrees.'),
                longitude: z.number().describe('Longitude, decimal degrees.'),
              })
              .optional()
              .describe('Point location.'),
            box: z
              .object({
                west: z.number().describe('West bound longitude, decimal degrees.'),
                east: z.number().describe('East bound longitude, decimal degrees.'),
                south: z.number().describe('South bound latitude, decimal degrees.'),
                north: z.number().describe('North bound latitude, decimal degrees.'),
              })
              .optional()
              .describe('Bounding box.'),
          })
          .describe('One geolocation.'),
      )
      .optional()
      .describe(found('Geolocations, capped at 50 (full count in truncatedLists).')),
    rights: z
      .array(
        z
          .object({
            rights: z.string().optional().describe('Rights statement.'),
            rightsUri: z.string().optional().describe('Rights URI.'),
            rightsIdentifier: z.string().optional().describe('Lowercase SPDX-style license id.'),
          })
          .describe('One rights statement.'),
      )
      .optional()
      .describe(found("The work's own rights and licenses — distinct from metadataLicense.")),
    metadataLicense: z
      .literal('CC0-1.0')
      .optional()
      .describe(
        found('License of the DataCite metadata itself (CC0 1.0), not of the work it describes.'),
      ),
    sizes: z
      .array(z.string())
      .optional()
      .describe(found('Sizes as deposited, e.g. "2123413 bytes".')),
    formats: z.array(z.string()).optional().describe(found('Formats as deposited.')),
    alternateIdentifiers: z
      .array(
        z
          .object({
            identifier: z.string().describe('The identifier.'),
            identifierType: z.string().describe('Its type, e.g. URL or Local accession number.'),
          })
          .describe('One alternate identifier.'),
      )
      .optional()
      .describe(found('Alternate identifiers.')),
    relatedIdentifiers: z
      .array(
        z
          .object({
            relationType: z.string().describe('Relation type as asserted, e.g. IsSupplementTo.'),
            relatedIdentifier: z.string().describe('The related identifier as deposited.'),
            relatedIdentifierType: z
              .string()
              .optional()
              .describe('DOI, URL, arXiv, …; see datacite_list_reference topic identifier_types.'),
            resourceTypeGeneral: z
              .string()
              .optional()
              .describe("The related resource's type, when deposited."),
          })
          .describe('One related identifier.'),
      )
      .optional()
      .describe(
        found('Related identifiers, capped at 100 (full counts in relatedIdentifierCounts).'),
      ),
    relatedIdentifierCounts: z
      .record(z.string(), z.number())
      .optional()
      .describe(found('relationType → full count of related identifiers, before the cap.')),
    relatedItems: z
      .array(
        z
          .object({
            relationType: z.string().describe('Relation type as asserted.'),
            relatedItemType: z
              .string()
              .optional()
              .describe('resourceTypeGeneral of the related item.'),
            identifier: z
              .string()
              .optional()
              .describe('The related item identifier, when deposited.'),
            identifierType: z.string().optional().describe('Its type.'),
            title: z.string().optional().describe('Related item title.'),
          })
          .describe('One related item.'),
      )
      .optional()
      .describe(
        found(
          'Related items described inline in this record — typically the journal, book, or series it appears in — capped at 25 (full count in truncatedLists).',
        ),
      ),
    counts: z
      .object({
        citationCount: z.number().describe('Citations DataCite records for this DOI.'),
        referenceCount: z.number().describe('References this DOI makes.'),
        versionCount: z.number().describe('Versions of this DOI.'),
        versionOfCount: z.number().describe('DOIs this is a version of.'),
        partCount: z.number().describe('Parts of this DOI.'),
        partOfCount: z.number().describe('DOIs this is part of.'),
        viewCount: z.number().describe('Views reported by the repository.'),
        downloadCount: z.number().describe('Downloads reported by the repository.'),
      })
      .optional()
      .describe(found("DataCite's own counts; they can trail the live record by a few events.")),
    repository: z
      .object({
        repositoryId: z
          .string()
          .describe('Repository id (repository_ids filter of datacite_search_works).'),
        name: z.string().optional().describe('Repository name.'),
        providerId: z.string().optional().describe('Parent provider id.'),
      })
      .optional()
      .describe(found('The DataCite repository that registered the DOI.')),
    registered: z.string().optional().describe(found('When the DOI was registered.')),
    created: z.string().optional().describe(found('When the record was created.')),
    updated: z.string().optional().describe(found('When the record was last updated.')),
    schemaVersion: z.string().optional().describe(found('DataCite metadata schema version URI.')),
    ...missFields,
  }),

  enrichment: {
    truncatedLists: z
      .array(
        z
          .object({
            field: z.string().describe('The capped list.'),
            shown: z.number().describe('Entries returned.'),
            total: z.number().describe('Entries in the record.'),
          })
          .describe('One capped list.'),
      )
      .optional()
      .describe('Lists the caps bound, with their full counts. Present only when a cap bound.'),
  },
  enrichmentTrailer: {
    truncatedLists: {
      render: (lists) =>
        `**Truncated lists:** ${(lists ?? []).map((l) => `${l.field}: ${num(l.shown)} of ${num(l.total)}`).join('; ')}`,
    },
  },

  async handler(input, ctx) {
    const doi = normalizeDoi(input.doi);
    if (!doi) {
      throw ctx.fail(
        'invalid_doi',
        'The doi input is not a DOI after normalization; expected 10.<registrant>/<suffix>, bare or as a doi.org URL.',
        ctx.recoveryFor('invalid_doi'),
      );
    }
    const hit = await getDataCiteService().getWork(doi, ctx);
    if (!hit) {
      const miss = await getRegistrationAgencyService().classifyMiss(doi, ctx);
      ctx.log.info('DOI not held by DataCite', { missReason: miss.missReason });
      return { found: false, doi, ...miss, guidance: missGuidance(doi, miss, 'record') };
    }
    const { work, truncatedLists } = mapWork(hit.record, hit.client);
    if (truncatedLists.length > 0) ctx.enrich({ truncatedLists });
    return { found: true, doi, ...work };
  },

  format: (result) => {
    const lines: string[] = [
      result.found
        ? `# ${flattenInline(result.titles?.[0]?.title ?? result.doi)}`
        : `**Not found in DataCite** — ${result.doi}`,
      '',
      `**DOI:** ${result.doi} · **Found:** ${result.found}`,
    ];
    if (result.missReason) lines.push(`**Miss reason:** ${result.missReason}`);
    if (result.registrationAgency)
      lines.push(`**Registration agency:** ${flattenInline(result.registrationAgency)}`);
    if (result.guidance) lines.push('', flattenInline(result.guidance));
    if (result.doiUrl) lines.push(`**Resolver:** ${result.doiUrl}`);
    if (result.landingUrl) lines.push(`**Landing page:** ${flattenInline(result.landingUrl)}`);
    if (result.contentUrls?.length)
      lines.push(`**Content URLs:** ${result.contentUrls.map(flattenInline).join(', ')}`);
    if (result.found) {
      lines.push(
        `**Type:** ${orNA(result.resourceTypeGeneral)}${result.resourceType ? ` (${flattenInline(result.resourceType)})` : ''} · **Year:** ${orNA(result.publicationYear)} · **Version:** ${orNA(result.version)} · **Language:** ${orNA(result.language)}`,
      );
    }
    if (result.publisher) {
      lines.push(
        `**Publisher:** ${flattenInline(result.publisher.name)}${result.publisher.rorId ? ` (ROR ${result.publisher.rorId})` : ''}`,
      );
    }
    if (result.repository) {
      const r = result.repository;
      lines.push(
        `**Repository:** ${r.name ? `${flattenInline(r.name)} ` : ''}(${flattenInline(r.repositoryId)}) · **Provider:** ${orNA(r.providerId)}`,
      );
    }
    if (result.counts) {
      const c = result.counts;
      lines.push(
        `**Counts:** ${num(c.citationCount)} citations · ${num(c.referenceCount)} references · ${num(c.versionCount)} versions · version of ${num(c.versionOfCount)} · ${num(c.partCount)} parts · part of ${num(c.partOfCount)} · ${num(c.viewCount)} views · ${num(c.downloadCount)} downloads`,
      );
    }
    const dates = [
      result.registered && `registered ${result.registered}`,
      result.created && `created ${result.created}`,
      result.updated && `updated ${result.updated}`,
    ].filter(Boolean);
    if (dates.length > 0) lines.push(`**Record:** ${flattenInline(dates.join(' · '))}`);
    if (result.schemaVersion) lines.push(`**Schema:** ${flattenInline(result.schemaVersion)}`);

    if (result.titles && result.titles.length > 0) {
      lines.push('', '## Titles');
      for (const t of result.titles) {
        const tags = [t.titleType, t.lang].filter(Boolean).join(', ');
        lines.push(`- ${flattenInline(t.title)}${tags ? ` (${flattenInline(tags)})` : ''}`);
      }
    }
    const people = (heading: string, list: typeof result.creators) => {
      if (!list?.length) return;
      lines.push('', `## ${heading}`);
      for (const p of list) {
        const parts = [
          p.contributorType && `role ${p.contributorType}`,
          p.nameType,
          p.givenName && `given ${p.givenName}`,
          p.familyName && `family ${p.familyName}`,
          p.orcid && `ORCID ${p.orcid}`,
          ...p.otherIdentifiers.map((i) => `${i.scheme ?? 'id'} ${i.identifier}`),
          ...p.affiliations.map((a) => `${a.name}${a.rorId ? ` (ROR ${a.rorId})` : ''}`),
        ].filter(Boolean);
        lines.push(
          `- ${flattenInline(p.name)}${parts.length ? ` — ${flattenInline(parts.join('; '))}` : ''}`,
        );
      }
    };
    people('Creators', result.creators);
    people('Contributors', result.contributors);

    if (result.dates?.length) {
      lines.push('', '## Dates');
      for (const d of result.dates) {
        lines.push(
          `- ${flattenInline(d.dateType)}: ${flattenInline(d.date)}${d.dateInformation ? ` (${flattenInline(d.dateInformation)})` : ''}`,
        );
      }
    }
    if (result.subjects?.length) {
      lines.push('', '## Subjects');
      for (const s of result.subjects) {
        const tags = [s.scheme, s.classificationCode].filter(Boolean).join(' ');
        lines.push(`- ${flattenInline(s.subject)}${tags ? ` (${flattenInline(tags)})` : ''}`);
      }
    }
    if (result.descriptions?.length) {
      lines.push('', '## Descriptions');
      for (const d of result.descriptions) {
        const tags = [d.descriptionType, d.lang].filter(Boolean).join(', ');
        if (tags) lines.push(`**${flattenInline(tags)}**`);
        lines.push(blockquote(d.description), '');
      }
    }
    if (result.fundingReferences?.length) {
      lines.push('', '## Funding');
      for (const f of result.fundingReferences) {
        const parts = [
          f.funderIdentifier && `${f.funderIdentifierType ?? 'id'} ${f.funderIdentifier}`,
          f.awardNumber && `award ${f.awardNumber}`,
          f.awardTitle && `"${f.awardTitle}"`,
          f.awardUri,
        ].filter(Boolean);
        lines.push(
          `- ${flattenInline(f.funderName)}${parts.length ? ` — ${flattenInline(parts.join('; '))}` : ''}`,
        );
      }
    }
    if (result.geoLocations?.length) {
      lines.push('', '## Geolocation');
      for (const g of result.geoLocations) {
        const parts = [
          g.place && flattenInline(g.place),
          g.point && `point ${g.point.latitude}, ${g.point.longitude}`,
          g.box && `box W ${g.box.west} E ${g.box.east} S ${g.box.south} N ${g.box.north}`,
        ].filter(Boolean);
        lines.push(`- ${parts.join(' · ')}`);
      }
    }
    if (result.rights || result.metadataLicense) {
      lines.push('', '## Rights');
      if (result.rights?.length) {
        for (const r of result.rights) {
          const parts = [
            r.rights,
            r.rightsIdentifier && `(${r.rightsIdentifier})`,
            r.rightsUri,
          ].filter(Boolean);
          lines.push(`- Work rights: ${flattenInline(parts.join(' '))}`);
        }
      } else if (result.rights) {
        lines.push('- Work rights: none declared');
      }
      if (result.metadataLicense) lines.push(`- Metadata: ${result.metadataLicense}`);
    }
    const counts = new Map(Object.entries(result.relatedIdentifierCounts ?? {}));
    const related = Map.groupBy(result.relatedIdentifiers ?? [], (r) => r.relationType);
    const relationTypes = new Set([...counts.keys(), ...related.keys()]);
    if (relationTypes.size > 0) {
      lines.push('', '## Related identifiers');
      for (const relationType of relationTypes) {
        const shown = related.get(relationType) ?? [];
        const total = counts.get(relationType) ?? shown.length;
        lines.push(`**${flattenInline(relationType)}** — ${num(shown.length)} of ${num(total)}`);
        for (const r of shown) {
          const tags = [r.relatedIdentifierType, r.resourceTypeGeneral].filter(Boolean).join(', ');
          lines.push(
            `- ${flattenInline(r.relatedIdentifier)}${tags ? ` (${flattenInline(tags)})` : ''}`,
          );
        }
      }
    }
    if (result.relatedItems?.length) {
      lines.push('', '## Related items');
      for (const item of result.relatedItems) {
        const parts = [
          item.relatedItemType,
          item.identifier && `${item.identifierType ?? 'id'} ${item.identifier}`,
          item.title && `"${item.title}"`,
        ].filter(Boolean);
        lines.push(
          `- ${flattenInline(item.relationType)}: ${flattenInline(parts.join('; ') || 'no identifier')}`,
        );
      }
    }
    if (result.alternateIdentifiers?.length) {
      lines.push('', '## Alternate identifiers');
      for (const a of result.alternateIdentifiers) {
        lines.push(`- ${flattenInline(a.identifierType)}: ${flattenInline(a.identifier)}`);
      }
    }
    if (result.sizes?.length || result.formats?.length) {
      lines.push('', '## Sizes and formats');
      if (result.sizes?.length)
        lines.push(`**Sizes:** ${result.sizes.map(flattenInline).join(', ')}`);
      if (result.formats?.length)
        lines.push(`**Formats:** ${result.formats.map(flattenInline).join(', ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
