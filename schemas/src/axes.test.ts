import { describe, expect, it } from 'vitest';

import {
  assertPackEgress,
  DEFAULT_DIALECT,
  DEFAULT_EGRESS,
  DIALECT_TIERS,
  dialectAdmits,
  EGRESS_CLASSES,
  EgressError,
  egressOf,
  filterForEgress,
  filterPackForEgress,
  inspectPackEgress,
  isDialectTier,
  isEgressClass,
  isTrustTier,
  TRUST_TIERS,
  type PackLike,
  type RelationEgress,
} from './axes.ts';

/**
 * The analyzer egress markings as `koine/registry/predicate-mapping.json` 0.3.0 carries them
 * (mirrored, not read: koine is not reachable from a build of agora). Note `cine:shows` is
 * itself an ordinary exportable relation in `relations/cinematography.tsv` — what is
 * `local-only` is Analyzer's *own* `shows(asset, X)` predicate about the user's files, which is
 * why egress is declared per bridge mapping rather than on the shared vocabulary.
 */
const ARGOS_EGRESS: RelationEgress = (relation) =>
  relation === 'cine:shows' ? 'local-only' : relation === 'derived_from' ? 'exportable' : undefined;

describe('the three axes stay distinct', () => {
  it('does not treat local-only as a fourth dialect tier (KGP §5)', () => {
    expect(isDialectTier('local-only')).toBe(false);
    expect(isEgressClass('local-only')).toBe(true);
    expect(DIALECT_TIERS).toStrictEqual(['grounding-only', 'horn-safe', 'full-prolog']);
  });

  it('keeps dialect, egress and trust values disjoint — a mix-up cannot type-check', () => {
    const all = [...DIALECT_TIERS, ...EGRESS_CLASSES, ...TRUST_TIERS];
    expect(new Set(all).size).toBe(all.length);
    // `personal` trust correlates with `local-only` egress; it does not *mean* it.
    expect(isTrustTier('personal')).toBe(true);
    expect(isEgressClass('personal')).toBe(false);
    expect(isTrustTier('local-only')).toBe(false);
  });

  it('nests the dialect tiers, lowest first, and defaults to the common denominator', () => {
    expect(DEFAULT_DIALECT).toBe('grounding-only');
    expect(dialectAdmits('horn-safe', 'grounding-only')).toBe(true);
    expect(dialectAdmits('horn-safe', 'horn-safe')).toBe(true);
    expect(dialectAdmits('horn-safe', 'full-prolog')).toBe(false);
    expect(dialectAdmits('full-prolog', 'horn-safe')).toBe(true);
  });
});

describe('egressOf', () => {
  it('defaults to exportable, so only a marking withholds anything', () => {
    expect(DEFAULT_EGRESS).toBe('exportable');
    expect(egressOf({ id: 'a' })).toBe('exportable');
    expect(egressOf({ id: 'a', relation: 'derived_from' }, ARGOS_EGRESS)).toBe('exportable');
  });

  it('reads the registry when the record itself is unmarked', () => {
    expect(egressOf({ id: 'a', relation: 'cine:shows' }, ARGOS_EGRESS)).toBe('local-only');
    // No lookup supplied ⇒ nothing marks it ⇒ the default.
    expect(egressOf({ id: 'a', relation: 'cine:shows' })).toBe('exportable');
  });

  it("lets a record's own marking win over its relation's", () => {
    expect(egressOf({ id: 'a', relation: 'derived_from', egress: 'local-only' }, ARGOS_EGRESS)).toBe(
      'local-only',
    );
  });

  it('fails closed on a marking this build does not understand', () => {
    // Leaking is unrecoverable, withholding is not — an unreadable class is not a licence.
    expect(egressOf({ id: 'a', egress: 'partner-only' })).toBe('local-only');
  });
});

/** A snapshot as Analyzer would assemble it before export: two facts about the user's files. */
function draftPack(): PackLike {
  return {
    kgp_version: '0.4.0',
    producer: 'analyzer',
    dialect: 'grounding-only',
    entities: [{ id: 'analyzer:ent:asset-1' }],
    assertions: [
      { id: 'sha256-1', relation: 'derived_from' },
      { id: 'sha256-2', relation: 'cine:shows' },
      { id: 'sha256-3', relation: 'media:mentions', egress: 'local-only' },
    ],
  };
}

describe('egress enforcement — producer side (KGP §7.2)', () => {
  it('withholds local-only records at pack construction, and says what it withheld', () => {
    const { emitted, withheld } = filterForEgress(
      draftPack().assertions ?? [],
      ARGOS_EGRESS,
    );
    expect(emitted.map((r) => r.id)).toStrictEqual(['sha256-1']);
    expect(withheld.map((w) => w.record.id)).toStrictEqual(['sha256-2', 'sha256-3']);
    expect(withheld.every((w) => w.egress === 'local-only')).toBe(true);
  });

  it('filters the whole pack and leaves everything else untouched', () => {
    const { pack, withheld } = filterPackForEgress(draftPack(), ARGOS_EGRESS);
    expect(pack.producer).toBe('analyzer');
    expect(pack.entities).toHaveLength(1);
    expect(pack.assertions?.map((r) => r.id)).toStrictEqual(['sha256-1']);
    expect(withheld).toHaveLength(2);
  });

  it('produces a pack the consumer accepts — the two sides of §7.2 meet', () => {
    const { pack } = filterPackForEgress(draftPack(), ARGOS_EGRESS);
    expect(inspectPackEgress(pack, ARGOS_EGRESS).ok).toBe(true);
    expect(() => {
      assertPackEgress(pack, ARGOS_EGRESS);
    }).not.toThrow();
  });
});

describe('egress enforcement — consumer side (KGP §7.2)', () => {
  it('rejects an unfiltered pack rather than silently dropping the records', () => {
    const report = inspectPackEgress(draftPack(), ARGOS_EGRESS);
    expect(report.ok).toBe(false);
    expect(report.violations).toStrictEqual([
      {
        section: 'assertions',
        index: 1,
        id: 'sha256-2',
        relation: 'cine:shows',
        egress: 'local-only',
      },
      {
        section: 'assertions',
        index: 2,
        id: 'sha256-3',
        relation: 'media:mentions',
        egress: 'local-only',
      },
    ]);
  });

  it('throws with the full report attached — the violation must be actionable', () => {
    try {
      assertPackEgress(draftPack(), ARGOS_EGRESS);
      expect.unreachable('a pack carrying local-only content must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(EgressError);
      const egressError = error as EgressError;
      expect(egressError.violations).toHaveLength(2);
      expect(egressError.message).toContain('sha256-2');
      expect(egressError.message).toContain('§7.2');
    }
  });

  it('catches a record marked local-only in any section, however it was marked', () => {
    const tampered: PackLike = {
      entities: [{ id: 'analyzer:ent:asset-1', egress: 'local-only' }],
      links: [{ id: 'sha256-9', relation: 'same_as' }],
      provenance: [{ id: 'run:7', egress: 'exportable' }],
    };
    const report = inspectPackEgress(tampered);
    expect(report.violations.map((v) => v.section)).toStrictEqual(['entities']);
  });

  it('accepts a pack with no record sections at all', () => {
    expect(inspectPackEgress({ producer: 'pinakes' }).ok).toBe(true);
  });
});
