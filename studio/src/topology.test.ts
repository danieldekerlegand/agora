/**
 * The graph's cast comes from discovery, and from nowhere else.
 *
 * These tests drive a **real** registry — `@agora/registry`'s own index and `find` — rather
 * than hand-built match objects, because the claim under test is that Studio consumes the
 * discovery surface as it is instead of re-implementing a lookup. The manifests below are
 * sample data authored for this file (the `.example` hostnames beside them say so); no name
 * here is known to `studio/src`, which is the point — the same registry populated with anyone
 * else's manifests yields their graph instead.
 */
import { createRegistry } from '@agora/registry';
import { createAuthorityResolver } from '@agora/resolver';
import { SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { labelOf } from './backbone.ts';
import {
  discoverNodes,
  discoverTopology,
  edgesOf,
  nodesOf,
  pathEdges,
  resolveNodes,
  topologyOf,
  type Discovery,
} from './topology.ts';

const kcb_version = SPEC_VERSIONS.kcb;

/** A free local hop — cheapest, so discovery ranks it first (KCB §3 delta K). */
const FREE: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:free-hop',
  endpoints: { mcp: 'https://free.example/mcp' },
  capabilities: [
    {
      name: 'render',
      inputs: [{ plane: 'media', media_types: ['audio/midi'] }],
      outputs: [{ plane: 'media', media_types: ['audio/wav'] }],
      cost: { tier: 'local', est_units: 0 },
    },
  ],
};

/** The same hop, paid — present so the ranking has something to order. */
const PAID: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:paid-hop',
  endpoints: { a2a: 'https://paid.example/.well-known/agent-card.json' },
  capabilities: [
    {
      name: 'render',
      inputs: [{ plane: 'media', media_types: ['audio/midi'] }],
      outputs: [{ plane: 'media', media_types: ['audio/wav'] }],
      cost: { tier: 'paid', est_units: 900 },
    },
  ],
};

/** Indexed, with capabilities but no published endpoint: discovered and unreachable. */
const UNREACHABLE: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:silent',
  endpoints: {},
  capabilities: [{ name: 'describe' }],
};

function indexed(...manifests: CapabilityManifest[]) {
  const registry = createRegistry();
  for (const manifest of manifests) registry.register(manifest);
  return registry;
}

describe('nodes are whoever discovery answered with', () => {
  it('draws one node per discovered address, and nothing it was not told about', async () => {
    const nodes = await discoverNodes(indexed(FREE, PAID, UNREACHABLE));

    expect(nodes.map((node) => node.identity)).toEqual([
      FREE.identity,
      PAID.identity,
      UNREACHABLE.identity,
    ]);
  });

  it('carries the address the registry handed back, verbatim', async () => {
    const [node] = await discoverNodes(indexed(FREE));

    expect(node?.address).toEqual({ identity: FREE.identity, endpoints: FREE.endpoints });
    expect(node?.reachable).toBe(true);
  });

  it('keeps the ranking discovery already made rather than imposing an order of its own', async () => {
    // PAID is registered first; the free route still leads, because that is the judgement
    // `find` already made and Studio has no business re-making it.
    const nodes = await discoverNodes(indexed(PAID, FREE));

    expect(nodes.map((node) => node.identity)).toEqual([FREE.identity, PAID.identity]);
  });

  it('shows the capability names a provider advertises, as labels and never as buttons', async () => {
    const [node] = await discoverNodes(indexed(FREE));

    expect(node?.capabilities).toEqual(['render']);
    // The only verb on a node is reading it: nothing here is callable.
    expect(Object.values(node ?? {}).some((value) => typeof value === 'function')).toBe(false);
  });

  it('marks a provider that published nothing dialable as unreachable, but still draws it', async () => {
    const [node] = await discoverNodes(indexed(UNREACHABLE));

    expect(node?.identity).toBe(UNREACHABLE.identity);
    expect(node?.reachable).toBe(false);
  });

  it('names a node with its identity, because discovery publishes no display name', async () => {
    const [node] = await discoverNodes(indexed(FREE));

    expect(node && labelOf(node)).toBe(FREE.identity);
  });

  it('narrows to a query when the caller passes one, and answers with that alone', async () => {
    const nodes = await discoverNodes(indexed(FREE, UNREACHABLE), { capability: 'describe' });

    expect(nodes.map((node) => node.identity)).toEqual([UNREACHABLE.identity]);
  });
});

describe('an empty fabric is a state, not a failure', () => {
  it('has no nodes when discovery knows nobody', async () => {
    expect(await discoverNodes(indexed())).toEqual([]);
    expect(nodesOf([])).toEqual([]);
    expect(nodesOf(undefined)).toEqual([]);
    expect(nodesOf(null)).toEqual([]);
  });

  it('loses a node the moment discovery stops answering with it', async () => {
    const registry = indexed(FREE, PAID);
    registry.remove(PAID.identity);

    const nodes = await discoverNodes(registry);
    expect(nodes.map((node) => node.identity)).toEqual([FREE.identity]);
  });
});

describe('the projection is defensive about what it is handed', () => {
  it('collapses a repeated identity to one node', () => {
    const twice = [
      { identity: 'sample:agent:twice', endpoints: { mcp: 'https://one.example/mcp' } },
      { identity: 'sample:agent:twice', endpoints: { mcp: 'https://two.example/mcp' } },
    ].map((address) => ({
      identity: address.identity,
      address,
      capabilities: [],
      estUnits: 0,
      unpriced: true,
      registration: undefined,
    }));

    const nodes = nodesOf(twice as unknown as Parameters<typeof nodesOf>[0]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.address.endpoints.mcp).toBe('https://one.example/mcp');
  });

  it('takes any find surface, not just the registry class', async () => {
    const canned: Discovery = { find: () => [] };
    expect(await discoverNodes(canned)).toEqual([]);
  });
});

/** Consumes what the render hop produces and leaves the media plane: a crossing, priced free. */
const CROSSING: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:crossing',
  endpoints: { a2a: 'https://crossing.example/.well-known/agent-card.json' },
  capabilities: [
    {
      name: 'describe.audio',
      inputs: [{ plane: 'media', media_types: ['audio/wav'] }],
      outputs: [{ plane: 'knowledge' }],
      cost: { tier: 'local', est_units: 0 },
    },
  ],
};

/** Sample data for an outside peer: the identity is registered only where a test says so. */
const OUTSIDE = 'outside:agent:vendor-mcp';

/** The same outside peer, once it publishes a manifest and the index answers with it. */
const VENDOR: CapabilityManifest = {
  kcb_version,
  identity: OUTSIDE,
  endpoints: { mcp: 'https://vendor.example/mcp' },
  capabilities: [{ name: 'search' }],
};

/** One entity, indexed twice: this half published nothing dialable... */
const TWIN_HERE: CapabilityManifest = {
  kcb_version,
  identity: 'sample:ent:twin-here',
  endpoints: {},
  capabilities: [{ name: 'observe' }],
};

/** ...and this half did. Only the authority knows they are the same thing. */
const TWIN_THERE: CapabilityManifest = {
  kcb_version,
  identity: 'sample:ent:twin-there',
  endpoints: { mcp: 'https://twin.example/mcp' },
  capabilities: [{ name: 'observe' }],
};

/**
 * A **real** KINP resolver, told what its authority says.
 *
 * The stub is the authority's HTTP surface, not the resolver: the `same_as` closure, the
 * lineage firewall and the offline behaviour under test are all `@agora/resolver`'s own, which
 * is the claim — Studio reads the resolver's ruling rather than deciding sameness itself.
 * Only `ent` ids are dialed at all (identity.md §6), so an agent-kind node never leaves here.
 */
function authorityStating(
  links: Record<string, string[]>,
  relation: 'same_as' | 'based_on' = 'same_as',
) {
  return createAuthorityResolver({
    endpoint: 'https://authority.example',
    fetch: (url) => {
      const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      const stated = links[id];
      if (stated === undefined) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ [relation]: stated }),
      });
    },
  });
}

const TWINS = {
  [TWIN_HERE.identity]: [TWIN_THERE.identity],
  [TWIN_THERE.identity]: [TWIN_HERE.identity],
};

describe('an edge is typed by which side of the discovery index it ends on', () => {
  const observed = {
    participants: [{ identity: OUTSIDE, label: 'an outside peer' }],
    connections: [
      { from: FREE.identity, to: PAID.identity },
      { from: FREE.identity, to: OUTSIDE, transport: 'mcp' },
    ],
  };

  it('calls a link between two discovered participants internal, and one leaving the index external', async () => {
    const topology = await discoverTopology({ discovery: indexed(FREE, PAID), observed });

    expect(topology.edges).toEqual([
      // No transport was observed for this one, so it is named from the address the registry
      // handed back — the SDK's projection, not a second guess at it.
      { from: FREE.identity, to: PAID.identity, scope: 'internal', transport: 'a2a' },
      { from: FREE.identity, to: OUTSIDE, scope: 'external', transport: 'mcp' },
    ]);
  });

  it('draws the outside end, and says plainly that it was told about it rather than shown it', async () => {
    const topology = await discoverTopology({ discovery: indexed(FREE, PAID), observed });
    const outside = topology.nodes.find((node) => node.identity === OUTSIDE);

    expect(outside?.discovered).toBe(false);
    expect(outside?.address.endpoints).toEqual({});
    expect(topology.nodes.filter((node) => node.discovered)).toHaveLength(2);
  });

  it('turns that same edge internal the moment discovery answers with the far end', async () => {
    // Nothing here is edited when a peer joins the index: the scope is re-read every pass.
    const topology = await discoverTopology({ discovery: indexed(FREE, PAID, VENDOR), observed });

    const leaving = topology.edges.find((edge) => edge.to === OUTSIDE);
    expect(leaving?.scope).toBe('internal');
    expect(topology.nodes.every((node) => node.discovered)).toBe(true);
  });

  it('draws no line to an end nobody reported', async () => {
    const topology = await discoverTopology({
      discovery: indexed(FREE),
      observed: { connections: [{ from: FREE.identity, to: OUTSIDE }] },
    });

    expect(topology.edges).toEqual([]);
  });

  it('has no edges at all when nothing was watched and nothing was planned', async () => {
    const topology = await discoverTopology({ discovery: indexed(FREE, PAID) });

    expect(topology.edges).toEqual([]);
    expect(topology.nodes).toHaveLength(2);
  });
});

describe('a cross-plane route is the registry path-finding, drawn', () => {
  const route = {
    from: { plane: 'media', mediaType: 'audio/midi' },
    to: { plane: 'knowledge' },
  } as const;

  it('draws one edge per handoff, carrying the plane and the capability the plan named', async () => {
    const topology = await discoverTopology({
      discovery: indexed(FREE, CROSSING),
      routes: [route],
    });

    expect(topology.edges).toEqual([
      {
        from: FREE.identity,
        to: CROSSING.identity,
        scope: 'internal',
        transport: 'a2a',
        capability: 'describe.audio',
        plane: 'media',
        crossPlane: true,
      },
    ]);
  });

  it('draws nothing for a route the registry could not plan', async () => {
    const topology = await discoverTopology({ discovery: indexed(FREE), routes: [route] });

    expect(topology.edges).toEqual([]);
  });

  it('draws no edge for a single-provider plan: one hop is not a connection', () => {
    const registry = indexed(FREE);
    const path = registry.path({
      from: { plane: 'media', mediaType: 'audio/midi' },
      to: { plane: 'media', mediaType: 'audio/wav' },
    });

    expect(path?.steps).toHaveLength(1);
    expect(pathEdges(path)).toEqual([]);
    expect(pathEdges(undefined)).toEqual([]);
  });
});

describe('two addresses for one entity are one node, because the resolver says so', () => {
  it('collapses them, keeps both addresses, and is reachable if either one is', async () => {
    const topology = await discoverTopology({
      discovery: indexed(TWIN_HERE, TWIN_THERE),
      resolver: authorityStating(TWINS),
    });

    expect(topology.nodes).toHaveLength(1);
    const [twin] = topology.nodes;
    expect(twin?.identity).toBe(TWIN_HERE.identity);
    expect(twin?.aliases).toEqual([TWIN_THERE.identity]);
    expect(twin?.alsoAt?.map((address) => address.endpoints.mcp)).toEqual([
      TWIN_THERE.endpoints?.mcp,
    ]);
    // The half that was kept published nothing dialable; the entity is still reachable.
    expect(twin?.reachable).toBe(true);
  });

  it('re-points the edges at whoever the node turned out to be, and draws one line, not two', async () => {
    const topology = await discoverTopology({
      discovery: indexed(FREE, TWIN_HERE, TWIN_THERE),
      resolver: authorityStating(TWINS),
      observed: {
        connections: [
          { from: TWIN_HERE.identity, to: FREE.identity },
          { from: TWIN_THERE.identity, to: FREE.identity },
        ],
      },
    });

    expect(topology.edges).toEqual([
      { from: TWIN_HERE.identity, to: FREE.identity, scope: 'internal', transport: 'mcp' },
    ]);
  });

  it('drops a link whose two ends turned out to be the same entity', async () => {
    const topology = await discoverTopology({
      discovery: indexed(TWIN_HERE, TWIN_THERE),
      resolver: authorityStating(TWINS),
      observed: { connections: [{ from: TWIN_HERE.identity, to: TWIN_THERE.identity }] },
    });

    expect(topology.edges).toEqual([]);
  });

  it('does not merge a thing with what it was modeled on', async () => {
    // identity.md §4.3: facts flow across same_as and never across lineage. A graph that
    // merged the two would draw the contamination that firewall exists to prevent.
    const topology = await discoverTopology({
      discovery: indexed(TWIN_HERE, TWIN_THERE),
      resolver: authorityStating(TWINS, 'based_on'),
    });

    expect(topology.nodes).toHaveLength(2);
  });

  it('merges nothing at all when the host has no resolver', async () => {
    const topology = await discoverTopology({ discovery: indexed(TWIN_HERE, TWIN_THERE) });

    expect(topology.nodes.map((node) => node.identity)).toEqual([
      TWIN_HERE.identity,
      TWIN_THERE.identity,
    ]);
    expect(await resolveNodes(topology.nodes)).toEqual(topology.nodes);
  });

  it('leaves every node where it was when the resolver cannot answer', async () => {
    // Degraded, not broken: an unreachable authority must never be able to delete a
    // participant from the picture.
    const resolver = createAuthorityResolver({
      endpoint: 'https://authority.example',
      fetch: () => Promise.reject(new Error('authority is offline')),
    });
    const topology = await discoverTopology({ discovery: indexed(TWIN_HERE, TWIN_THERE), resolver });

    expect(topology.nodes.map((node) => node.identity)).toEqual([
      TWIN_HERE.identity,
      TWIN_THERE.identity,
    ]);
  });
});

describe('the whole picture is addresses and rulings, and nothing that could carry a byte', () => {
  it('holds nothing callable, on any node or any edge', async () => {
    const topology = await discoverTopology({
      discovery: indexed(FREE, CROSSING, VENDOR),
      resolver: authorityStating({}),
      routes: [{ from: { plane: 'media', mediaType: 'audio/midi' }, to: { plane: 'knowledge' } }],
      observed: { connections: [{ from: FREE.identity, to: VENDOR.identity }] },
    });

    expect(topology.edges.length).toBeGreaterThan(0);
    for (const drawn of [...topology.nodes, ...topology.edges]) {
      expect(Object.values(drawn).some((value) => typeof value === 'function')).toBe(false);
    }
  });

  it('is empty, not broken, when discovery and observation both say nothing', () => {
    expect(topologyOf()).toEqual({ nodes: [], edges: [] });
    expect(topologyOf(null)).toEqual({ nodes: [], edges: [] });
    expect(topologyOf({ nodes: [], observed: { participants: [], connections: [] } })).toEqual({
      nodes: [],
      edges: [],
    });
    expect(edgesOf([], [])).toEqual([]);
  });
});
