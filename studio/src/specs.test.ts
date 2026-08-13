/**
 * What a participant advertises is read off its own documents, and off nothing else.
 *
 * These tests drive the **real** registry (`@agora/registry`) and the **real** card builder
 * (`embedManifest` from `@agora/schemas`), for the reason `topology.test.ts` drives a real
 * index: the claim under test is that Studio reads the documents the fabric already publishes
 * rather than a shape it invented for itself. The manifests below are sample data authored for
 * this file — the `.example` hostnames say so — and no name in them is known to `studio/src`.
 */
import { createRegistry } from '@agora/registry';
import { embedManifest, SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { advertisementOf, isEmptyView, pinnedVersion, specViewOf } from './specs.ts';
import { discoverNodes, topologyOf, type TopologyNode } from './topology.ts';

const kcb_version = SPEC_VERSIONS.kcb;

/** Media in, media out: a participant whose ports are typed by KMI (KCB §2.1). */
const RENDERER: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:renderer',
  endpoints: { mcp: 'https://renderer.example/mcp' },
  capabilities: [
    {
      name: 'render',
      inputs: [{ plane: 'media', media_types: ['audio/midi'] }],
      outputs: [{ plane: 'media', media_types: ['audio/wav'] }],
    },
  ],
};

/** Knowledge on the wire and a fine-tune method on the capability: KGP and KFT, advertised. */
const TRAINER: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:trainer',
  endpoints: { a2a: 'https://trainer.example/.well-known/agent-card.json' },
  produces: [{ plane: 'knowledge', dialect: 'sample' }],
  capabilities: [{ name: 'finetune', modality: 'text-generation', methods: ['lora'] }],
};

/** A manifest with no ports at all — it advertises being on the bus, and nothing beyond it. */
const PLAIN: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:plain',
  endpoints: { mcp: 'https://plain.example/mcp' },
  capabilities: [{ name: 'describe' }],
};

async function discovered(...manifests: CapabilityManifest[]): Promise<TopologyNode[]> {
  const registry = createRegistry();
  for (const manifest of manifests) registry.register(manifest);
  return discoverNodes(registry);
}

/** The node discovery answered with for one manifest. */
async function nodeFor(manifest: CapabilityManifest): Promise<TopologyNode> {
  const [node] = await discovered(manifest);
  if (!node) throw new Error('discovery answered with nobody');
  return node;
}

describe('the contracts a participant advertises', () => {
  it('is exactly the subset its own documents name — no more', async () => {
    const view = specViewOf(advertisementOf(await nodeFor(RENDERER)));

    expect(view.identity).toBe(RENDERER.identity);
    // KINP because the identity is a compact KINP id, KCB because the manifest stamps its
    // version, KMI because its ports are on the media plane. Nothing else is claimed, so
    // nothing else is listed: no KGP, no KCS, no KFT.
    expect(view.contracts.map((contract) => contract.spec)).toEqual(['kinp', 'kcb', 'kmi']);
  });

  it('reads a different subset off a different participant, from the same code path', async () => {
    const view = specViewOf(advertisementOf(await nodeFor(TRAINER)));

    expect(view.contracts.map((contract) => contract.spec)).toEqual(['kinp', 'kgp', 'kcb', 'kft']);
  });

  it('claims nothing beyond the bus for a manifest with no ports', async () => {
    const view = specViewOf(advertisementOf(await nodeFor(PLAIN)));

    expect(view.contracts.map((contract) => contract.spec)).toEqual(['kinp', 'kcb']);
  });

  it('cites where each claim was read, so an advertisement is checkable', async () => {
    const view = specViewOf(advertisementOf(await nodeFor(TRAINER)));
    const cited = Object.fromEntries(
      view.contracts.map((contract) => [contract.spec, contract.evidence]),
    );

    expect(cited.kinp).toEqual(['manifest.identity']);
    expect(cited.kcb).toEqual(['manifest.kcb_version']);
    expect(cited.kgp).toEqual(['manifest.produces[0].plane']);
    expect(cited.kft).toEqual(['manifest.capabilities[0].modality', 'manifest.capabilities[0].methods']);
  });

  it('pairs the version the participant declared with the one this build pins', async () => {
    const view = specViewOf(advertisementOf(await nodeFor(RENDERER)));
    const kcb = view.contracts.find((contract) => contract.spec === 'kcb');
    const kmi = view.contracts.find((contract) => contract.spec === 'kmi');

    expect(kcb?.declared).toBe(kcb_version);
    expect(kcb?.pinned).toBe(SPEC_VERSIONS.kcb);
    // The participant advertises KMI by the plane it types its ports with, without stating a
    // version — and this build pins none either. Both blanks are shown as blanks.
    expect(kmi?.declared).toBeUndefined();
    expect(kmi?.pinned).toBeUndefined();
    expect(pinnedVersion('kmi')).toBeUndefined();
    expect(pinnedVersion('kcb')).toBe(SPEC_VERSIONS.kcb);
  });
});

describe('the documents an advertisement is read out of', () => {
  it('lists the manifest discovery indexed, verbatim', async () => {
    const view = specViewOf(advertisementOf(await nodeFor(PLAIN)));

    expect(view.artifacts).toHaveLength(1);
    expect(view.artifacts[0]?.kind).toBe('kcb-manifest');
    expect(view.artifacts[0]?.source).toBe('indexed');
    expect(view.artifacts[0]?.document).toEqual(PLAIN);
  });

  it('adds the served card, and the manifest riding inside it, when the host read one', async () => {
    const card = embedManifest({ name: PLAIN.identity, url: 'https://plain.example/a2a' }, PLAIN);
    const view = specViewOf(advertisementOf(await nodeFor(PLAIN), card));

    expect(view.artifacts.map((artifact) => `${artifact.kind}:${artifact.source}`)).toEqual([
      'agent-card:served',
      'kcb-manifest:served',
      'kcb-manifest:indexed',
    ]);
    // The extension is located by the URI the schemas package owns, and the claim cites it.
    const kcb = view.contracts.find((contract) => contract.spec === 'kcb');
    expect(kcb?.evidence).toContain('agent_card.capabilities.extensions[0].uri');
    expect(kcb?.evidence).toContain('agent_card.capabilities.extensions[0].params.kcb_version');
  });

  it('still lists a document it could not read a single claim out of', async () => {
    const view = specViewOf(advertisementOf(await nodeFor(PLAIN), 'not a card at all'));

    // The nonsense card is on the list — it was advertised, and hiding it would hide the only
    // evidence of the problem — but it contributed no contract, because it cites nothing.
    expect(view.artifacts.map((artifact) => artifact.at)).toEqual(['agent_card', 'manifest']);
    expect(view.contracts.map((contract) => contract.spec)).toEqual(['kinp', 'kcb']);
  });
});

describe('a participant nobody handed a document for', () => {
  it('advertises nothing, and that is a state rather than a failure', () => {
    // An observed peer: the host saw traffic with it, discovery has never heard of it, and so
    // there is no document to read. The same honest blank as an unconfigured stage.
    const { nodes } = topologyOf({
      observed: { participants: [{ identity: 'sample:agent:seen-only' }], connections: [] },
    });
    const node = nodes[0];
    if (!node) throw new Error('the observed participant should be on the graph');

    const view = specViewOf(advertisementOf(node));
    expect(view.contracts).toEqual([]);
    expect(view.artifacts).toEqual([]);
    expect(isEmptyView(view)).toBe(true);
  });

  it('reads nothing out of no advertisement at all', () => {
    expect(isEmptyView(specViewOf())).toBe(true);
    expect(isEmptyView(specViewOf(null))).toBe(true);
  });
});
