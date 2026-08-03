/**
 * ajv-backed validator over the ported koine interchange schemas — the TypeScript-ecosystem
 * half of the dual validator absorbed from the deprecated legacy package (ADR-0003).
 *
 * legacy was the ecosystem's load-bearing contract library; ADR-0001 rehomes contracts to koine
 * and runtime to agora, so koine:10 ported legacy's six draft-2020-12 schemas into `koine/schemas/`
 * (rebased off the `https://legacy.ecosystem/schemas/` id space onto koine's) and this is the
 * runtime that validates against them. It extends `@agora/schemas` from hand-narrowing manifests
 * and scenarios (`parseManifest` / `parseScenario`) to validating every koine interchange artifact.
 *
 * The schemas themselves are koine DATA, not agora's to author: they live under `./koine-schemas/`
 * as a snapshot DERIVED from koine (never hand-edited) by `scripts/regen-koine-schemas.mjs`, the
 * same discipline as the relation-registry fixture. Read from disk at call time, exactly as
 * legacy's `validate.mjs` did — a hand-inlined schema is a second authored copy, which is how the
 * contract forks.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv/dist/2020.js';

/**
 * Where the vendored schemas sit, resolved LAZILY — this module must have no top-level side
 * effect. `index.ts` re-exports `validate`, so every consumer of `@agora/schemas` pulls this
 * module into its graph; a bundler drops it (with ajv, `node:fs` and the rest) only while its
 * body stays pure. Computing this at module scope kept it alive and broke the console's browser
 * bundle on `node:path`. Keep it a call, not a const.
 *
 * In the published package the emitted `dist/validator.js` sits beside `dist/koine-schemas/`,
 * copied there by `scripts/copy-schema-assets.mjs` — which is why this is relative to the module
 * and not to the process's cwd.
 */
function vendoredSchemasDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'koine-schemas');
}

/**
 * The interchange artifacts agora validates, mapped to the koine schema file that governs each —
 * the five names legacy's `validate.mjs` exposed (grounding-pack, canonical-world-export,
 * entity-grounding-snapshot, canonical-graph-export, dataset-jsonl-header) plus `finetune-job`, the
 * KFT §3 job manifest agora:41 added (it `$ref`s provenance + dataset-jsonl-header, both already
 * registered). This validator checks STRUCTURE only — required fields, enums, types, `$ref`
 * resolution; the SEMANTIC admission rules KFT defines (modality×method compatibility, egress
 * feasibility, cost ceiling) are PROVIDER behavior enforced by the provider at invoke, not by
 * schema validation. `provenance.schema.json` is deliberately absent: it is the shared `$defs`
 * library every artifact `$ref`s, not a top-level artifact anyone validates against directly.
 *
 * Every name here is a CAPABILITY, never a producer: `canonical-graph-export` is *any* producer's
 * predicate web projected onto the canonical graph, whoever produced it.
 */
export const ARTIFACT_SCHEMAS = {
  'grounding-pack': 'grounding-pack.schema.json',
  'canonical-world-export': 'canonical-world-export.schema.json',
  'entity-grounding-snapshot': 'entity-grounding-snapshot.schema.json',
  'canonical-graph-export': 'canonical-graph-export.schema.json',
  'dataset-jsonl-header': 'dataset-jsonl-header.schema.json',
  'finetune-job': 'finetune-job.schema.json',
} as const;

/** A validatable artifact name — a key of {@link ARTIFACT_SCHEMAS}. */
export type ArtifactName = keyof typeof ARTIFACT_SCHEMAS;

/**
 * The koine schema id base. Every ported schema declares `$id`
 * `https://koine.ecosystem/schemas/<file>` (rebased off legacy's own base by koine:10), so a
 * relative `$ref` such as `provenance.schema.json#/$defs/provenance` resolves against it. Exported
 * (but not re-exported from `index.ts`, so off the library surface) for the drift guard that
 * asserts no schema still lives under `https://legacy.ecosystem/schemas/`.
 */
export const BASE_URI = 'https://koine.ecosystem/schemas/';

/**
 * Build an ajv instance with every `*.schema.json` under `schemasDir` loaded, dual-registered under
 * both its declared `$id` and the base-URI + filename so relative `$ref`s resolve either way — the
 * same dual registration as legacy's `validate.mjs` (`ajv.addSchema` ×2) and `validate.py`
 * (`registry.with_resource` ×2). For the ported koine schemas `$id === BASE_URI + file`, so the
 * guard collapses the pair to one `addSchema` and ajv never sees a duplicate id.
 *
 * Defaults to the vendored snapshot ({@link vendoredSchemasDir}); the version-drift guard passes the LIVE
 * `koine/schemas/` directory so it exercises this exact registration against koine's own files, not
 * the snapshot. Exported for that test but not re-exported from `index.ts` — off the library surface.
 */
export function buildAjv(schemasDir: string = vendoredSchemasDir()): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const file of readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'))) {
    const schema = JSON.parse(readFileSync(join(schemasDir, file), 'utf8')) as AnySchemaObject;
    ajv.addSchema(schema, schema.$id);
    if (schema.$id !== BASE_URI + file) ajv.addSchema(schema, BASE_URI + file);
  }
  return ajv;
}

/**
 * Validate `instance` against the koine schema named `name`. Returns a list of error strings
 * (`<instancePath>: <message>`); an empty list means the artifact conforms. Throws if `name` is not
 * one of {@link ARTIFACT_SCHEMAS} — the message lists the valid names, as legacy's validators did.
 */
export function validate(name: string, instance: unknown): string[] {
  const file = ARTIFACT_SCHEMAS[name as ArtifactName];
  if (!file) {
    const valid = Object.keys(ARTIFACT_SCHEMAS).sort().join(', ');
    throw new Error(`unknown schema '${name}' (valid: ${valid})`);
  }
  const validateFn = buildAjv().getSchema(BASE_URI + file) as ValidateFunction | undefined;
  if (!validateFn) throw new Error(`schema '${file}' failed to load from ${vendoredSchemasDir()}`);
  if (validateFn(instance)) return [];
  return (validateFn.errors ?? []).map((e) => `${e.instancePath || '<root>'}: ${e.message}`);
}
