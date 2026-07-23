/**
 * US-1 (agora:41) — the dedicated finetune-job assertion the KFT §3 job manifest earns as it
 * joins ARTIFACT_SCHEMAS: a well-formed job validates to `[]`, and dropping any one required
 * top-level field (kft_version/job/base_model/modality/method/dataset/compute) surfaces an error.
 *
 * This is the STRUCTURAL twin of the KFT spec — required fields, enums, types, and cross-schema
 * `$ref` resolution (kft_version → provenance.schema.json#/$defs/contractVersion, dataset.header →
 * dataset-jsonl-header.schema.json). The SEMANTIC admission rules KFT defines (modality×method
 * compatibility FT-F, egress feasibility §4.2, admission-time cost ceiling §7) are PROVIDER
 * behavior enforced at invoke (agora:90 / pinakes:90), NOT schema validation — their absence here
 * is intentional. The golden fixture is read from `fixtures/` (off the @agora/schemas surface),
 * the same discipline as the data-driven conformance suite.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validate } from '../validator.ts';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFinetuneJob(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'finetune-job.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** The KFT §3 required top-level fields — dropping any one must be rejected. */
const REQUIRED = ['kft_version', 'job', 'base_model', 'modality', 'method', 'dataset', 'compute'];

describe('finetune-job structural validator (KFT §3)', () => {
  it('a well-formed finetune-job validates to []', () => {
    // Also exercises cross-schema $ref resolution: kft_version resolves through
    // provenance.schema.json, and dataset.header through dataset-jsonl-header.schema.json.
    expect(validate('finetune-job', loadFinetuneJob())).toEqual([]);
  });

  it.each(REQUIRED)('rejects a job missing the required field %s', (field) => {
    const instance = loadFinetuneJob();
    delete instance[field];
    expect(validate('finetune-job', instance).length).toBeGreaterThan(0);
  });

  // US-2 (agora:41) — the STRUCTURAL negative twin: perturbations that draft-2020-12 catches
  // on its own (bad enum, missing nested required, an unsatisfied anyOf). These stay firmly on
  // the structural side of the SCOPE BOUNDARY: what is NOT tested here is the SEMANTIC admission
  // KFT defines — modality×method compatibility (FT-F), egress feasibility / cross-boundary
  // placement (§4.2), the admission-time cost ceiling (§7). Those are PROVIDER behavior enforced
  // at invoke (agora:90-finetune-trainer, pinakes:90-finetune-provider), NOT schema shape, so a
  // fixture like modality:text-to-image × method:dpo validates GREEN here by design — its absence
  // is intentional, not a coverage gap.
  it('rejects a bad modality enum value', () => {
    const instance = loadFinetuneJob();
    instance.modality = 'not-a-modality';
    expect(validate('finetune-job', instance).length).toBeGreaterThan(0);
  });

  it('rejects a bad method enum value', () => {
    const instance = loadFinetuneJob();
    instance.method = 'not-a-method';
    expect(validate('finetune-job', instance).length).toBeGreaterThan(0);
  });

  it('rejects a compute block missing class', () => {
    const instance = loadFinetuneJob();
    delete (instance.compute as Record<string, unknown>).class;
    expect(validate('finetune-job', instance).length).toBeGreaterThan(0);
  });

  it('rejects a dataset with neither knowledge nor media (anyOf)', () => {
    const instance = loadFinetuneJob();
    const dataset = instance.dataset as Record<string, unknown>;
    delete dataset.knowledge;
    delete dataset.media;
    expect(validate('finetune-job', instance).length).toBeGreaterThan(0);
  });
});
