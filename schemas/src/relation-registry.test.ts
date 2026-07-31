import { describe, expect, it } from 'vitest';

import { RELATION_REGISTRY } from './relation-registry.ts';

describe('RELATION_REGISTRY', () => {
  it('pins the registryVersion of the koine registry this build speaks', () => {
    // 0.3.0 = the split of `portabilityClasses` into `dialect` + `egress` (KGP §5 / §7.2);
    // 0.4.0 = the insimul bridge mappings, added additively alongside analyzer; 0.4.1/0.4.2 =
    // additive bridge-mapping deltas only (the `_name/2` seeds and the Bridge-2 pending-flag
    // landings — no bridged project added, no relation signature moved).
    expect(RELATION_REGISTRY.version).toBe('0.4.2');
  });

  it('points at koine for the data — agora holds tooling, not a copy (ADR-0001)', () => {
    expect(RELATION_REGISTRY.repo).toBe('koine');
    expect(RELATION_REGISTRY.vocabulary.core).toBe('registry/relations.tsv');
    expect(RELATION_REGISTRY.mappings).toBe('registry/predicate-mapping.json');
  });

  it('pins a version and a layout, and no cast of projects', () => {
    // Which projects a registry bridges, and which one hosts the canonical vocabulary, is that
    // registry's declaration (`registry-schema.ts` — `canonicalProject`, `bridgedProjectsOf`).
    // Pinning them here is what made a foreign deployment's registry unloadable.
    expect(Object.keys(RELATION_REGISTRY).sort()).toEqual([
      'mappings',
      'repo',
      'version',
      'vocabulary',
    ]);
  });
});
