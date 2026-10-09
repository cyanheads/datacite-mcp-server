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
import { phrase } from '@/services/datacite/query-builder.js';
import {
  type GraphEdge,
  MAX_EDGES,
  MAX_FRONTIER,
  REVERSE_PAGE_SIZE,
  type RelationGraph,
  type ReverseRead,
  traceRelations,
} from '@/services/datacite/relation-graph.js';
import { RELATION_TYPE_IDS, resolveRelationType } from '@/services/reference/vocabularies.js';
import { blankAsUnset, doiString, enumish, optionalArray } from './_schemas.js';
import { flattenInline, num, numOrNA, orNA, tableCell } from './_text.js';

/** Relation types that record a citation of the asserting side's target… */
const CITED_BY_TYPES = new Set(['IsCitedBy', 'IsReferencedBy', 'IsSupplementTo']);
/** …and of the asserting side itself. */
const CITING_TYPES = new Set(['Cites', 'References', 'IsSupplementedBy']);

const EDGE_SOURCES = ['metadata', 'reverse_metadata', 'event_data'] as const;

/** The largest `max_nodes` a call accepts. */
const MAX_NODES = 100;

/** Joins next steps as "a", "a or b", or "a, b, or c". */
const orList = (steps: readonly string[]): string =>
  steps.length <= 2 ? steps.join(' or ') : `${steps.slice(0, -1).join(', ')}, or ${steps.at(-1)}`;

/** Distinct works the edges record as citing `root`. */
function citingWorks(edges: readonly GraphEdge[], root: string): Set<string> {
  const citing = new Set<string>();
  for (const e of edges) {
    if (e.from === root && CITED_BY_TYPES.has(e.relationType)) citing.add(e.to);
    if (e.to === root && CITING_TYPES.has(e.relationType)) citing.add(e.from);
  }
  return citing;
}

/**
 * Compares a DataCite root's citation count with the citing works shown and names every
 * cause the call can see. Nothing when all are shown, or when `relationTypes` admits no
 * citation of the root.
 */
function citationNotice(
  root: string,
  graph: RelationGraph,
  foundEdges: readonly GraphEdge[],
  relationTypes: readonly string[] | undefined,
  maxNodes: number,
  reverseCutForSize: boolean,
): string | undefined {
  if (!graph.rootCounts) return;
  const { citationCount, versionCount, versionOfCount } = graph.rootCounts;
  const shown = citingWorks(graph.edges, root).size;
  const admitted = [...CITED_BY_TYPES].filter((t) => !relationTypes || relationTypes.includes(t));
  if (citationCount <= shown || admitted.length === 0) return;

  const causes: string[] = [];
  const missing = [...CITED_BY_TYPES].filter((t) => !admitted.includes(t));
  if (missing.length > 0) {
    causes.push(
      `relation_types leaves out the citation type${missing.length === 1 ? '' : 's'} ${missing.join(' and ')}.`,
    );
  }
  const found = citingWorks(foundEdges, root);
  const returned = new Set(graph.nodes.map((n) => n.id));
  const inGraph = [...found].filter((id) => returned.has(id)).length;
  const nodeCut = found.size - inGraph;
  if (nodeCut > 0) {
    causes.push(
      `max_nodes=${maxNodes} left ${num(nodeCut)} citing work${nodeCut === 1 ? '' : 's'} out.`,
    );
  }
  // A citing work among the returned nodes lost its citation edges only to the edge cap.
  const edgeCut = inGraph - shown;
  if (edgeCut > 0) {
    causes.push(
      `The ${num(MAX_EDGES)}-edge cap dropped the edges recording ${num(edgeCut)} citing work${edgeCut === 1 ? '' : 's'}.`,
    );
  }
  const { reverseMetadata: reverse, eventData } = graph.coverage;
  if (reverse.total > reverse.fetched) {
    causes.push(
      `This call read ${num(reverse.fetched)} of the ${num(reverse.total)} DataCite records whose related identifiers name this DOI, the most one call reads${reverseCutForSize ? ' of records that large' : ''}.`,
    );
  }
  const { total = 0, fetched = 0 } = eventData;
  if (eventData.status === 'skipped') {
    causes.push(
      'Event Data, the source of most citation links, was not read (include_event_data is false).',
    );
  } else if (eventData.status === 'ok' && total > fetched) {
    const perType =
      admitted.length > 1
        ? `; a call per citation type (relation_types ${orList(admitted)}) reads the first ${num(fetched)} of each`
        : '';
    causes.push(
      `This call read ${num(fetched)} of the ${num(total)} Event Data events on this DOI, the most one call reads${perType}.`,
    );
  }
  if (versionCount > 0 || versionOfCount > 0) {
    causes.push(
      'Citations accrue per DOI — trace the concept DOI and its version DOIs separately.',
    );
  }
  // An Event Data outage carries its own notice.
  if (causes.length === 0 && eventData.status !== 'unavailable') {
    causes.push(
      "Every source was read in full, so DataCite's count includes citations no edge records.",
    );
  }
  return [
    `DataCite records ${num(citationCount)} citation${citationCount === 1 ? '' : 's'} for this DOI; ${num(shown)} ${shown === 1 ? 'is' : 'are'} shown.`,
    ...causes,
  ].join(' ');
}

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
      "Only these relation types (IsVersionOf, HasPart, IsSupplementTo, IsDerivedFrom, Cites, IsCitedBy, …), any case, read from the traced DOI's side: HasPart keeps the DOI's own HasPart assertions and the records asserting IsPartOf it, each edge shown as asserted. IsPublishedIn and Other have no inverse and match on either side. A second hop reads them from each expanded neighbour's side. Omitted: all. Groups: datacite_list_reference topic relation_types.",
    ),
    include_event_data: z
      .boolean()
      .default(true)
      .describe(
        'Add Event Data citation links (mostly harvested from Crossref). Citation relation types only.',
      ),
    max_nodes: blankAsUnset(z.number().int().min(1).max(MAX_NODES).default(50)).describe(
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
      .describe(
        'Edges between returned nodes, at most 1,000, the first found; identical edges from several sources are merged.',
      ),
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
              .describe(
                'Records this call read: at most 100, or the first 10 when those list over 10,000 related identifiers between them.',
              ),
            secondHop: z
              .object({
                total: z
                  .number()
                  .describe("Records matching the second hop's reverse query upstream."),
                fetched: z
                  .number()
                  .describe(
                    'Records this call read of them: at most 100, or the first 10 when those list over 10,000 related identifiers between them.',
                  ),
              })
              .optional()
              .describe(
                'Other DataCite records pointing at the second-hop frontier; present only when a second hop ran.',
              ),
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
    truncated: z.boolean().optional().describe('True when max_nodes or the 1,000-edge cap bound.'),
    shown: z.number().optional().describe('Nodes returned, root included.'),
    cap: z.number().optional().describe('The max_nodes applied.'),
    edgesFound: z
      .number()
      .optional()
      .describe(
        'Edges between the returned nodes before the 1,000-edge cap; present only when the cap bound.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Coverage caveats: non-DataCite root, no relations found, Event Data unavailable, records pointing at a DOI too large to read 100 of, Event Data objects left out and nodes left unhydrated because DataCite did not answer in time, node cap, unexpanded second hop, neighbours past the second-hop limit, edge cap, uncounted citations.',
      ),
  },

  async handler(input, ctx) {
    const root = normalizeDoi(input.doi);
    if (!root) {
      throw ctx.fail(
        'invalid_doi',
        'The doi input is not a DOI after normalization; expected 10.<registrant>/<suffix>, bare or as a doi.org URL.',
      );
    }
    const relationTypes = input.relation_types && [...new Set(input.relation_types)];
    const {
      graph,
      available,
      beyondFrontier,
      capBound,
      edgesFound,
      foundEdges,
      largeReverse,
      unconfirmedEvents,
      unexpanded,
      unhydrated,
    } = await traceRelations(
      getDataCiteService(),
      {
        root,
        depth: input.depth,
        includeEventData: input.include_event_data,
        maxNodes: input.max_nodes,
        ...(relationTypes && { relationTypes }),
      },
      ctx,
    );

    const notices: string[] = [];
    const eventDataRead = graph.coverage.eventData.status === 'ok';
    if (!graph.root.isDataCiteDoi) {
      const sources = `edges shown are DataCite records that point at it${eventDataRead ? ' and, from Event Data, the DataCite works its own reference list cites' : ''}`;
      // `ids=` returns another agency's DOI as a linking copy; nothing back leaves the agency unknown.
      notices.push(
        graph.nodes[0]?.isDataCiteDoi === false
          ? `${root} is not a DataCite DOI, so it has no DataCite metadata of its own; ${sources}.`
          : `DataCite holds no public record for ${root}, so it has no DataCite metadata of its own; ${sources}. datacite_get_work says whether another agency registered it, no agency did, or it is a DataCite DOI without public metadata.`,
      );
    }
    if (graph.edges.length === 0 && available === 0 && unconfirmedEvents === 0) {
      const searched = eventDataRead ? 'DataCite metadata or Event Data' : 'DataCite metadata';
      notices.push(
        `No relations${input.relation_types ? ' of the requested relation_types' : ''} were found in ${searched}. Relations exist only where depositors asserted them or a citation link was harvested; this is not evidence that none exist.`,
      );
    }
    if (graph.coverage.eventData.status === 'unavailable') {
      notices.push(
        'Event Data did not answer, so harvested citation links (mostly from journal articles) are missing; own and reverse metadata edges are complete up to the cap. Retry to include them.',
      );
    }
    const { reverseMetadata } = graph.coverage;
    /** A reverse read the first page's related identifiers stopped at that page. */
    const largeRecords = (pointedAt: string, reader: string, listed: number, read: ReverseRead) =>
      `The DataCite records that point at ${pointedAt} are large (the first ${num(read.fetched)} list ${num(listed)} related identifiers between them), so ${reader} read ${num(read.fetched)} of the ${num(read.total)} rather than up to ${REVERSE_PAGE_SIZE}`;
    if (largeReverse.root !== undefined) {
      notices.push(
        `${largeRecords('this DOI', 'this call', largeReverse.root, reverseMetadata)}; pass query relatedIdentifiers.relatedIdentifier:${phrase(root)} to datacite_search_works to list them all.`,
      );
    }
    if (largeReverse.secondHop !== undefined && reverseMetadata.secondHop) {
      notices.push(
        `${largeRecords('the neighbours the second hop expanded', 'the second hop', largeReverse.secondHop, reverseMetadata.secondHop)}.`,
      );
    }
    if (unconfirmedEvents > 0) {
      notices.push(
        unconfirmedEvents === 1
          ? "Event Data links this DOI to 1 more DOI whose DataCite lookup did not answer within this call's time budget, so it is left out as unconfirmed (only DataCite DOIs are kept); retry to check it."
          : `Event Data links this DOI to ${num(unconfirmedEvents)} more DOIs whose DataCite lookups did not answer within this call's time budget, so they are left out as unconfirmed (only DataCite DOIs are kept); retry to check them.`,
      );
    }
    if (unhydrated > 0) {
      notices.push(
        unhydrated === 1
          ? "DataCite did not return the record of 1 DOI node within this call's time budget, so it is listed unhydrated (hydrated: false) with its DOI and edges; datacite_get_work fetches it."
          : `DataCite did not return the records of ${num(unhydrated)} DOI nodes within this call's time budget, so they are listed unhydrated (hydrated: false) with their DOIs and edges; datacite_get_work fetches any one of them.`,
      );
    }
    const narrow = relationTypes?.length === 1 ? [] : ['narrow relation_types'];
    const shown = graph.nodes.length - 1;
    if (shown < available) {
      const atMax = input.max_nodes === MAX_NODES;
      // A second hop runs only when the first fits whole, so what it left out sits past a neighbour.
      const steps = [
        ...(atMax ? [] : [`raise max_nodes (≤ ${MAX_NODES})`]),
        ...narrow,
        ...(graph.coverage.reverseMetadata.secondHop
          ? ['trace a depth-1 neighbour directly to follow its relations']
          : []),
      ];
      // With no step left, a search still lists the records pointing at the root, when there are any.
      if (steps.length === 0 && graph.coverage.reverseMetadata.total > 0) {
        steps.push(
          `pass query relatedIdentifiers.relatedIdentifier:${phrase(root)} to datacite_search_works to list the DataCite records that point at this DOI`,
        );
      }
      notices.push(
        `${num(shown)} of ${num(available)} related identifiers fit max_nodes=${input.max_nodes}${atMax ? ' (the maximum)' : ''}${steps.length > 0 ? `; ${orList(steps)}` : ''}.`,
      );
    }
    if (unexpanded > 0) {
      const them = unexpanded > MAX_FRONTIER ? `the first ${MAX_FRONTIER} of them` : 'them';
      // The second hop runs only when the root and every first-hop identifier leave a node free.
      const room = available + 2;
      const next =
        room < MAX_NODES
          ? `raise max_nodes to at least ${room} (≤ ${MAX_NODES}) to trace ${them}`
          : room === MAX_NODES
            ? `raise max_nodes to ${MAX_NODES} to trace ${them}`
            : `no max_nodes value leaves the second hop room, so ${orList([...narrow, 'trace a neighbour directly to follow its relations'])}`;
      notices.push(
        `The first hop filled max_nodes=${input.max_nodes}, so the second hop was not expanded and the relations of ${num(unexpanded)} DataCite neighbour${unexpanded === 1 ? '' : 's'} went untraced; ${next}.`,
      );
    }
    if (beyondFrontier > 0) {
      notices.push(
        `The second hop expanded the first ${MAX_FRONTIER} of ${num(MAX_FRONTIER + beyondFrontier)} DataCite neighbours in node order (at most ${MAX_FRONTIER} per call), so the relations of the other ${num(beyondFrontier)} went untraced; trace one directly to follow its relations.`,
      );
    }
    const edgeCapBound = edgesFound > graph.edges.length;
    if (edgeCapBound) {
      notices.push(
        `${num(graph.edges.length)} of ${num(edgesFound)} edges between the returned nodes are shown (at most ${num(MAX_EDGES)} per call), in the order found: own metadata, records pointing at the root, Event Data, then the second hop; ${orList([...narrow, 'trace a returned node directly to see the rest of its edges'])}.`,
      );
    }
    const citations = citationNotice(
      root,
      graph,
      foundEdges,
      relationTypes,
      input.max_nodes,
      largeReverse.root !== undefined,
    );
    if (citations) notices.push(citations);
    const notice = notices.join(' ');
    if (edgeCapBound) ctx.enrich({ truncated: true, edgesFound });
    if (capBound) {
      ctx.enrich.truncated({ shown: graph.nodes.length, cap: input.max_nodes, guidance: notice });
    } else if (notice) {
      ctx.enrich.notice(notice);
    }

    ctx.log.info('Relation trace completed', {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      edgesFound,
      capBound,
      unhydrated,
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
    for (const [relationType, edges] of Map.groupBy(result.edges, (e) => e.relationType)) {
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
        orNA(n.publicationYear),
        orNA(n.resourceTypeGeneral),
        orNA(n.repositoryId),
        numOrNA(n.citationCount),
        numOrNA(n.versionCount),
        orNA(n.title),
      ];
      lines.push(`| ${cells.map(tableCell).join(' | ')} |`);
    }

    const { ownMetadata, reverseMetadata, eventData } = result.coverage;
    lines.push(
      '',
      '## Coverage',
      `- **Own metadata:** ${ownMetadata.status} · ${num(ownMetadata.edgeCount)} asserted relations`,
      `- **Reverse metadata:** ${reverseMetadata.status} · fetched ${num(reverseMetadata.fetched)} of ${num(reverseMetadata.total)} records${reverseMetadata.secondHop ? ` · second hop fetched ${num(reverseMetadata.secondHop.fetched)} of ${num(reverseMetadata.secondHop.total)} records` : ''}`,
      `- **Event Data:** ${eventData.status}${eventData.scope ? ` · scope ${eventData.scope}` : ''}${eventData.total !== undefined ? ` · total ${num(eventData.total)}` : ''}${eventData.fetched !== undefined ? ` · fetched ${num(eventData.fetched)}` : ''}${eventData.kept !== undefined ? ` · kept ${num(eventData.kept)}` : ''}${eventData.detail ? ` · ${flattenInline(eventData.detail)}` : ''}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
