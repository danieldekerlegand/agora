import { parseVocabulary, SPEC_VERSIONS, type RelationRow } from '@agora/schemas';
import { KOINE_VOCABULARY } from '@agora/schemas/fixtures';
import { validate } from '@agora/schemas/validator';
import { describe, expect, it } from 'vitest';

import { admitClaims } from './admission.ts';
import type { Claim } from './claim.ts';
import { buildPack, PackError } from './pack.ts';

const ROWS = new Map(parseVocabulary(KOINE_VOCABULARY).map((row) => [row.relation, row]));
const relations = (name: string): RelationRow | undefined => ROWS.get(name);

const CREATED = '2026-08-06T00:00:00.000Z';

const CLAIMS: readonly Claim[] = [
  {
    world: 'herbarium:world:consensus-reality',
    relation: 'same_as',
    args: ['herbarium:ent:specimen-14821', 'cs:taxon:Q157211'],
    confidence: 0.94,
    license: 'CC-BY-4.0',
    prov: { source: 'herbarium', confidence: 0.94 },
  },
  {
    world: 'herbarium:world:consensus-reality',
    relation: 'co_occurs',
    args: ['herbarium:ent:specimen-14821', 'herbarium:ent:specimen-14822'],
    confidence: 0.7,
    license: 'CC0-1.0',
    prov: { source: 'herbarium', confidence: 0.7 },
  },
];

function packOf(claims: readonly Claim[] = CLAIMS) {
  const { admitted, rejected } = admitClaims(claims, { relations });
  expect(rejected).toEqual([]);
  return buildPack(admitted, { producer: 'herbarium', created: CREATED });
}

describe('buildPack (KGP §2)', () => {
  it('produces a pack the koine grounding-pack schema validates', () => {
    expect(validate('grounding-pack', packOf())).toEqual([]);
  });

  it('declares the KGP version this build implements', () => {
    expect(packOf().kgp_version).toBe(SPEC_VERSIONS.kgp);
  });

  it('files KINP\'s reserved relations under links and the rest under assertions', () => {
    const pack = packOf();
    expect(pack.links.map((record) => record.relation)).toEqual(['same_as']);
    expect(pack.assertions.map((record) => record.relation)).toEqual(['co_occurs']);
    expect(pack.manifest.counts).toEqual({ entities: 0, assertions: 1, links: 1 });
  });

  it('carries no entity records — the bridge is a conduit, not a copy of a knowledge store', () => {
    expect(packOf().entities).toEqual([]);
  });

  it('carries the exact bytes each id was hashed over, so a consumer re-verifies with one SHA', () => {
    const record = packOf().links[0];
    expect(record?.hash_input).toBe(
      'herbarium:world:consensus-reality|same_as(cs:taxon:Q157211,herbarium:ent:specimen-14821)',
    );
    expect(record?.id).toBe(`herbarium:claim:${record?.claim ?? ''}`);
  });

  it('scopes itself to the worlds its claims are asserted in (KINP §5)', () => {
    expect(packOf().worlds).toEqual(['herbarium:world:consensus-reality']);
  });

  it('declares the highest dialect any of its claims needs (§5)', () => {
    expect(packOf().dialect).toBe('grounding-only');
    const horn: Claim = {
      world: 'herbarium:world:consensus-reality',
      relation: 'located_in',
      args: ['herbarium:ent:specimen-14821', 'refkb:ent:kew-gardens'],
      license: 'CC0-1.0',
      prov: { source: 'herbarium', confidence: 1 },
    };
    const { admitted } = admitClaims([...CLAIMS, horn], {
      relations,
      policy: { dialect: 'horn-safe' },
    });
    expect(buildPack(admitted, { producer: 'herbarium', created: CREATED }).dialect).toBe(
      'horn-safe',
    );
  });

  it('ledgers every record\'s license in the manifest (§7.1)', () => {
    const pack = packOf();
    expect(pack.manifest.license_policy).toEqual({ 'CC-BY-4.0': 1, 'CC0-1.0': 1 });
    const total = Object.values(pack.manifest.license_policy).reduce((a, b) => a + b, 0);
    expect(total).toBe(pack.assertions.length + pack.links.length);
  });
});

describe('pack_id (KGP §2.1)', () => {
  it('is content-addressed: the same claims in any order give the same pack', () => {
    const forward = packOf(CLAIMS);
    const backward = packOf([...CLAIMS].reverse());
    expect(backward.pack_id).toBe(forward.pack_id);
    expect(forward.pack_id).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('moves when the content moves', () => {
    const changed: Claim[] = [
      { ...(CLAIMS[0] as Claim), args: ['herbarium:ent:specimen-9', 'cs:taxon:Q157211'] },
    ];
    expect(packOf(changed).pack_id).not.toBe(packOf([CLAIMS[0] as Claim]).pack_id);
  });

  it('does not move when only excluded metadata changes on a record\'s claim id', () => {
    // The pack id covers the records, so a confidence change DOES move it — but the claim ids
    // inside it must not, which is what keeps the consumer's dedup stable across re-syncs.
    const first = packOf();
    const louder = packOf(CLAIMS.map((claim) => ({ ...claim, confidence: 1 })));
    expect(louder.links[0]?.claim).toBe(first.links[0]?.claim);
  });
});

describe('buildPack refuses what KGP §6 forbids', () => {
  it('rejects a delta with no basis and a snapshot with one', () => {
    const { admitted } = admitClaims(CLAIMS, { relations });
    expect(() => buildPack(admitted, { producer: 'herbarium', created: CREATED, kind: 'delta' }))
      .toThrow(PackError);
    expect(() =>
      buildPack(admitted, {
        producer: 'herbarium',
        created: CREATED,
        basis: `sha256-${'a'.repeat(64)}`,
      }),
    ).toThrow(PackError);
  });

  it('rejects a producer that is not a KINP namespace', () => {
    const { admitted } = admitClaims(CLAIMS, { relations });
    expect(() => buildPack(admitted, { producer: 'Herbarium GmbH', created: CREATED })).toThrow(
      PackError,
    );
  });
});
