import { describe, expect, it } from 'vitest';

import { RELATION_REGISTRY } from './relation-registry.ts';

describe('RELATION_REGISTRY', () => {
  it('pins the registryVersion of the koine registry this build speaks', () => {
    expect(RELATION_REGISTRY.version).toBe('0.2.0');
  });

  it('points at koine for the data — agora holds tooling, not a copy (ADR-0001)', () => {
    expect(RELATION_REGISTRY.repo).toBe('koine');
    expect(RELATION_REGISTRY.vocabulary.core).toBe('registry/relations.tsv');
    expect(RELATION_REGISTRY.mappings).toBe('registry/predicate-mapping.json');
  });

  it('treats every other copy as a generated mirror, never a source', () => {
    // A mirror that could be authored is how the registry forks: the pinakes file that this
    // registry was lifted OUT of is listed here as derived, not as a second authority.
    expect(RELATION_REGISTRY.mirrors.length).toBeGreaterThan(0);
    for (const mirror of RELATION_REGISTRY.mirrors) {
      expect(mirror.mode).toBe('generated-mirror');
      expect(mirror.project).not.toBe(RELATION_REGISTRY.repo);
    }
    expect(RELATION_REGISTRY.mirrors.map((m) => m.project)).toContain('pinakes');
  });
});
