/**
 * @fileoverview Relation-graph builder for `datacite_trace_relations`. Collects
 * edges exactly as asserted — the root's own `relatedIdentifiers`, other DataCite
 * records that point at it (verified pair by pair), and Event Data citation
 * links — merges identical edges across sources, fills the node budget in a
 * fixed order, hydrates DOI nodes in batches, and optionally expands a second
 * hop through own and reverse metadata.
 * @module services/datacite/relation-graph
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  CITATION_RELATION_TYPES,
  type RelationTypeId,
  relationTypeKebab,
  resolveRelationType,
} from '@/services/reference/vocabularies.js';
import {
  type DataCiteService,
  NODE_FIELDS,
  NODE_WITH_RELATIONS_FIELDS,
  REVERSE_FIELDS,
  ROOT_FIELDS,
} from './datacite-service.js';
import { firstTitle, publicationYear, text } from './mappers.js';
import { doiFromUrl, normalizeDoi } from './normalize.js';
import { reverseRelationQuery } from './query-builder.js';
import type { RawDoiResource } from './types.js';

/** Where an edge was found. */
export type EdgeSource = 'metadata' | 'reverse_metadata' | 'event_data';

export interface GraphNode {
  citationCount?: number;
  depth: number;
  hydrated: boolean;
  id: string;
  idType: string;
  isDataCiteDoi?: boolean;
  publicationYear?: number;
  repositoryId?: string;
  resourceTypeGeneral?: string;
  title?: string;
  versionCount?: number;
}

export interface GraphEdge {
  eventSources?: string[];
  from: string;
  relationType: string;
  sources: EdgeSource[];
  to: string;
}

export interface EventCoverage {
  detail?: string;
  fetched?: number;
  kept?: number;
  scope?: 'both_sides' | 'outgoing_to_datacite';
  status: 'ok' | 'skipped' | 'unavailable';
  total?: number;
}

export interface TraceRequest {
  depth: number;
  includeEventData: boolean;
  maxNodes: number;
  relationTypes?: readonly RelationTypeId[];
  root: string;
}

export interface RelationGraph {
  coverage: {
    eventData: EventCoverage;
    ownMetadata: { edgeCount: number; status: 'ok' | 'not_datacite' };
    reverseMetadata: { fetched: number; status: 'ok'; total: number };
  };
  edges: GraphEdge[];
  nodes: GraphNode[];
  root: {
    doi: string;
    isDataCiteDoi: boolean;
    publicationYear?: number;
    repositoryId?: string;
    resourceTypeGeneral?: string;
    title?: string;
  };
  rootCounts?: {
    citationCount: number;
    referenceCount: number;
    versionCount: number;
    versionOfCount: number;
    partCount: number;
    partOfCount: number;
  };
}

export interface TraceResult {
  /** Distinct related identifiers found before the node cap (root excluded). */
  available: number;
  /** DataCite depth-1 nodes a second hop that ran left unexpanded, past the frontier limit. */
  beyondFrontier: number;
  /** Whether `maxNodes` left found identifiers out, or left no room for a requested second hop. */
  capBound: boolean;
  graph: RelationGraph;
  /** DataCite depth-1 nodes whose relations a requested second hop had no room to trace. */
  unexpanded: number;
}

/** Frontier nodes a second hop expands: the first DataCite depth-1 nodes in node order. */
export const MAX_FRONTIER = 10;

const TRANSIENT_CODES = new Set([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.RateLimited,
]);

interface Target {
  id: string;
  idType: string;
}

/**
 * The node a related identifier names. A DOI-typed value, and a doi.org URL
 * stored as a URL, become the bare lowercase DOI so they merge with the DOI node.
 */
function relatedTarget(identifier: string, type: string | undefined): Target {
  if (type === 'DOI') {
    const doi = normalizeDoi(identifier);
    return doi ? { id: doi, idType: 'DOI' } : { id: identifier, idType: 'DOI' };
  }
  const fromUrl = doiFromUrl(identifier);
  if (fromUrl) return { id: fromUrl, idType: 'DOI' };
  return { id: identifier, idType: type ?? 'Unknown' };
}

/** The own-metadata assertions of a record: every related identifier and identified related item. */
function assertions(record: RawDoiResource): Array<Target & { relationType: string }> {
  const a = record.attributes;
  const out: Array<Target & { relationType: string }> = [];
  for (const r of a.relatedIdentifiers ?? []) {
    const relationType = text(r.relationType);
    const identifier = text(r.relatedIdentifier);
    if (relationType && identifier) {
      out.push({ ...relatedTarget(identifier, text(r.relatedIdentifierType)), relationType });
    }
  }
  for (const item of a.relatedItems ?? []) {
    const relationType = text(item.relationType);
    const identifier = text(item.relatedItemIdentifier?.relatedItemIdentifier);
    if (relationType && identifier) {
      const type = text(item.relatedItemIdentifier?.relatedItemIdentifierType);
      out.push({ ...relatedTarget(identifier, type), relationType });
    }
  }
  return out;
}

const recordDoi = (record: RawDoiResource): string =>
  (record.attributes.doi ?? record.id).toLowerCase();

/** Hydrated node fields from a `/dois` record; `client` null marks another agency's linking copy. */
function hydratedFields(record: RawDoiResource): Omit<GraphNode, 'id' | 'idType' | 'depth'> {
  const a = record.attributes;
  const repositoryId = record.relationships?.client?.data?.id;
  const title = firstTitle(a);
  const year = publicationYear(a);
  const type = text(a.types?.resourceTypeGeneral);
  return {
    hydrated: true,
    isDataCiteDoi: repositoryId !== undefined,
    ...(title !== undefined && { title }),
    ...(type !== undefined && { resourceTypeGeneral: type }),
    ...(year !== undefined && { publicationYear: year }),
    ...(repositoryId !== undefined && { repositoryId }),
    ...(typeof a.citationCount === 'number' && { citationCount: a.citationCount }),
    ...(typeof a.versionCount === 'number' && { versionCount: a.versionCount }),
  };
}

/** Builds the relation graph around `request.root`. */
export async function traceRelations(
  service: DataCiteService,
  request: TraceRequest,
  ctx: Context,
): Promise<TraceResult> {
  const { root, maxNodes } = request;
  const filter = request.relationTypes?.length ? new Set<string>(request.relationTypes) : undefined;
  const allowed = (type: string) => !filter || filter.has(type);

  const edges = new Map<string, GraphEdge>();
  const addEdge = (
    from: string,
    to: string,
    relationType: string,
    source: EdgeSource,
    eventSource?: string,
  ) => {
    const key = JSON.stringify([from, to, relationType]);
    const edge = edges.get(key) ?? { from, to, relationType, sources: [] };
    if (!edge.sources.includes(source)) edge.sources.push(source);
    if (eventSource) {
      edge.eventSources ??= [];
      if (!edge.eventSources.includes(eventSource)) edge.eventSources.push(eventSource);
    }
    edges.set(key, edge);
  };

  /** Candidate nodes in budget order, with any record already in hand. */
  const candidates = new Map<string, { idType: string; record?: RawDoiResource }>();
  const addCandidate = (target: Target, record?: RawDoiResource) => {
    if (target.id === root) return;
    const existing = candidates.get(target.id);
    if (!existing) candidates.set(target.id, { idType: target.idType, ...(record && { record }) });
    else if (record && !existing.record) existing.record = record;
  };

  // Call 1: the root's own record and assertions.
  const rootRecord = await service.getRecord(root, ROOT_FIELDS, ctx);
  let ownEdgeCount = 0;
  for (const assertion of rootRecord ? assertions(rootRecord) : []) {
    if (!allowed(assertion.relationType)) continue;
    addEdge(root, assertion.id, assertion.relationType, 'metadata');
    addCandidate(assertion);
    ownEdgeCount++;
  }

  // Calls 2 ∥ 3: records asserting a relation to the root, and Event Data.
  const eventTypes = CITATION_RELATION_TYPES.filter(allowed);
  const [reverse, events] = await Promise.all([
    service.queryRecords(
      reverseRelationQuery([root], request.relationTypes),
      REVERSE_FIELDS,
      Math.min(maxNodes, 100),
      ctx,
    ),
    readEvents(service, root, rootRecord !== undefined, eventTypes, request.includeEventData, ctx),
  ]);

  for (const record of reverse.data) {
    const from = recordDoi(record);
    if (from === root) continue;
    let asserted = false;
    for (const assertion of assertions(record)) {
      if (assertion.id !== root || !allowed(assertion.relationType)) continue;
      addEdge(from, root, assertion.relationType, 'reverse_metadata');
      asserted = true;
    }
    if (asserted) addCandidate({ id: from, idType: 'DOI' }, record);
  }

  // A non-DataCite root keeps only outgoing events whose object is a DataCite DOI,
  // which needs the objects hydrated before the node budget is spent.
  const hydratedEarly = new Map<string, RawDoiResource>();
  const attempted = new Set<string>();
  let kept = events.links;
  if (!rootRecord && kept.length > 0) {
    const objects = [...new Set(kept.filter((l) => l.to.idType === 'DOI').map((l) => l.to.id))];
    for (const doi of objects) attempted.add(doi);
    for (const [doi, record] of await service.hydrate(objects, NODE_FIELDS, ctx)) {
      hydratedEarly.set(doi, record);
    }
    kept = kept.filter((l) => hydratedEarly.get(l.to.id)?.relationships?.client?.data != null);
  }
  for (const link of kept) {
    addEdge(link.from.id, link.to.id, link.relationType, 'event_data', link.sourceId);
    addCandidate(link.from.id === root ? link.to : link.from);
  }
  const eventCoverage: EventCoverage =
    events.coverage.status === 'ok' ? { ...events.coverage, kept: kept.length } : events.coverage;

  // Node budget: root first, then candidates in insertion order.
  const nodes = new Map<string, GraphNode>();
  nodes.set(root, { id: root, idType: 'DOI', depth: 0, hydrated: false });
  let available = candidates.size;
  const admit = (depth: number, pool: Map<string, { idType: string; record?: RawDoiResource }>) => {
    for (const [id, candidate] of pool) {
      if (nodes.size >= maxNodes) return false;
      if (nodes.has(id)) continue;
      const record = candidate.record ?? hydratedEarly.get(id);
      nodes.set(id, {
        id,
        idType: candidate.idType,
        depth,
        ...(record ? hydratedFields(record) : { hydrated: false }),
      });
    }
    return true;
  };
  let capBound = !admit(1, candidates);
  let unexpanded = 0;
  let beyondFrontier = 0;

  /**
   * Calls 5 ∥ 6: the second hop through own and reverse metadata of DataCite frontier nodes.
   * Which depth-1 nodes are DataCite DOIs is known only after hydration, so a first hop that
   * filled the cap is hydrated too, to tell whether it left the second hop no room.
   */
  if (request.depth >= 2) {
    await hydrateNodes(service, nodes, attempted, ctx, rootRecord === undefined);
    const neighbours = [...nodes.values()]
      .filter((n) => n.depth === 1 && n.isDataCiteDoi === true)
      .map((n) => n.id);
    if (neighbours.length > 0 && nodes.size >= maxNodes) {
      capBound = true;
      unexpanded = neighbours.length;
    } else if (neighbours.length > 0) {
      const frontier = neighbours.slice(0, MAX_FRONTIER);
      beyondFrontier = neighbours.length - frontier.length;
      const frontierSet = new Set(frontier);
      const [own, reverse2] = await Promise.all([
        service.hydrate(frontier, NODE_WITH_RELATIONS_FIELDS, ctx),
        service.queryRecords(
          reverseRelationQuery(frontier, request.relationTypes),
          REVERSE_FIELDS,
          Math.min(maxNodes - nodes.size, 100),
          ctx,
        ),
      ]);
      const second = new Map<string, { idType: string; record?: RawDoiResource }>();
      const addSecond = (target: Target, record?: RawDoiResource) => {
        if (nodes.has(target.id) || second.has(target.id)) return;
        second.set(target.id, { idType: target.idType, ...(record && { record }) });
      };
      for (const [from, record] of own) {
        for (const assertion of assertions(record)) {
          if (!allowed(assertion.relationType)) continue;
          addEdge(from, assertion.id, assertion.relationType, 'metadata');
          addSecond(assertion);
        }
      }
      for (const record of reverse2.data) {
        const from = recordDoi(record);
        if (from === root) continue;
        let asserted = false;
        for (const assertion of assertions(record)) {
          if (!frontierSet.has(assertion.id) || !allowed(assertion.relationType)) continue;
          addEdge(from, assertion.id, assertion.relationType, 'reverse_metadata');
          asserted = true;
        }
        if (asserted) addSecond({ id: from, idType: 'DOI' }, record);
      }
      available += second.size;
      capBound = !admit(2, second);
    }
  }

  await hydrateNodes(service, nodes, attempted, ctx, rootRecord === undefined);
  const rootNode = nodes.get(root) as GraphNode;
  if (rootRecord) Object.assign(rootNode, hydratedFields(rootRecord));

  const keptEdges = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));
  const a = rootRecord?.attributes;
  const graph: RelationGraph = {
    root: {
      doi: root,
      isDataCiteDoi: rootNode.isDataCiteDoi === true,
      ...(rootNode.title !== undefined && { title: rootNode.title }),
      ...(rootNode.resourceTypeGeneral !== undefined && {
        resourceTypeGeneral: rootNode.resourceTypeGeneral,
      }),
      ...(rootNode.publicationYear !== undefined && { publicationYear: rootNode.publicationYear }),
      ...(rootNode.repositoryId !== undefined && { repositoryId: rootNode.repositoryId }),
    },
    nodes: [...nodes.values()],
    edges: keptEdges,
    ...(a && {
      rootCounts: {
        citationCount: a.citationCount ?? 0,
        referenceCount: a.referenceCount ?? 0,
        versionCount: a.versionCount ?? 0,
        versionOfCount: a.versionOfCount ?? 0,
        partCount: a.partCount ?? 0,
        partOfCount: a.partOfCount ?? 0,
      },
    }),
    coverage: {
      ownMetadata: { status: rootRecord ? 'ok' : 'not_datacite', edgeCount: ownEdgeCount },
      reverseMetadata: {
        status: 'ok',
        total: reverse.meta.total ?? reverse.data.length,
        fetched: reverse.data.length,
      },
      eventData: eventCoverage,
    },
  };
  return { graph, available, beyondFrontier, capBound, unexpanded };
}

/**
 * Hydrates every DOI node not yet looked up — one `ids=` batch per 100. The root
 * is included only when it is not a DataCite record, to pick up a linking copy's
 * title. `attempted` carries lookups already made, so a DOI `ids=` does not
 * return is asked for once.
 */
async function hydrateNodes(
  service: DataCiteService,
  nodes: Map<string, GraphNode>,
  attempted: Set<string>,
  ctx: Context,
  includeRoot = false,
): Promise<void> {
  const pending = [...nodes.values()]
    .filter(
      (n) =>
        !n.hydrated && !attempted.has(n.id) && n.idType === 'DOI' && (n.depth > 0 || includeRoot),
    )
    .map((n) => n.id);
  for (const id of pending) attempted.add(id);
  if (pending.length === 0) return;
  const records = await service.hydrate(pending, NODE_FIELDS, ctx);
  for (const [doi, record] of records) {
    const node = nodes.get(doi);
    if (node) Object.assign(node, hydratedFields(record));
  }
}

interface EventLink {
  from: Target;
  relationType: RelationTypeId;
  sourceId?: string;
  to: Target;
}

const eventTarget = (id: string): Target => {
  const doi = doiFromUrl(id);
  return doi ? { id: doi, idType: 'DOI' } : { id, idType: 'URL' };
};

/**
 * Reads the root's Event Data citation links. A DataCite root reads events on
 * either side; any other root reads its own outgoing events. Only a transient
 * failure degrades to `unavailable` — a cancelled request, and any other
 * failure of a request composed from validated input, still throw.
 */
async function readEvents(
  service: DataCiteService,
  root: string,
  rootIsDataCite: boolean,
  types: readonly RelationTypeId[],
  enabled: boolean,
  ctx: Context,
): Promise<{ coverage: EventCoverage; links: EventLink[] }> {
  if (!enabled) {
    return { coverage: { status: 'skipped', detail: 'include_event_data is false.' }, links: [] };
  }
  if (types.length === 0) {
    return {
      coverage: {
        status: 'skipped',
        detail:
          'relation_types admits no citation relation type, the only kind Event Data carries.',
      },
      links: [],
    };
  }
  const scope = rootIsDataCite ? 'both_sides' : 'outgoing_to_datacite';
  let list: Awaited<ReturnType<DataCiteService['getEvents']>>;
  try {
    list = await service.getEvents(
      {
        ...(rootIsDataCite ? { doi: root } : { subjId: `https://doi.org/${root}` }),
        relationTypeIds: types.map(relationTypeKebab),
      },
      ctx,
    );
  } catch (error) {
    if (ctx.signal.aborted || !(error instanceof McpError) || !TRANSIENT_CODES.has(error.code))
      throw error;
    ctx.log.warning('Event Data did not answer', { code: error.code });
    return {
      coverage: {
        status: 'unavailable',
        scope,
        detail: `Event Data did not answer (${error.message}).`,
      },
      links: [],
    };
  }

  const links: EventLink[] = [];
  for (const event of list.data) {
    const attrs = event.attributes;
    const subj = text(attrs['subj-id']);
    const obj = text(attrs['obj-id']);
    const relationType = text(attrs['relation-type-id']);
    const resolved = relationType ? resolveRelationType(relationType) : undefined;
    if (!subj || !obj || !resolved || !types.includes(resolved)) continue;
    const from = eventTarget(subj);
    const to = eventTarget(obj);
    if (from.id !== root && to.id !== root) continue;
    if (!rootIsDataCite && from.id !== root) continue;
    const sourceId = text(attrs['source-id']);
    links.push({ from, to, relationType: resolved, ...(sourceId && { sourceId }) });
  }
  return {
    coverage: {
      status: 'ok',
      scope,
      total: list.meta.total ?? list.data.length,
      fetched: list.data.length,
    },
    links,
  };
}
