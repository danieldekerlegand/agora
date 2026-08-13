/**
 * The topology — the cast of the graph and the links between them, both learned at runtime.
 *
 * A node is a participant the KCB discovery registry answered with: an identity, and the
 * address peers dial it at. Studio keeps no roster and reads no manifest of its own — the
 * `registry/` area already answers "who can do X, and where do I dial them", ranked by cost
 * (KCB §3), and this module is only the projection of that answer into something a view can
 * draw. Whoever is indexed is who appears; nobody is written down here.
 *
 * Three rules follow from that, and they are the whole file:
 *
 * 1. **Discovery arrives as an argument, never as a lookup.** The host hands in the find
 *    surface — the registry in-process, or a client onto a remote one — exactly the way the
 *    config seam is handed text. Nothing here goes and gets one, so this area still opens no
 *    transport at all.
 * 2. **An address is the end of it.** A node carries where a peer *would* dial, and Studio is
 *    never that peer (ADR-0001 decisions 3 and 7). Advertised capability names ride along as
 *    labels on the node — drawn, never invoked. An edge is likewise a *statement about* an
 *    MCP/A2A connection two participants hold with each other, and nothing that could carry a
 *    byte along it.
 * 3. **Every distinction is somebody else's answer.** Whether an edge is internal or external
 *    is a fact about the discovery index; whether two addresses are one entity is the KINP
 *    resolver's ruling; whether a route crosses planes is what the registry's path-finding
 *    computed. Studio asks and draws — it classifies nothing on its own.
 *
 * Discovery that answers with nobody yields no nodes: the same empty stage a fresh install
 * draws, which is a state and not a failure. That is also what makes the graph churn-safe —
 * a participant that has left the index simply is not in the next answer, and there is no
 * remembered cast for it to linger in.
 */
import type { CapabilityPath, FindQuery, Match, PathQuery } from '@agora/registry';
import type { EntityRef, ResolvedIdentity } from '@agora/resolver';
import type { Plane } from '@agora/schemas';
import { isDialable, transportOf, type ProviderAddress } from '@agora/sdk';

import type { Backbone, Connection, Participant } from './backbone.ts';

/**
 * One discovered participant, ready to draw.
 *
 * A {@link Participant} — so every view already reading a backbone reads a node too, `labelOf`
 * included — plus what only discovery and identity resolution can say: where it is dialable,
 * whether it published anything dialable at all, whether it is in the index, and which other
 * identities and addresses turned out to be this same entity.
 */
export interface TopologyNode extends Participant {
  /** Where peers connect directly. The registry's whole answer, carried verbatim. */
  address: ProviderAddress;
  /** False when the provider published no endpoint: discovered, indexed, and unreachable. */
  reachable: boolean;
  /** True when discovery answered with this participant; false for one only ever observed. */
  discovered: boolean;
  /** The other identities that resolved to this entity (KINP `same_as`), if any. */
  aliases?: readonly string[];
  /** The other addresses those identities were discovered at — kept, never merged into one. */
  alsoAt?: readonly ProviderAddress[];
}

/**
 * How an edge's ends sit relative to the discovery index — the internal/external split.
 *
 * `internal` means both ends are participants the registry answered with: wired into this
 * fabric and re-checked on every answer. `external` means an end is not in the index — an
 * outside MCP server or A2A peer that somebody here talks to. The distinction is read off
 * discovery, never assigned: a participant that joins the index turns its edges internal on
 * the next answer, with nothing here edited.
 */
export type EdgeScope = 'internal' | 'external';

/**
 * One MCP/A2A connection between two participants.
 *
 * A {@link Connection} — the shape the backbone already uses — plus what discovery adds: which
 * side of the index it lives on, and, when the link came from the registry's capability-path
 * search, the capability the far end serves and the plane the two hand off on.
 */
export interface TopologyEdge extends Connection {
  scope: EdgeScope;
  /** The capability the far end serves for this hop, when a discovered path named one. */
  capability?: string;
  /** The plane the two ends hand off on, as the registry's port typing had it (KCB §2.1). */
  plane?: Plane;
  /**
   * True when the far end consumes one plane and produces another — the registry found the
   * crossing while planning the route; Studio never infers one from a pair of manifests.
   */
  crossPlane?: boolean;
}

/** Nodes and the links between them: the whole picture a view draws. */
export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

/** A link before it has been scoped — an observed connection, or one hop of a planned route. */
type Link = Connection & Partial<Pick<TopologyEdge, 'capability' | 'plane' | 'crossPlane'>>;

/**
 * The discovery surface Studio reads — structurally the registry's own `find` (plus `path`).
 *
 * Stated as the verbs this area needs rather than as the registry class, so an in-process
 * `CapabilityRegistry`, a client onto a remote one, or a test's canned answer are the same
 * thing from here. Both are lookups that return addresses: `find` says who is there, `path`
 * plans a route across providers and planes (KCB §3 composition) and hands back the hops.
 * There is deliberately no third method on this type, because there is no other verb Studio
 * is entitled to. `path` is optional — a discovery surface that cannot plan simply has no
 * routes to draw.
 */
export interface Discovery {
  find(query?: FindQuery): readonly Match[] | Promise<readonly Match[]>;
  path?(query: PathQuery): CapabilityPath | undefined | Promise<CapabilityPath | undefined>;
}

/**
 * The identity surface Studio reads — structurally the KINP resolver's `resolve`.
 *
 * One verb, for the same reason {@link Discovery} has one: `resolve` dereferences an
 * identifier into the merged view (identity.md §4.1/§8), which is exactly what the graph
 * needs to stop drawing one entity as two nodes. `reconcile` is not on here — matching a
 * descriptor to candidates is an authority's judgement to make, not a view's.
 */
export interface IdentityResolver {
  resolve(ref: EntityRef): ResolvedIdentity | Promise<ResolvedIdentity>;
}

/**
 * The nodes a discovery answer describes, in the order discovery ranked them.
 *
 * Order is kept because it is meaningful: `find` returns cost-ranked matches (zero-cost first,
 * unpriced last), and re-sorting here would throw away a judgement the registry already made.
 * A match with no identity is dropped and a repeated identity collapses to its first sighting,
 * the same way the backbone treats a configured cast: one node per discovered address.
 */
export function nodesOf(matches?: readonly Match[] | null): TopologyNode[] {
  if (!matches) return [];

  const nodes: TopologyNode[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const identity = match?.identity?.trim();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);

    const address: ProviderAddress = match.address ?? { identity, endpoints: {} };
    const node: TopologyNode = {
      identity,
      address,
      reachable: isDialable(address),
      discovered: true,
    };

    const capabilities = (match.capabilities ?? [])
      .map((capability) => capability?.name?.trim())
      .filter((name): name is string => Boolean(name));
    if (capabilities.length) node.capabilities = capabilities;

    nodes.push(node);
  }
  return nodes;
}

/**
 * Ask discovery who is on the fabric, and project the answer into nodes.
 *
 * The default query is the empty one, which the registry reads as "every indexed provider" —
 * the graph's question is who is *there*, not who serves some capability Studio picked. Narrow
 * it by passing a query through; it is the registry's own {@link FindQuery}, unwrapped and
 * un-second-guessed.
 */
export async function discoverNodes(
  discovery: Discovery,
  query: FindQuery = {},
): Promise<TopologyNode[]> {
  return nodesOf(await discovery.find(query));
}

/**
 * Collapse the nodes that are one entity, as the KINP resolver rules them (identity.md §8).
 *
 * Two addresses for one thing are the normal case on a real fabric — a service re-registered
 * under a new identity, the same agent indexed by two registries — and drawing them as two
 * nodes is not a cosmetic problem: it is the graph asserting two participants where there is
 * one. So each node's identity goes to `resolve`, and the answer's own id plus its `same_as`
 * closure decide who is whom. The group keeps its first-sighted node's address (the ranking
 * discovery made survives), gains the others as {@link TopologyNode.alsoAt}, is reachable if
 * *any* of those addresses is, and carries the collapsed identities as
 * {@link TopologyNode.aliases} so the edges can be re-pointed at it.
 *
 * `based_on` is deliberately never joined. The firewall in identity.md §4.3 is that facts flow
 * across `same_as` and do not flow across lineage — a graph that merged a thing with what it
 * was modeled on would draw the contamination that spec exists to prevent.
 *
 * With no resolver, nothing merges: the nodes come back as they went in. Same when the
 * resolver refuses or is unreachable for a particular id — a resolver that cannot answer
 * degrades the merge, and must never be able to delete a participant from the picture.
 */
export async function resolveNodes(
  nodes: readonly TopologyNode[],
  resolver?: IdentityResolver | null,
): Promise<TopologyNode[]> {
  if (!resolver) return [...nodes];

  const parent = new Map<string, string>();
  const rootOf = (identity: string): string => {
    let current = identity;
    for (;;) {
      const next = parent.get(current);
      if (next === undefined || next === current) return current;
      current = next;
    }
  };
  const join = (a: string, b: string): void => {
    const left = rootOf(a);
    const right = rootOf(b);
    if (left !== right) parent.set(right, left);
  };

  const canonical = new Map<string, string>();
  for (const node of nodes) {
    let answer: ResolvedIdentity | undefined;
    try {
      answer = await resolver.resolve({ id: node.identity });
    } catch {
      answer = undefined;
    }
    if (!answer) continue;

    const resolved = answer.id?.trim();
    if (resolved) {
      canonical.set(node.identity, resolved);
      join(node.identity, resolved);
    }
    for (const same of answer.sameAs ?? []) {
      const other = same?.trim();
      if (other) join(node.identity, other);
    }
  }

  const order: string[] = [];
  const groups = new Map<string, TopologyNode[]>();
  for (const node of nodes) {
    const key = rootOf(node.identity);
    const group = groups.get(key);
    if (group) group.push(node);
    else {
      groups.set(key, [node]);
      order.push(key);
    }
  }

  const merged: TopologyNode[] = [];
  for (const key of order) {
    const members = groups.get(key) ?? [];
    const first = members[0];
    if (!first) continue;

    const identity = canonical.get(first.identity) ?? first.identity;
    const aliases: string[] = [];
    const alsoAt: ProviderAddress[] = [];
    const capabilities: string[] = [];
    let reachable = false;
    let discovered = false;

    for (const member of members) {
      discovered = discovered || member.discovered;
      for (const name of [member.identity, ...(member.aliases ?? [])]) {
        if (name !== identity && !aliases.includes(name)) aliases.push(name);
      }
      for (const address of addressesOf(member)) {
        if (isDialable(address)) reachable = true;
        if (address !== first.address && !alsoAt.includes(address)) alsoAt.push(address);
      }
      for (const capability of member.capabilities ?? []) {
        if (!capabilities.includes(capability)) capabilities.push(capability);
      }
    }

    const node: TopologyNode = { ...first, identity, reachable, discovered };
    if (capabilities.length) node.capabilities = capabilities;
    if (aliases.length) node.aliases = aliases;
    if (alsoAt.length) node.alsoAt = alsoAt;
    merged.push(node);
  }
  return merged;
}

/**
 * The edges among a set of nodes: one per link, pointed at whoever the nodes turned out to be.
 *
 * Every end is re-pointed through the nodes' aliases first, so a link named against an address
 * that has since been merged lands on the surviving node — and a link whose two ends are the
 * same entity is dropped, because it was never a connection between participants. A link to an
 * end there is no node for is dropped too: that is the backbone's own rule (drawing a line to
 * something it cannot draw would be Studio asserting a participant nobody reported).
 *
 * Transport is the observation when the link carried one, and otherwise the transport the far
 * end's published address is dialed over — `transportOf` from the SDK, so the naming is the
 * one projection the whole tree shares rather than a second guess at it.
 */
export function edgesOf(
  nodes: readonly TopologyNode[],
  links?: readonly Link[] | null,
): TopologyEdge[] {
  if (!links?.length) return [];

  const canonical = canonicalIdentities(nodes);
  const byIdentity = new Map(nodes.map((node) => [node.identity, node]));

  const edges: TopologyEdge[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const from = canonical.get(link?.from?.trim() ?? '');
    const to = canonical.get(link?.to?.trim() ?? '');
    if (!from || !to || from === to) continue;

    const target = byIdentity.get(to);
    const scope: EdgeScope =
      byIdentity.get(from)?.discovered && target?.discovered ? 'internal' : 'external';
    const edge: TopologyEdge = { from, to, scope };

    const transport = link.transport?.trim() || transportAt(target);
    if (transport) edge.transport = transport;
    if (link.capability) edge.capability = link.capability;
    if (link.plane) edge.plane = link.plane;
    if (link.crossPlane) edge.crossPlane = true;

    const key = `${from} ${to} ${edge.transport ?? ''} ${edge.capability ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(edge);
  }
  return edges;
}

/**
 * The hops of a planned route, as edges — the registry's cross-plane path-finding, drawn.
 *
 * KCB §3 composition: the registry computes a path from a start port to a goal port across
 * planes and providers, and hands back a *plan* the caller then dials hop by hop (ADR-0001
 * decision 3). Studio dials none of it — it draws the plan's shape, one edge per handoff,
 * carrying the plane the two ends agreed on and the capability the far end serves. Both ends
 * of every hop came out of the index, which is what makes these edges internal.
 *
 * A one-hop plan has no handoff and so draws no edge: a route through a single provider is
 * that provider, and inventing a self-link for it would be drawing a connection nobody holds.
 */
export function pathEdges(path?: CapabilityPath | null): TopologyEdge[] {
  const steps = path?.steps ?? [];
  const edges: TopologyEdge[] = [];

  for (let hop = 1; hop < steps.length; hop += 1) {
    const producer = steps[hop - 1];
    const consumer = steps[hop];
    if (!producer || !consumer) continue;

    const edge: TopologyEdge = {
      from: producer.identity,
      to: consumer.identity,
      scope: 'internal',
      capability: consumer.capability,
      plane: producer.output.plane,
    };
    const transport =
      consumer.endpoint === undefined
        ? transportOf(consumer.address)
        : transportOf(consumer.address, { endpoint: consumer.endpoint });
    if (transport) edge.transport = transport;
    if (consumer.input.plane !== consumer.output.plane) edge.crossPlane = true;

    edges.push(edge);
  }
  return edges;
}

/** What the graph is assembled from: who discovery found, what was watched, what was planned. */
export interface TopologyInput {
  /** Discovery's answer, already projected — {@link discoverNodes} / {@link resolveNodes}. */
  nodes?: readonly TopologyNode[] | null;
  /** What the host actually watched: its participants and the connections between them. */
  observed?: Partial<Backbone> | null;
  /** Routes the registry's path-finding planned, each drawn as the hops it named. */
  paths?: readonly (CapabilityPath | undefined | null)[] | null;
}

/**
 * Assemble the graph: discovered nodes first, then whoever was watched but is not in the index.
 *
 * An observed participant discovery has never heard of is still on the picture — it is the
 * outside end of an external connection, and leaving it off would leave the connection
 * undrawable. It is marked `discovered: false` and carries no address, because Studio was told
 * about it rather than handed a manifest for it; that is precisely the difference the
 * internal/external split on each edge reports.
 *
 * Discovery's ranking survives into the node order, and the observed extras follow it.
 */
export function topologyOf(input?: TopologyInput | null): Topology {
  const discovered: TopologyNode[] = [];
  const placed = new Set<string>();
  for (const node of input?.nodes ?? []) {
    const identity = node?.identity?.trim();
    if (!identity || placed.has(identity)) continue;
    placed.add(identity);
    discovered.push(node);
  }

  const canonical = canonicalIdentities(discovered);
  const nodes: TopologyNode[] = [...discovered];
  for (const participant of input?.observed?.participants ?? []) {
    const watched = participant?.identity?.trim();
    if (!watched) continue;
    const identity = canonical.get(watched) ?? watched;
    if (placed.has(identity)) continue;
    placed.add(identity);
    nodes.push({
      ...participant,
      identity,
      address: { identity, endpoints: {} },
      reachable: false,
      discovered: false,
    });
  }

  const links: Link[] = [
    ...(input?.observed?.connections ?? []),
    ...(input?.paths ?? []).flatMap((path) => pathEdges(path)),
  ];
  return { nodes, edges: edgesOf(nodes, links) };
}

/** Everything {@link discoverTopology} needs: the two surfaces, and what to ask them. */
export interface TopologyQuery {
  discovery: Discovery;
  /** The KINP resolver, when the host has one. Without it, no node is merged with another. */
  resolver?: IdentityResolver;
  /** Narrows who is asked for; the default empty query means every indexed participant. */
  query?: FindQuery;
  /** Routes to have the registry plan, so the graph shows the cross-plane paths that exist. */
  routes?: readonly PathQuery[];
  /** What the host watched — the connections it saw, including the ones leaving the fabric. */
  observed?: Partial<Backbone> | null;
}

/**
 * One pass over both lookup surfaces: who is there, who they really are, and how they connect.
 *
 * This is the whole graph in one call, which is what makes churn cheap — run it again and the
 * answer is whatever is true now. Nothing is remembered between passes, so a participant that
 * left the index is gone from the next result rather than lingering as a stale node.
 *
 * A discovery surface with no path-finding simply contributes no planned routes; asking for
 * routes it cannot plan is not an error, it is an answer with fewer edges in it.
 */
export async function discoverTopology(options: TopologyQuery): Promise<Topology> {
  const found = await discoverNodes(options.discovery, options.query ?? {});
  const nodes = await resolveNodes(found, options.resolver);

  const paths: CapabilityPath[] = [];
  const plan = options.discovery.path;
  if (plan) {
    for (const route of options.routes ?? []) {
      const path = await plan.call(options.discovery, route);
      if (path) paths.push(path);
    }
  }

  return topologyOf({ nodes, observed: options.observed ?? null, paths });
}

/** Every identity that points at a node — its own, plus whatever merged into it. */
function canonicalIdentities(nodes: readonly TopologyNode[]): Map<string, string> {
  const canonical = new Map<string, string>();
  for (const node of nodes) {
    canonical.set(node.identity, node.identity);
    for (const alias of node.aliases ?? []) canonical.set(alias, node.identity);
  }
  return canonical;
}

/** Every address a node was discovered at: the one it kept, then the ones merged into it. */
function addressesOf(node: TopologyNode): ProviderAddress[] {
  return [node.address, ...(node.alsoAt ?? [])];
}

/** The transport a node's published address is dialed over, whichever of its addresses serves. */
function transportAt(node?: TopologyNode): string | undefined {
  if (!node) return undefined;
  for (const address of addressesOf(node)) {
    const transport = transportOf(address);
    if (transport) return transport;
  }
  return undefined;
}
