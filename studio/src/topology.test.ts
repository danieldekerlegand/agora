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
import { SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { labelOf } from './backbone.ts';
import { discoverNodes, nodesOf, type Discovery } from './topology.ts';

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
