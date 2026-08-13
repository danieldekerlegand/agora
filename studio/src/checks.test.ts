/**
 * A conformance claim has to be earned, and a failure has to say why.
 *
 * The manifests here are sample data authored for this file (`.example` hostnames); the
 * conformant ones go through the **real** registry, so a document that reaches a check has
 * survived the same indexing a real participant's would. The malformed ones cannot: the
 * registry runs `parseManifestBody` at `register()` and would reject them at the door, which
 * is itself the point — they arrive the only way a bad document ever reaches a viewer, as
 * something a participant served and somebody handed straight in.
 */
import { createRegistry } from '@agora/registry';
import { embedManifest, SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { checkArtifact, checkContract, checkView } from './checks.ts';
import { advertisementOf, specViewOf, type SpecArtifact } from './specs.ts';
import { discoverNodes, topologyOf, type TopologyNode } from './topology.ts';

const kcb_version = SPEC_VERSIONS.kcb;

/** A participant whose documents are exactly what KCB §2 asks for. */
const LIBRARIAN: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:librarian',
  endpoints: { a2a: 'https://librarian.example/.well-known/agent-card.json' },
  produces: [{ plane: 'knowledge', dialect: 'sample' }],
  capabilities: [{ name: 'lookup' }],
};

async function nodeFor(manifest: CapabilityManifest): Promise<TopologyNode> {
  const registry = createRegistry();
  registry.register(manifest);
  const [node] = await discoverNodes(registry);
  if (!node) throw new Error('discovery answered with nobody');
  return node;
}

/** A participant Studio only ever saw traffic with — no document, and so nothing to check. */
function unadvertised(identity: string): TopologyNode {
  const { nodes } = topologyOf({ observed: { participants: [{ identity }], connections: [] } });
  const node = nodes[0];
  if (!node) throw new Error('the observed participant should be on the graph');
  return node;
}

/** One document handed in the way a host hands one in: as bytes, unvouched for. */
function served(kind: SpecArtifact['kind'], document: unknown): SpecArtifact {
  return { kind, source: 'served', at: 'agent_card', document };
}

describe('a document that conforms', () => {
  it('validates — against the versions schemas/src/versions.ts pins, not a copy of them', async () => {
    const view = checkView(specViewOf(advertisementOf(await nodeFor(LIBRARIAN))));

    expect(view.artifacts).toHaveLength(1);
    expect(view.artifacts[0]?.verdict).toBe('valid');
    expect(view.artifacts[0]?.by).toBe('parseManifestBody');
    expect(view.artifacts[0]?.reasons).toEqual([]);

    const kcb = view.contracts.find((contract) => contract.spec === 'kcb');
    expect(kcb?.verdict).toBe('valid');
    expect(kcb?.declared).toBe(SPEC_VERSIONS.kcb);
    expect(kcb?.pinned).toBe(SPEC_VERSIONS.kcb);
  });

  it('validates the served card whole, and the manifest riding inside it on its own', async () => {
    const card = embedManifest(
      { name: LIBRARIAN.identity, url: 'https://librarian.example/a2a' },
      LIBRARIAN,
    );
    const view = checkView(specViewOf(advertisementOf(await nodeFor(LIBRARIAN), card)));

    expect(view.artifacts.map((artifact) => `${artifact.kind}/${artifact.verdict}`)).toEqual([
      'agent-card/valid',
      'kcb-manifest/valid',
      'kcb-manifest/valid',
    ]);
    // The card is checked by the card parser, the bodies by the body parser — the two rules
    // the schemas package actually owns, applied to the documents each one governs.
    expect(view.artifacts.map((artifact) => artifact.by)).toEqual([
      'parseManifest',
      'parseManifestBody',
      'parseManifestBody',
    ]);
  });
});

describe('a document that does not conform', () => {
  it('is flagged invalid, with the schema reason the checker gave', () => {
    // No `endpoints`: a manifest that says it is on the bus without saying where (KCB §2).
    const check = checkArtifact(served('kcb-manifest', { kcb_version, identity: 'sample:agent:mute' }));

    expect(check.verdict).toBe('invalid');
    expect(check.reasons.join(' ')).toContain('manifest.endpoints');
  });

  it('is flagged invalid on a version this build cannot read, and names the version', () => {
    const check = checkArtifact(
      served('kcb-manifest', {
        ...LIBRARIAN,
        kcb_version: '9.9.9',
      }),
    );

    expect(check.verdict).toBe('invalid');
    // Both versions in the reason: the one the participant declared and the one this build
    // pins, so the reader can see which end moved without leaving the panel.
    expect(check.reasons.join(' ')).toContain('9.9.9');
    expect(check.reasons.join(' ')).toContain(SPEC_VERSIONS.kcb);
  });

  it('flags a card carrying no KCB manifest extension, naming what was missing', () => {
    const check = checkArtifact(served('agent-card', { name: 'plain a2a card' }));

    expect(check.verdict).toBe('invalid');
    expect(check.reasons.join(' ')).toContain('extensions');
  });

  it('flags a document that is not a document at all', () => {
    expect(checkArtifact(served('agent-card', 'not a card')).verdict).toBe('invalid');
    expect(checkArtifact(served('kcb-manifest', null)).verdict).toBe('invalid');
  });

  it('never launders a bad document into a passing view', () => {
    const view = checkView(
      specViewOf({ identity: 'sample:agent:broken', manifest: { kcb_version: '0.0.1' } }),
    );

    expect(view.artifacts.every((artifact) => artifact.verdict === 'invalid')).toBe(true);
    const kcb = view.contracts.find((contract) => contract.spec === 'kcb');
    expect(kcb?.verdict).toBe('invalid');
    expect(kcb?.reasons.join(' ')).toContain(SPEC_VERSIONS.kcb);
  });
});

describe('what nobody stated a rule for', () => {
  it('is unjudged rather than passed, where the schemas package states no version rule', () => {
    // The participant types its ports with a plane, which is how it advertises KMI — and this
    // build pins no KMI version, so there is nothing to check it against and nothing is claimed.
    const kmi = checkContract({ spec: 'kmi', evidence: ['manifest.produces[0].plane'] });
    expect(kmi.verdict).toBe('unjudged');
    expect(kmi.reasons.join(' ')).toContain('no version declared');

    const kgp = checkContract({ spec: 'kgp', declared: '0.1.0', pinned: SPEC_VERSIONS.kgp, evidence: [] });
    expect(kgp.verdict).toBe('unjudged');
    expect(kgp.reasons.join(' ')).toContain('0.1.0');
    expect(kgp.reasons.join(' ')).toContain(SPEC_VERSIONS.kgp);
  });

  it('passes a non-KCB contract only where the two versions plainly agree', () => {
    const kgp = checkContract({
      spec: 'kgp',
      declared: SPEC_VERSIONS.kgp,
      pinned: SPEC_VERSIONS.kgp,
      evidence: [],
    });

    expect(kgp.verdict).toBe('valid');
    expect(kgp.reasons).toEqual([]);
  });

  it('checks nothing for a participant nobody handed a document for', () => {
    const view = checkView(specViewOf(advertisementOf(unadvertised('sample:agent:seen-only'))));

    expect(view.artifacts).toEqual([]);
    expect(view.contracts).toEqual([]);
  });
});
