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

  it('covers both bridged projects, and does not count the canonical one among them', () => {
    // The registry maps a project's OWN predicates onto the canonical vocabulary, so the
    // project hosting that vocabulary has no mappings of its own — listing it would invite a
    // loader to look for a `projects.pinakes` block that must never exist.
    expect(RELATION_REGISTRY.bridgedProjects).toEqual(['analyzer', 'insimul']);
    expect(RELATION_REGISTRY.bridgedProjects).not.toContain(RELATION_REGISTRY.canonicalProject);
  });

  it('keeps the mirror-holding project distinct from the bridged ones', () => {
    // pinakes holds the generated mirror because it is the canonical side, not because it is
    // bridged: a mirror is a copy of the whole registry, not a project's entry in it.
    for (const mirror of RELATION_REGISTRY.mirrors) {
      expect(RELATION_REGISTRY.bridgedProjects).not.toContain(mirror.project);
    }
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
