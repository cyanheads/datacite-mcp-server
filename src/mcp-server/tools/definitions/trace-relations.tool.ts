/**
 * @fileoverview `datacite_trace_relations` — the bounded relation graph around
 * one DOI: every relationType as a directed edge exactly as asserted, each edge
 * naming its source (own metadata, other DataCite records, Event Data).
 * @module mcp-server/tools/definitions/trace-relations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDataCiteService } from '@/services/datacite/datacite-service.js';
import { normalizeDoi } from '@/services/datacite/normalize.js';
import { MAX_FRONTIER, traceRelations } from '@/services/datacite/relation-graph.js';
import { RELATION_TYPE_IDS, resolveRelationType } from '@/services/reference/vocabularies.js';
import { blankAsUnset, doiString, enumish, optionalArray } from './_schemas.js';
import { flattenInline, num, numOrNA, orNA, tableCell } from './_text.js';

/** Relation types that record a citation of the asserting side's target… */
const CITED_BY_TYPES = new Set(['IsCitedBy', 'IsReferencedBy', 'IsSupplementTo']);
/** …and of the asserting side itself. */
const CITING_TYPES = new Set(['Cites', 'References', 'IsSupplementedBy']);

const EDGE_SOURCES = ['metadata', 'reverse_metadata', 'event_data'] as const;

export const traceRelationsTool = tool('datacite_trace_relations', {
  title: 'Trace DataCite relations',
  description:
    "Map the relation graph around one DOI — versions, parts, supplements, derivations, documentation, citations, references, and every other DataCite relation type — as nodes and directed edges that keep the relationType exactly as asserted and name each edge's source: the DOI's own metadata, other DataCite records that point at it, or DataCite Event Data (citation links harvested from Crossref and other sources). Accepts any DOI, including a journal article's DOI, to find the datasets and software it cites and those that cite, supplement, or derive from it. DataCite DOIs are hydrated with title, type, year, repository, and citation count; other identifiers stay leaf nodes. Depth 1 by default, at most 2, with a node cap (default 50, max 100) disclosed when it binds. An absent edge is not evidence that no relationship exists.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_doi',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The root is not a DOI after normalization.',
      severity: 'notice',
      recovery:
        'Pass the root as a DOI such as 10.5061/dryad.234 (bare, doi:, or a doi.org URL); find one with datacite_search_works.',
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
      "The root DOI — any agency's, e.g. a DataCite dataset 10.5061/dryad.234 or a journal article's DOI. Bare, doi:, or a doi.org URL; case-insensitive.",
    ),
    depth: blankAsUnset(z.number().int().min(1).max(2).default(1)).describe(
      'Hops from the root: 1 (default) or 2. Depth 2 expands at most 10 DataCite neighbours through their own and reverse metadata, and runs only while max_nodes has room after the first hop.',
    ),
    relation_types: optionalArray(
      enumish(RELATION_TYPE_IDS, resolveRelationType),
      RELATION_TYPE_IDS.length,
    ).describe(
      'Only these relation types (IsVersionOf, HasPart, IsSupplementTo, IsDerivedFrom, Cites, IsCitedBy, …), any case. Omitted: all. Groups: datacite_list_reference topic relation_types.',
    ),
    include_event_data: z
      .boolean()
      .default(true)
      .describe(
        'Add Event Data citation links (mostly harvested from Crossref). Citation relation types only.',
      ),
    max_nodes: blankAsUnset(z.number().int().min(1).max(100).default(50)).describe(
      'Node cap including the root, 1–100 (default 50). Filled in order: own-metadata targets, records pointing at the root, Event Data endpoints, then the second hop.',
    ),
  }),

  output: z.object({
    root: z
      .object({
        doi: z.string().describe('The root DOI, lowercase.'),
        isDataCiteDoi: z.boolean().describe('Whether DataCite holds a public record for the root.'),
        title: z.string().optional().describe('Root title.'),
        resourceTypeGeneral: z.string().optional().describe('Root resourceTypeGeneral.'),
        publicationYear: z.number().optional().describe('Root publication year.'),
        repositoryId: z.string().optional().describe('Root repository id.'),
      })
      .describe(
        "The root DOI. For another agency's DOI, title, type, and year come from DataCite's linking copy when it holds one.",
      ),
    nodes: z
      .array(
        z
          .object({
            id: z
              .string()
              .describe('Identifier: a lowercase bare DOI, or any other identifier verbatim.'),
            idType: z
              .string()
              .describe(
                'DOI, URL, arXiv, PMID, Handle, ISSN, IGSN, …: the related-identifier type deposited (a doi.org URL counts as DOI), or Unknown when none was deposited.',
              ),
            isDataCiteDoi: z
              .boolean()
              .optional()
              .describe(
                "DOIs only: true for a DataCite-registered DOI, false for another agency's DOI DataCite holds a linking copy of; absent when DataCite returned nothing for it.",
              ),
            depth: z.number().describe('Hops from the root: 0, 1, or 2.'),
            hydrated: z.boolean().describe('Whether title/type/year came back for this node.'),
            title: z.string().optional().describe('Title.'),
            resourceTypeGeneral: z.string().optional().describe('resourceTypeGeneral.'),
            publicationYear: z.number().optional().describe('Publication year.'),
            repositoryId: z.string().optional().describe('Repository id.'),
            citationCount: z
              .number()
              .optional()
              .describe('Citations DataCite records for this DOI.'),
            versionCount: z.number().optional().describe('Versions of this DOI.'),
          })
          .describe('One node.'),
      )
      .describe('Nodes, root first.'),
    edges: z
      .array(
        z
          .object({
            from: z
              .string()
              .describe(
                'The asserting side (node id): the record whose metadata states the relation, or the subject of an Event Data link.',
              ),
            to: z.string().describe('The target (node id).'),
            relationType: z
              .string()
              .describe('Relation type exactly as asserted by from — never inverted.'),
            sources: z
              .array(z.enum(EDGE_SOURCES))
              .describe(
                "How the edge was reached. metadata and reverse_metadata both read from's own relatedIdentifiers — metadata by reading that record, reverse_metadata by querying for records that point at to — so an edge listing both is one assertion reached twice, not two confirmations; event_data is a link harvested by Event Data, independent of either.",
              ),
            eventSources: z
              .array(z.string())
              .optional()
              .describe('Event Data source-id values, e.g. crossref, datacite-crossref.'),
          })
          .describe('One directed edge.'),
      )
      .describe('Edges between returned nodes; identical edges from several sources are merged.'),
    rootCounts: z
      .object({
        citationCount: z.number().describe('Citations DataCite records for the root.'),
        referenceCount: z.number().describe("References the root's record makes."),
        versionCount: z.number().describe('Versions of the root.'),
        versionOfCount: z.number().describe('DOIs the root is a version of.'),
        partCount: z.number().describe('Parts of the root.'),
        partOfCount: z.number().describe('DOIs the root is part of.'),
      })
      .optional()
      .describe(
        "DataCite's own counts for the root (DataCite roots only), to compare with the edges shown.",
      ),
    coverage: z
      .object({
        ownMetadata: z
          .object({
            status: z
              .enum(['ok', 'not_datacite'])
              .describe('not_datacite when DataCite holds no record for the root.'),
            edgeCount: z
              .number()
              .describe("Relations the root's own record asserts (after relation_types)."),
          })
          .describe("The root's own metadata."),
        reverseMetadata: z
          .object({
            status: z
              .literal('ok')
              .describe('Always ok: a reverse query that does not answer fails the whole call.'),
            total: z.number().describe('Records matching the reverse query upstream.'),
            fetched: z
              .number()
              .describe('Records this call read — at most max_nodes, and never more than 100.'),
          })
          .describe('Other DataCite records pointing at the root.'),
        eventData: z
          .object({
            status: z
              .enum(['ok', 'skipped', 'unavailable'])
              .describe(
                'ok, skipped (disabled or no citation types), or unavailable (did not answer).',
              ),
            scope: z
              .enum(['both_sides', 'outgoing_to_datacite'])
              .optional()
              .describe('both_sides for a DataCite root; outgoing_to_datacite for any other root.'),
            total: z.number().optional().describe('Events matching upstream.'),
            fetched: z.number().optional().describe('Events this call read (at most 100).'),
            kept: z
              .number()
              .optional()
              .describe(
                'Events kept as edges before max_nodes applies; for a non-DataCite root, only events whose object is a DataCite DOI are kept.',
              ),
            detail: z.string().optional().describe('Why Event Data was skipped or unavailable.'),
          })
          .describe('Event Data citation links.'),
      })
      .describe('What each source contributed and how much of it was read.'),
  }),

  enrichment: {
    truncated: z.boolean().optional().describe('True when max_nodes bound.'),
    shown: z.number().optional().describe('Nodes returned, root included.'),
    cap: z.number().optional().describe('The max_nodes applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Coverage caveats: non-DataCite root, no relations found, Event Data unavailable, cap, unexpanded second hop, neighbours past the second-hop limit, uncounted citations.',
      ),
  },

  async handler(input, ctx) {
    const root = normalizeDoi(input.doi);
    if (!root) {
      throw ctx.fail(
        'invalid_doi',
        'The doi input is not a DOI after normalization; expected 10.<registrant>/<suffix>, bare or as a doi.org URL.',
        ctx.recoveryFor('invalid_doi'),
      );
    }
    const { graph, available, beyondFrontier, capBound, unexpanded } = await traceRelations(
      getDataCiteService(),
      {
        root,
        depth: input.depth,
        includeEventData: input.include_event_data,
        maxNodes: input.max_nodes,
        ...(input.relation_types && { relationTypes: [...new Set(input.relation_types)] }),
      },
      ctx,
    );

    const notices: string[] = [];
    if (!graph.root.isDataCiteDoi) {
      notices.push(
        `${root} is not a DataCite DOI, so it has no DataCite metadata of its own; edges shown are DataCite records that point at it and, from Event Data, the DataCite works its own reference list cites.`,
      );
    }
    if (graph.edges.length === 0 && available === 0) {
      const searched =
        graph.coverage.eventData.status === 'ok'
          ? 'DataCite metadata or Event Data'
          : 'DataCite metadata';
      notices.push(
        `No relations were found in ${searched}. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist.`,
      );
    }
    if (graph.coverage.eventData.status === 'unavailable') {
      notices.push(
        'Event Data did not answer, so harvested citation links (mostly from journal articles) are missing; own and reverse metadata edges are complete up to the cap. Retry to include them.',
      );
    }
    const shown = graph.nodes.length - 1;
    if (shown < available) {
      notices.push(
        `${num(shown)} of ${num(available)} related identifiers fit max_nodes=${input.max_nodes}; raise max_nodes (≤ 100) or narrow relation_types.`,
      );
    }
    if (unexpanded > 0) {
      notices.push(
        `The first hop filled max_nodes=${input.max_nodes}, so the second hop was not expanded and the relations of ${num(unexpanded)} DataCite neighbour${unexpanded === 1 ? '' : 's'} went untraced; raise max_nodes (≤ 100) to trace ${unexpanded > MAX_FRONTIER ? `the first ${MAX_FRONTIER} of them` : 'them'}.`,
      );
    }
    if (beyondFrontier > 0) {
      notices.push(
        `The second hop expanded the first ${MAX_FRONTIER} of ${num(MAX_FRONTIER + beyondFrontier)} DataCite neighbours in node order (at most ${MAX_FRONTIER} per call), so the relations of the other ${num(beyondFrontier)} went untraced; trace one directly to follow its relations.`,
      );
    }
    if (graph.rootCounts) {
      const citing = new Set<string>();
      for (const e of graph.edges) {
        if (e.from === root && CITED_BY_TYPES.has(e.relationType)) citing.add(e.to);
        if (e.to === root && CITING_TYPES.has(e.relationType)) citing.add(e.from);
      }
      if (graph.rootCounts.citationCount > citing.size) {
        notices.push(
          `DataCite records ${num(graph.rootCounts.citationCount)} citations for this DOI; ${num(citing.size)} are shown. Citations accrue per DOI — trace the concept DOI and its version DOIs separately.`,
        );
      }
    }
    const notice = notices.join(' ');
    if (capBound) {
      ctx.enrich.truncated({ shown: graph.nodes.length, cap: input.max_nodes, guidance: notice });
    } else if (notice) {
      ctx.enrich.notice(notice);
    }

    ctx.log.info('Relation trace completed', {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      capBound,
    });
    return graph;
  },

  format: (result) => {
    const r = result.root;
    const lines = [
      `# Relations of ${r.doi}`,
      '',
      `**Title:** ${orNA(r.title)} · **Type:** ${orNA(r.resourceTypeGeneral)} · **Year:** ${orNA(r.publicationYear)} · **Repository:** ${orNA(r.repositoryId)} · **DataCite DOI:** ${r.isDataCiteDoi}`,
    ];
    if (result.rootCounts) {
      const c = result.rootCounts;
      lines.push(
        `**DataCite counts:** ${num(c.citationCount)} citations · ${num(c.referenceCount)} references · ${num(c.versionCount)} versions · version of ${num(c.versionOfCount)} · ${num(c.partCount)} parts · part of ${num(c.partOfCount)}`,
      );
    }

    lines.push('', `## Edges (${result.edges.length})`);
    const byType = new Map<string, typeof result.edges>();
    for (const e of result.edges)
      byType.set(e.relationType, [...(byType.get(e.relationType) ?? []), e]);
    for (const [relationType, edges] of byType) {
      lines.push(`**${flattenInline(relationType)}**`);
      for (const e of edges) {
        const via = [...e.sources, ...(e.eventSources ?? []).map((s) => `event source ${s}`)].join(
          ', ',
        );
        lines.push(
          `- ${flattenInline(e.from)} —${flattenInline(e.relationType)}→ ${flattenInline(e.to)} [${flattenInline(via)}]`,
        );
      }
    }

    lines.push(
      '',
      `## Nodes (${result.nodes.length})`,
      '| id | idType | DataCite | depth | hydrated | year | type | repository | citations | versions | title |',
      '|:--|:--|:--|:--|:--|:--|:--|:--|:--|:--|:--|',
    );
    for (const n of result.nodes) {
      const cells = [
        n.id,
        n.idType,
        n.isDataCiteDoi === undefined ? '—' : String(n.isDataCiteDoi),
        String(n.depth),
        String(n.hydrated),
        n.publicationYear === undefined ? 'Not available' : String(n.publicationYear),
        n.resourceTypeGeneral ?? 'Not available',
        n.repositoryId ?? 'Not available',
        numOrNA(n.citationCount),
        numOrNA(n.versionCount),
        n.title ?? 'Not available',
      ];
      lines.push(`| ${cells.map(tableCell).join(' | ')} |`);
    }

    const { ownMetadata, reverseMetadata, eventData } = result.coverage;
    lines.push(
      '',
      '## Coverage',
      `- **Own metadata:** ${ownMetadata.status} · ${num(ownMetadata.edgeCount)} asserted relations`,
      `- **Reverse metadata:** ${reverseMetadata.status} · fetched ${num(reverseMetadata.fetched)} of ${num(reverseMetadata.total)} records`,
      `- **Event Data:** ${eventData.status}${eventData.scope ? ` · scope ${eventData.scope}` : ''}${eventData.total !== undefined ? ` · total ${num(eventData.total)}` : ''}${eventData.fetched !== undefined ? ` · fetched ${num(eventData.fetched)}` : ''}${eventData.kept !== undefined ? ` · kept ${num(eventData.kept)}` : ''}${eventData.detail ? ` · ${flattenInline(eventData.detail)}` : ''}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
