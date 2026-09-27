/**
 * @fileoverview Relation-graph builder for `datacite_trace_relations`. Collects
 * edges exactly as asserted — the root's own `relatedIdentifiers`, other DataCite
 * records that point at it (verified pair by pair), and Event Data citation
 * links — merges identical edges across sources, fills the node budget and the
 * edge cap in a fixed order, hydrates DOI nodes in batches within a time budget,
 * and optionally expands a second hop through own and reverse metadata.
 * @module services/datacite/relation-graph
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  ATTEMPT_TIMEOUT_MS,
  CALL_DEADLINE_MS,
  callStartedAt,
  isUnanswered,
} from '@/services/http/upstream-client.js';
import {
  CITATION_RELATION_TYPES,
  inverseRelationType,
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
import { firstTitle, publicationYear, recordDoi, text } from './mappers.js';
import { doiFromUrl, normalizeDoi } from './normalize.js';
import { reverseRelationQuery } from './query-builder.js';
import type { RawDoiResource, RawEventList } from './types.js';

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

/** One reverse query's reach: records matching upstream, and records read. */
export interface ReverseRead {
  fetched: number;
  total: number;
}

/** A reverse query's records and reach; `listed` when the first page's related identifiers stopped the read. */
interface ReverseRecords {
  listed?: number;
  read: ReverseRead;
  records: RawDoiResource[];
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
    reverseMetadata: {
      fetched: number;
      secondHop?: ReverseRead;
      status: 'ok';
      total: number;
    };
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
  /** Edges between the returned nodes before {@link MAX_EDGES} applied; above `graph.edges.length` when it bound. */
  edgesFound: number;
  /** Every edge found, including those the cap dropped with an endpoint it left out. */
  foundEdges: GraphEdge[];
  graph: RelationGraph;
  /**
   * Per hop, the related identifiers a reverse query's first page listed when their
   * number stopped the read at that page ({@link LARGE_PAGE_IDENTIFIERS}).
   */
  largeReverse: { root?: number; secondHop?: number };
  /**
   * Event Data objects of a non-DataCite root left out because their lookup did not
   * answer in time, so nothing showed them to be DataCite DOIs.
   */
  unconfirmedEvents: number;
  /** DataCite depth-1 nodes whose relations a requested second hop had no room to trace. */
  unexpanded: number;
  /** Returned nodes left unhydrated because their lookup did not answer in time. */
  unhydrated: number;
}

/** Frontier nodes a second hop expands: the first DataCite depth-1 nodes in node order. */
export const MAX_FRONTIER = 10;

/**
 * Edges one call returns, the first found. `relationType` is upstream text and each
 * distinct one is its own edge, so `max_nodes` alone does not bound the edge list.
 */
export const MAX_EDGES = 1000;

/**
 * Records each reverse query reads, whatever `maxNodes` is: every verified record
 * counts toward `available`, so the cap binds on what did not fit rather than on
 * what was never read. Read only when the first page shows the records small.
 */
export const REVERSE_PAGE_SIZE = 100;

/**
 * Records a reverse query reads first. The upstream's time for this query grows with
 * the size of the records it returns: for a dataset that thousands of GBIF downloads
 * derive from, each download listing thousands of related identifiers, 10 records
 * measured 16 MB in 12.7 s, and 100 measured 123 MB in 71 s.
 */
const REVERSE_FIRST_PAGE = 10;

/**
 * Related identifiers a full first page may list between them for the
 * {@link REVERSE_PAGE_SIZE} page to be read: about 1 MB of JSON, so the full page
 * projects to about 10 MB, a third of the 32,000,000-byte body limit.
 */
const LARGE_PAGE_IDENTIFIERS = 10_000;

/**
 * How long after the call starts a hydration that nothing upstream follows may run.
 * Hydration is best-effort: past this no further batch is sent, those in flight are
 * cancelled, and their nodes stay unhydrated. It ends 5 s inside the 45 s request
 * deadline, so the notices and output always complete.
 */
const HYDRATION_DEADLINE_MS = CALL_DEADLINE_MS - 5_000;

/**
 * The same for a hydration a second hop may still follow: one 20 s attempt earlier,
 * so the second hop's own and reverse reads keep a full attempt.
 */
const PRE_SECOND_HOP_HYDRATION_DEADLINE_MS = CALL_DEADLINE_MS - ATTEMPT_TIMEOUT_MS;

interface Target {
  id: string;
  idType: string;
}

/** Nodes waiting for the budget, keyed by id, in admission order, with any record already in hand. */
type CandidatePool = Map<string, { idType: string; record?: RawDoiResource }>;

/**
 * The node a related identifier names. A DOI-typed value, and a doi.org URL
 * stored as a URL, become the bare lowercase DOI so they merge with the DOI node.
 */
function relatedTarget(identifier: string, type: string | undefined): Target {
  if (type === 'DOI') return { id: normalizeDoi(identifier) ?? identifier, idType: 'DOI' };
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
  const { root, maxNodes, relationTypes } = request;
  /**
   * `relationTypes` names relations as the traced node sees them. An edge the traced
   * node asserts passes on its own type; an edge asserted on the traced node passes on
   * its inverse, so `HasPart` keeps the records asserting `IsPartOf` it.
   */
  const filter = relationTypes?.length ? new Set<string>(relationTypes) : undefined;
  const allowedOut = (type: string) => !filter || filter.has(type);
  const allowedIn = (type: string) => !filter || filter.has(inverseRelationType(type));
  /** What the asserting side of a reverse match records. */
  const reverseTypes = filter && [...new Set([...filter].map(inverseRelationType))];

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

  const candidates: CandidatePool = new Map();
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
    if (!allowedOut(assertion.relationType)) continue;
    addEdge(root, assertion.id, assertion.relationType, 'metadata');
    addCandidate(assertion);
    ownEdgeCount++;
  }

  /**
   * Calls 2 ∥ 3: records asserting a relation to the root, and Event Data — which is
   * read on either side of a DataCite root, and on the outgoing side of any other root.
   */
  const eventTypes = CITATION_RELATION_TYPES.filter(
    (type) => allowedOut(type) || (rootRecord !== undefined && allowedIn(type)),
  );
  const [reverse, events] = await Promise.all([
    readReverse(service, reverseRelationQuery([root], reverseTypes), ctx),
    readEvents(service, root, rootRecord !== undefined, eventTypes, request.includeEventData, ctx),
  ]);

  for (const record of reverse.records) {
    const from = recordDoi(record);
    if (from === root) continue;
    let asserted = false;
    for (const assertion of assertions(record)) {
      if (assertion.id !== root || !allowedIn(assertion.relationType)) continue;
      addEdge(from, root, assertion.relationType, 'reverse_metadata');
      asserted = true;
    }
    if (asserted) addCandidate({ id: from, idType: 'DOI' }, record);
  }

  /**
   * Hydration deadlines, from the call's start. Which lookups did not answer in time
   * is kept, so the nodes left unhydrated can be counted.
   */
  const startedAt = callStartedAt(ctx);
  const finalDeadline = startedAt + HYDRATION_DEADLINE_MS;
  const preSecondHopDeadline = startedAt + PRE_SECOND_HOP_HYDRATION_DEADLINE_MS;
  const unanswered = new Set<string>();

  // A non-DataCite root keeps only outgoing events whose object is a DataCite DOI,
  // which needs the objects hydrated before the node budget is spent.
  let hydratedEarly = new Map<string, RawDoiResource>();
  let unconfirmedEvents = 0;
  const attempted = new Set<string>();
  let kept = events.links.filter((l) =>
    (l.from.id === root ? allowedOut : allowedIn)(l.relationType),
  );
  if (!rootRecord && kept.length > 0) {
    const objects = [...new Set(kept.filter((l) => l.to.idType === 'DOI').map((l) => l.to.id))];
    for (const doi of objects) attempted.add(doi);
    const early = await service.hydrate(
      objects,
      NODE_FIELDS,
      ctx,
      request.depth >= 2 ? preSecondHopDeadline : finalDeadline,
    );
    hydratedEarly = early.records;
    unconfirmedEvents = early.unanswered.size;
    kept = kept.filter((l) => hydratedEarly.get(l.to.id)?.relationships?.client?.data != null);
  }
  for (const link of kept) {
    addEdge(link.from.id, link.to.id, link.relationType, 'event_data', link.sourceId);
    addCandidate(link.from.id === root ? link.to : link.from);
  }
  const eventCoverage: EventCoverage =
    events.coverage.status === 'ok' ? { ...events.coverage, kept: kept.length } : events.coverage;

  // Node budget: root first, then candidates in insertion order.
  const rootNode: GraphNode = { id: root, idType: 'DOI', depth: 0, hydrated: false };
  const nodes = new Map([[root, rootNode]]);
  let available = candidates.size;
  const admit = (depth: number, pool: CandidatePool) => {
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
  let secondHop: ReverseRecords | undefined;

  /**
   * Calls 5 ∥ 6: the second hop through own and reverse metadata of DataCite frontier nodes.
   * Which depth-1 nodes are DataCite DOIs is known only after hydration, so a first hop that
   * filled the cap is hydrated too, to tell whether it left the second hop no room.
   */
  if (request.depth >= 2) {
    // The second hop runs only while the first leaves a node free.
    const firstHopDeadline = nodes.size < maxNodes ? preSecondHopDeadline : finalDeadline;
    for (const id of await hydrateNodes(
      service,
      nodes,
      attempted,
      ctx,
      rootRecord === undefined,
      firstHopDeadline,
    )) {
      unanswered.add(id);
    }
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
        readReverse(service, reverseRelationQuery(frontier, reverseTypes), ctx),
      ]);
      secondHop = reverse2;
      const second: CandidatePool = new Map();
      const addSecond = (target: Target, record?: RawDoiResource) => {
        if (nodes.has(target.id) || second.has(target.id)) return;
        second.set(target.id, { idType: target.idType, ...(record && { record }) });
      };
      for (const [from, record] of own.records) {
        for (const assertion of assertions(record)) {
          if (!allowedOut(assertion.relationType)) continue;
          addEdge(from, assertion.id, assertion.relationType, 'metadata');
          addSecond(assertion);
        }
      }
      for (const record of reverse2.records) {
        const from = recordDoi(record);
        if (from === root) continue;
        let asserted = false;
        for (const assertion of assertions(record)) {
          if (!frontierSet.has(assertion.id) || !allowedIn(assertion.relationType)) continue;
          addEdge(from, assertion.id, assertion.relationType, 'reverse_metadata');
          asserted = true;
        }
        if (asserted) addSecond({ id: from, idType: 'DOI' }, record);
      }
      available += second.size;
      capBound = !admit(2, second);
    }
  }

  for (const id of await hydrateNodes(
    service,
    nodes,
    attempted,
    ctx,
    rootRecord === undefined,
    finalDeadline,
  )) {
    unanswered.add(id);
  }
  if (rootRecord) Object.assign(rootNode, hydratedFields(rootRecord));

  const foundEdges = [...edges.values()];
  const keptEdges = foundEdges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
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
    edges: keptEdges.slice(0, MAX_EDGES),
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
        ...reverse.read,
        ...(secondHop && { secondHop: secondHop.read }),
      },
      eventData: eventCoverage,
    },
  };
  return {
    graph,
    available,
    beyondFrontier,
    capBound,
    edgesFound: keptEdges.length,
    foundEdges,
    largeReverse: {
      ...(reverse.listed !== undefined && { root: reverse.listed }),
      ...(secondHop?.listed !== undefined && { secondHop: secondHop.listed }),
    },
    unconfirmedEvents,
    unexpanded,
    unhydrated: [...nodes.keys()].filter((id) => unanswered.has(id)).length,
  };
}

/**
 * Reads the records a reverse query matches, newest first: a first page of
 * {@link REVERSE_FIRST_PAGE}, then the {@link REVERSE_PAGE_SIZE} page when more match
 * and the first page lists at most {@link LARGE_PAGE_IDENTIFIERS} related identifiers
 * between them. `listed` is set when that count stopped the read at the first page.
 */
async function readReverse(
  service: DataCiteService,
  query: string,
  ctx: Context,
): Promise<ReverseRecords> {
  const first = await service.queryRecords(query, REVERSE_FIELDS, REVERSE_FIRST_PAGE, ctx);
  const total = first.meta.total ?? first.data.length;
  const read = { total, fetched: first.data.length };
  if (total <= first.data.length) return { read, records: first.data };
  const listed = first.data.reduce(
    (sum, record) => sum + (record.attributes.relatedIdentifiers?.length ?? 0),
    0,
  );
  if (listed > LARGE_PAGE_IDENTIFIERS) return { listed, read, records: first.data };
  const page = await service.queryRecords(query, REVERSE_FIELDS, REVERSE_PAGE_SIZE, ctx);
  return {
    read: { total: page.meta.total ?? page.data.length, fetched: page.data.length },
    records: page.data,
  };
}

/**
 * Hydrates every DOI node not yet looked up, best-effort until `deadline`, and
 * returns the DOIs whose lookup did not answer in time. The root is included only
 * when it is not a DataCite record, to pick up a linking copy's title. `attempted`
 * carries lookups already made, so each DOI is asked for once, whether `ids=` left
 * it out or did not answer.
 */
async function hydrateNodes(
  service: DataCiteService,
  nodes: Map<string, GraphNode>,
  attempted: Set<string>,
  ctx: Context,
  includeRoot: boolean,
  deadline: number,
): Promise<Set<string>> {
  const pending = [...nodes.values()]
    .filter(
      (n) =>
        !n.hydrated && !attempted.has(n.id) && n.idType === 'DOI' && (n.depth > 0 || includeRoot),
    )
    .map((n) => n.id);
  for (const id of pending) attempted.add(id);
  if (pending.length === 0) return new Set();
  const { records, unanswered } = await service.hydrate(pending, NODE_FIELDS, ctx, deadline);
  for (const [doi, record] of records) {
    const node = nodes.get(doi);
    if (node) Object.assign(node, hydratedFields(record));
  }
  return unanswered;
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
  let list: RawEventList;
  try {
    list = await service.getEvents(
      {
        ...(rootIsDataCite ? { doi: root } : { subjId: `https://doi.org/${root}` }),
        relationTypeIds: types.map(relationTypeKebab),
      },
      ctx,
    );
  } catch (error) {
    if (ctx.signal.aborted || !isUnanswered(error)) throw error;
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
