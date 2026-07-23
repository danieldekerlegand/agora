/**
 * The conformance gate absorbed from legacy (`tests/conformance.test.mjs`, ADR-0003), re-homed
 * onto the ported koine/schemas and the US-1 ajv validator. Five golden fixtures — one per
 * ARTIFACT_SCHEMAS name — that every producer's output is measured against.
 *
 * These are the same five legacy fixtures, vendored verbatim EXCEPT grounding-pack, which was
 * re-authored onto the KGP §2 envelope (kgp_version / pack_id / producer / worlds / kind / basis /
 * dialect + entities / assertions / manifest): legacy's {contractVersion, packId, source, domains,
 * prologFacts, licenseManifest} shape does not exist in koine anymore. The fixtures live under
 * `conformance/fixtures/` and are read from disk — deliberately off the `@agora/schemas` library
 * surface (not in package.json exports, not re-exported from index.ts), the way `src/fixtures/` is.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_SCHEMAS, validate, type ArtifactName } from '../validator.ts';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Load a golden fixture as a mutable object so the negative cases can perturb it. */
function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

/**
 * The required spec-version key each artifact stamps its koine contract version into. Legacy's
 * `conformance.test.mjs` deleted `contractVersion` for every artifact; koine kept that key on four
 * of the five but restructured grounding-pack's onto KGP §2's `kgp_version` (ADR-0003). Deleting
 * the artifact's actual version key must fail — a missing contract version is the canonical
 * negative case in both ecosystems.
 */
const VERSION_KEY: Record<ArtifactName, string> = {
  'grounding-pack': 'kgp_version',
  'canonical-world-export': 'contractVersion',
  'entity-grounding-snapshot': 'contractVersion',
  'analyzer-canonical-export': 'contractVersion',
  'dataset-jsonl-header': 'contractVersion',
  // finetune-job stamps the KFT spec version into `kft_version` (a required $ref to
  // provenance.schema.json#/$defs/contractVersion) — deleting it is the missing-version case.
  'finetune-job': 'kft_version',
};

// Data-driven over the sorted ARTIFACT_SCHEMAS keys (validate.mjs L21-27 / conformance.test.mjs
// L11): a new artifact type adds a fixture file and a VERSION_KEY entry, no new test code. This is
// a POSITIVE conformance gate first — every fixture must validate green — then the negative twin.
describe.each(Object.keys(ARTIFACT_SCHEMAS).sort())('%s conformance', (name) => {
  it('golden fixture validates to []', () => {
    expect(validate(name, loadFixture(name))).toEqual([]);
  });

  it('rejects a missing contract version', () => {
    const instance = loadFixture(name);
    delete instance[VERSION_KEY[name as ArtifactName]];
    expect(validate(name, instance).length).toBeGreaterThan(0);
  });
});

describe('analyzer-canonical-export', () => {
  it('rejects a non-conforming node id', () => {
    const instance = loadFixture('analyzer-canonical-export');
    const nodes = instance.nodes as [{ id: string }, ...{ id: string }[]];
    nodes[0].id = 'not-a-valid-id';
    expect(validate('analyzer-canonical-export', instance).length).toBeGreaterThan(0);
  });
});
