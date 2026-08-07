import { createHash } from 'node:crypto';

import { parseVocabulary, type RelationRow } from '@agora/schemas';
import { KOINE_VOCABULARY } from '@agora/schemas/fixtures';
import { describe, expect, it } from 'vitest';

import {
  canonicalClaim,
  canonicalDecimal,
  canonicalIdentifier,
  canonicalLiteral,
  claimId,
  ClaimError,
  hashClaimInput,
  type Claim,
} from './claim.ts';

/** The REAL koine vocabulary — arity, argument order and symmetry come from it, not from here. */
const ROWS = new Map(parseVocabulary(KOINE_VOCABULARY).map((row) => [row.relation, row]));

function row(relation: string): RelationRow {
  const found = ROWS.get(relation);
  if (found === undefined) throw new Error(`${relation} is not in the koine vocabulary`);
  return found;
}

const BASE: Claim = {
  world: 'worldsim:world:alderforest',
  relation: 'located_in',
  args: ['worldsim:world:alderforest:ent:npc-renaud', 'refkb:ent:alder-keep'],
  license: 'CC-BY-4.0',
  prov: { source: 'worldsim', confidence: 0.9 },
};

describe('canonicalIdentifier (KGP §3.2 rule 3)', () => {
  it('lowercases the namespace and kind but never the opaque local id', () => {
    expect(canonicalIdentifier('RefKB:Ent:Napoleon-I')).toBe('refkb:ent:Napoleon-I');
    expect(canonicalIdentifier('cs:CULTURE:Q11768')).toBe('cs:culture:Q11768');
  });

  it('lowercases the kind of a world-scoped id, which sits at the fourth segment', () => {
    expect(canonicalIdentifier('WorldSim:World:alderforest:ENT:npc-renaud')).toBe(
      'worldsim:world:alderforest:ent:npc-renaud',
    );
  });

  it('emits a provisional-local id as-is — it re-normalizes after reconciliation', () => {
    expect(canonicalIdentifier('analyzer:local:ent:E-8842')).toBe('analyzer:local:ent:E-8842');
  });

  it('normalizes to NFC, so two encodings of one name are one identifier', () => {
    const composed = 'refkb:ent:caf\u00e9'; // \u00e9
    const decomposed = 'refkb:ent:cafe\u0301'; // e + U+0301
    expect(composed).not.toBe(decomposed);
    expect(canonicalIdentifier(decomposed)).toBe(canonicalIdentifier(composed));
  });

  it('rejects an IRI and anything else that is not a CURIE', () => {
    expect(() => canonicalIdentifier('https://example.org/ent/napoleon')).toThrow(ClaimError);
    expect(() => canonicalIdentifier('refkb:ent')).toThrow(ClaimError);
    expect(() => canonicalIdentifier('refkb: ent:x')).toThrow(ClaimError);
  });
});

describe('canonicalLiteral (KGP §3.2 rule 5)', () => {
  it('quotes a string and escapes only " and backslash', () => {
    expect(canonicalLiteral({ type: 'string', value: 'a "b" \\ c\nd' })).toBe('"a \\"b\\" \\\\ c\nd"');
  });

  it('writes integers base-10 with no leading zeros, no +, and -0 as 0', () => {
    expect(canonicalLiteral({ type: 'integer', value: 42 })).toBe('42');
    expect(canonicalLiteral({ type: 'integer', value: -0 })).toBe('0');
    expect(canonicalLiteral({ type: 'integer', value: -7 })).toBe('-7');
  });

  it('writes booleans and UTC millisecond date/times', () => {
    expect(canonicalLiteral({ type: 'boolean', value: false })).toBe('false');
    expect(canonicalLiteral({ type: 'datetime', value: '2026-07-12T00:00:00+02:00' })).toBe(
      '2026-07-11T22:00:00.000Z',
    );
  });

  it('writes a typed literal as value^^type-curie', () => {
    expect(canonicalLiteral({ type: 'typed', value: '42', datatype: 'xsd:integer' })).toBe(
      '"42"^^xsd:integer',
    );
  });

  it('refuses a date/time and a datatype it cannot canonicalize', () => {
    expect(() => canonicalLiteral({ type: 'datetime', value: 'last tuesday' })).toThrow(ClaimError);
    expect(() =>
      canonicalLiteral({ type: 'typed', value: '42', datatype: 'not a curie' }),
    ).toThrow(ClaimError);
  });
});

describe('canonicalDecimal', () => {
  it('is the shortest round-tripping form with no trailing zeros', () => {
    expect(canonicalDecimal(12.5)).toBe('12.5');
    expect(canonicalDecimal(1.5000000000000002)).toBe('1.5000000000000002');
    expect(canonicalDecimal(0.1)).toBe('0.1');
    expect(canonicalDecimal(-0.25)).toBe('-0.25');
    expect(canonicalDecimal(0)).toBe('0');
    expect(canonicalDecimal(100)).toBe('100');
  });

  it('uses an exponent only at |exp| >= 16 — where JavaScript would not, and vice versa', () => {
    // JS prints 1e16 in full and 1e-7 in exponent form; the rule wants the opposite of both.
    expect(canonicalDecimal(1e16)).toBe('1e16');
    expect(canonicalDecimal(1e-16)).toBe('1e-16');
    expect(canonicalDecimal(1e15)).toBe('1000000000000000');
    expect(canonicalDecimal(1e-7)).toBe('0.0000001');
    expect(canonicalDecimal(-2.5e20)).toBe('-2.5e20');
  });

  it('refuses a non-finite decimal rather than hashing "Infinity"', () => {
    expect(() => canonicalDecimal(Number.POSITIVE_INFINITY)).toThrow(ClaimError);
    expect(() => canonicalDecimal(Number.NaN)).toThrow(ClaimError);
  });
});

describe('canonicalClaim (KGP §3.1)', () => {
  it('is world | relation(args) with no insignificant whitespace', () => {
    expect(canonicalClaim(BASE, row('located_in'))).toBe(
      'worldsim:world:alderforest|located_in(worldsim:world:alderforest:ent:npc-renaud,refkb:ent:alder-keep)',
    );
  });

  it('sorts a symmetric relation\'s operands, so same_as(a,b) and same_as(b,a) are one claim', () => {
    const forward: Claim = { ...BASE, relation: 'same_as', args: ['refkb:ent:b', 'refkb:ent:a'] };
    const backward: Claim = { ...BASE, relation: 'same_as', args: ['refkb:ent:a', 'refkb:ent:b'] };
    expect(canonicalClaim(forward, row('same_as'))).toBe(canonicalClaim(backward, row('same_as')));
    expect(claimId(forward, row('same_as'))).toBe(claimId(backward, row('same_as')));
  });

  it('does NOT sort an asymmetric relation — argument order is the registry\'s signature', () => {
    const forward: Claim = { ...BASE, relation: 'part_of', args: ['refkb:ent:a', 'refkb:ent:b'] };
    const backward: Claim = { ...BASE, relation: 'part_of', args: ['refkb:ent:b', 'refkb:ent:a'] };
    expect(claimId(forward, row('part_of'))).not.toBe(claimId(backward, row('part_of')));
  });

  it('refuses a claim whose arity is not the published one', () => {
    const short: Claim = { ...BASE, args: ['refkb:ent:a'] };
    expect(() => canonicalClaim(short, row('located_in'))).toThrow(/arity 2/);
    try {
      canonicalClaim(short, row('located_in'));
    } catch (error) {
      expect((error as ClaimError).code).toBe('arity-mismatch');
    }
  });

  it('grades a malformed world separately from a malformed argument', () => {
    const noWorld: Claim = { ...BASE, world: 'not-a-curie' };
    try {
      canonicalClaim(noWorld, row('located_in'));
      expect.unreachable('a malformed world must not canonicalize');
    } catch (error) {
      expect((error as ClaimError).code).toBe('malformed-world');
    }
  });
});

describe('claimId (KGP §3.1, §3.3)', () => {
  it('is sha256 of exactly the HASH_INPUT bytes and nothing else', () => {
    const input = canonicalClaim(BASE, row('located_in'));
    const expected = `sha256-${createHash('sha256').update(input, 'utf8').digest('hex')}`;
    expect(claimId(BASE, row('located_in'))).toBe(expected);
    expect(hashClaimInput(input)).toBe(expected);
  });

  it('excludes confidence, provenance, license, egress and valid_time — so producers MERGE', () => {
    // §3.3: the same fact from two producers, asserted with different confidence and
    // provenance, mints ONE id. That is what makes cross-producer dedup work at all.
    const first: Claim = { ...BASE, confidence: 0.51, prov: { source: 'worldsim', confidence: 0.5 } };
    const second: Claim = {
      ...BASE,
      confidence: 0.99,
      prov: { source: 'herbarium', confidence: 1 },
      license: 'CC0-1.0',
      egress: 'exportable',
      valid_time: { from: '2026-01-01T00:00:00Z' },
      embedding_model: 'some-model-v3',
    };
    expect(claimId(first, row('located_in'))).toBe(claimId(second, row('located_in')));
  });

  it('includes the world — the same fact in two worlds is two claims (KINP §5)', () => {
    const elsewhere: Claim = { ...BASE, world: 'worldsim:world:other' };
    expect(claimId(elsewhere, row('located_in'))).not.toBe(claimId(BASE, row('located_in')));
  });
});
