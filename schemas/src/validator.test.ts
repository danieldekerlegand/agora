import { describe, expect, it } from 'vitest';
import { ARTIFACT_SCHEMAS, validate } from './validator.ts';

const HEX64 = 'a'.repeat(64);

/** A well-formed grounding-pack in the ported KGP §2 envelope (koine grounding-pack.schema.json). */
const GROUNDING_PACK = {
  kgp_version: '0.4.0',
  pack_id: `sha256-${HEX64}`,
  producer: 'pinakes',
  worlds: ['pinakes:world:consensus-reality'],
  kind: 'snapshot',
  basis: null,
  dialect: 'grounding-only',
  entities: [
    {
      csid: 'cs:language:Q1860',
      entityType: 'language',
      fields: { name: 'English' },
      provenance: { source: 'wikidata', confidence: 1.0 },
      license: 'CC0-1.0',
    },
  ],
  assertions: [
    {
      id: `pinakes:claim:sha256-${HEX64}`,
      provenance: { source: 'pinakes', confidence: 0.9 },
      license: 'CC0-1.0',
    },
  ],
  manifest: { counts: { entities: 1, assertions: 1 }, license_policy: { 'CC0-1.0': 2 } },
};

describe('validate', () => {
  it('returns [] for a well-formed artifact', () => {
    // Exercises the restructured grounding-pack envelope AND cross-schema $ref resolution:
    // csid / provenance / license all resolve through provenance.schema.json's $defs.
    expect(validate('grounding-pack', GROUNDING_PACK)).toEqual([]);
  });

  it('surfaces a schema violation as a non-empty error list', () => {
    const bad = { ...GROUNDING_PACK, producer: 'Not A Namespace' };
    expect(validate('grounding-pack', bad).length).toBeGreaterThan(0);
  });

  it('throws for an unknown schema name, listing the valid names', () => {
    const names = Object.keys(ARTIFACT_SCHEMAS).sort().join(', ');
    expect(() => validate('nope', {})).toThrow(`unknown schema 'nope' (valid: ${names})`);
    // The five legacy-absorbed artifact names plus finetune-job (KFT §3, agora:41), and only those.
    expect(names).toBe(
      'analyzer-canonical-export, canonical-world-export, dataset-jsonl-header, ' +
        'entity-grounding-snapshot, finetune-job, grounding-pack',
    );
  });
});
