import { parseVocabulary, type RelationRow } from '@agora/schemas';
import { KOINE_VOCABULARY } from '@agora/schemas/fixtures';
import { describe, expect, it } from 'vitest';

import { admitClaims, type AdmissionPolicy, type Rejection } from './admission.ts';
import { claimId, type Claim } from './claim.ts';

/** The real koine vocabulary: this is what "validated against registry/relations.tsv" means. */
const ROWS = new Map(parseVocabulary(KOINE_VOCABULARY).map((row) => [row.relation, row]));
const relations = (name: string): RelationRow | undefined => ROWS.get(name);

/**
 * A synthetic producer that exists nowhere in this ecosystem — a herbarium cataloguing plant
 * specimens. If anything in the bridge knew who its producers were, this batch would not admit.
 */
const HERBARIUM: Claim = {
  world: 'herbarium:world:consensus-reality',
  relation: 'same_as',
  args: ['herbarium:ent:specimen-14821', 'cs:taxon:Q157211'],
  confidence: 0.94,
  license: 'CC-BY-4.0',
  prov: { source: 'herbarium', confidence: 0.94, retrieved_at: '2026-08-01T00:00:00Z' },
};

function only(rejected: readonly Rejection[]): Rejection {
  expect(rejected).toHaveLength(1);
  const first = rejected[0];
  if (first === undefined) throw new Error('expected exactly one rejection');
  return first;
}

describe('admitClaims — the shared vocabulary is the gate', () => {
  it('admits a well-formed claim from a producer nobody has ever heard of', () => {
    const { admitted, rejected } = admitClaims([HERBARIUM], { relations });
    expect(rejected).toEqual([]);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.id).toBe(claimId(HERBARIUM, ROWS.get('same_as') as RelationRow));
    expect(admitted[0]?.link).toBe(true); // same_as is one of KINP's reserved relations
    expect(admitted[0]?.licenseClass).toBe('attribution');
  });

  it('rejects a relation the registry does not publish, naming why it cannot be coined', () => {
    const invented: Claim = { ...HERBARIUM, relation: 'smells_like' };
    const { admitted, rejected } = admitClaims([invented], { relations });
    expect(admitted).toEqual([]);
    const first = only(rejected);
    expect(first.code).toBe('unknown-relation');
    expect(first.relation).toBe('smells_like');
    expect(first.reason).toMatch(/relations\.tsv/);
    expect(first.reason).toMatch(/§3\.2/);
  });

  it('rejects a claim whose arity is not the published signature', () => {
    const wrong: Claim = { ...HERBARIUM, args: ['herbarium:ent:specimen-14821'] };
    expect(only(admitClaims([wrong], { relations }).rejected).code).toBe('arity-mismatch');
  });

  it('rejects an argument that is not a canonical CURIE or a typed literal', () => {
    const iri: Claim = { ...HERBARIUM, args: ['https://example.org/taxon/Q157211', 'cs:taxon:Q1'] };
    expect(only(admitClaims([iri], { relations }).rejected).code).toBe('malformed-argument');
  });

  it('reports every claim in a batch independently — one bad record is not a bad batch', () => {
    const good: Claim = { ...HERBARIUM, args: ['herbarium:ent:specimen-2', 'cs:taxon:Q2'] };
    const bad: Claim = { ...HERBARIUM, relation: 'smells_like' };
    const { admitted, rejected } = admitClaims([good, bad, HERBARIUM], { relations });
    expect(admitted).toHaveLength(2);
    expect(rejected.map((r) => r.index)).toEqual([1]);
  });
});

describe('admitClaims — the four first-class axes', () => {
  it('refuses a local-only record: it never crosses, whatever else is true of it (§7.2)', () => {
    const personal: Claim = { ...HERBARIUM, egress: 'local-only' };
    const first = only(admitClaims([personal], { relations }).rejected);
    expect(first.code).toBe('local-only');
    expect(first.reason).toMatch(/§7\.2/);
  });

  it('refuses a record whose relation the registry marks local-only', () => {
    const { rejected } = admitClaims([HERBARIUM], {
      relations,
      egressOfRelation: (relation) => (relation === 'same_as' ? 'local-only' : undefined),
    });
    expect(only(rejected).code).toBe('local-only');
  });

  it('fails closed on an egress marking it cannot interpret', () => {
    const odd: Claim = { ...HERBARIUM, egress: 'probably-fine' };
    expect(only(admitClaims([odd], { relations }).rejected).code).toBe('local-only');
  });

  it('refuses a relation above the consumer\'s dialect, and admits it once the tier rises', () => {
    // located_in is horn-safe; the default consumer declares grounding-only (§5).
    const horn: Claim = {
      ...HERBARIUM,
      relation: 'located_in',
      args: ['herbarium:ent:specimen-14821', 'refkb:ent:kew-gardens'],
    };
    expect(only(admitClaims([horn], { relations }).rejected).code).toBe('dialect-exceeded');
    const policy: AdmissionPolicy = { dialect: 'horn-safe' };
    expect(admitClaims([horn], { relations, policy }).admitted).toHaveLength(1);
  });

  it('admits per record against the §7.1 license allowlist', () => {
    const proprietary: Claim = { ...HERBARIUM, license: 'PROPRIETARY' };
    const first = only(admitClaims([proprietary], { relations }).rejected);
    expect(first.code).toBe('license-refused');
    expect(first.reason).toMatch(/proprietary/);
    // The same record admits under a consumer whose allowlist covers it.
    const policy: AdmissionPolicy = { licenses: ['proprietary'] };
    expect(admitClaims([proprietary], { relations, policy }).admitted).toHaveLength(1);
  });

  it('treats a license it cannot classify as proprietary — the safe direction to be wrong in', () => {
    const unknown: Claim = { ...HERBARIUM, license: 'HERBARIUM-INTERNAL-1.0' };
    expect(only(admitClaims([unknown], { relations }).rejected).code).toBe('license-refused');
  });

  it('requires a license at all (§7.1) and a prov.source (§7)', () => {
    const unlicensed: Claim = {
      world: HERBARIUM.world,
      relation: HERBARIUM.relation,
      args: HERBARIUM.args,
      prov: { source: 'herbarium', confidence: 0.94 },
    };
    expect(only(admitClaims([unlicensed], { relations }).rejected).code).toBe('license-missing');
    const anonymous: Claim = {
      world: HERBARIUM.world,
      relation: HERBARIUM.relation,
      args: HERBARIUM.args,
      license: 'CC-BY-4.0',
    };
    expect(only(admitClaims([anonymous], { relations }).rejected).code).toBe('provenance-missing');
  });

  it('applies the confidence floor and the trusted-source filter (§7)', () => {
    const policy: AdmissionPolicy = { minConfidence: 0.95 };
    expect(only(admitClaims([HERBARIUM], { relations, policy }).rejected).code).toBe(
      'confidence-below-threshold',
    );
    const trust: AdmissionPolicy = { trustedSources: ['refkb'] };
    expect(only(admitClaims([HERBARIUM], { relations, policy: trust }).rejected).code).toBe(
      'untrusted-source',
    );
  });
});

describe('admitClaims — a producer-minted id is cross-checked, never trusted', () => {
  it('accepts the bare content address and the assertion-envelope form', () => {
    const id = claimId(HERBARIUM, ROWS.get('same_as') as RelationRow);
    expect(admitClaims([{ ...HERBARIUM, id }], { relations }).admitted).toHaveLength(1);
    expect(
      admitClaims([{ ...HERBARIUM, id: `herbarium:claim:${id}` }], { relations }).admitted,
    ).toHaveLength(1);
  });

  it('refuses an id the claim does not canonicalize to, because dedup would silently stop', () => {
    const wrong = { ...HERBARIUM, id: `sha256-${'0'.repeat(64)}` };
    const first = only(admitClaims([wrong], { relations }).rejected);
    expect(first.code).toBe('claim-id-mismatch');
    expect(first.reason).toMatch(/§3\.1/);
  });
});
