// Regenerate the vendored koine interchange-schema snapshot from the koine sibling checkout.
//
// The JSON Schemas are koine DATA (ADR-0001: koine specifies, agora implements) — koine ported
// them out of the deprecated legacy package into `koine/schemas/` (ADR-0003). agora holds the
// tooling (the ajv/jsonschema validators + the conformance suite), NOT an authored copy: a second
// AUTHORED copy of the schemas is how the contract forks. So the snapshot under
// `src/koine-schemas/` is DERIVED from koine — never hand-edited — and this script is that
// derivation, the only supported way to refresh it. It mirrors `regen-koine-fixture.mjs`.
//
//   node schemas/scripts/regen-koine-schemas.mjs          rewrite the snapshot from koine
//   node schemas/scripts/regen-koine-schemas.mjs --check   verify-only: exit 1 if the committed
//                                                          snapshot differs from koine, else 0
//
// Wired as `npm run -w @agora/schemas regen:koine-schemas[:check]`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // schemas/scripts
const SCHEMAS_DIR = resolve(HERE, '..'); // schemas
const SNAPSHOT_DIR = join(SCHEMAS_DIR, 'src', 'koine-schemas');

// The draft-2020-12 files agora's validators load: the interchange artifacts backing
// ARTIFACT_SCHEMAS plus the shared `provenance.schema.json` whose $defs (contractVersion / csid /
// provenance / license / tier / dialect / egress) every other schema $refs. Listed explicitly so
// a new koine schema does not silently enter agora's validator surface. `finetune-job.schema.json`
// (KFT §3) was added by agora:41 — it $refs provenance + dataset-jsonl-header, both already here.
const SCHEMA_FILES = [
  'provenance.schema.json',
  'grounding-pack.schema.json',
  'canonical-world-export.schema.json',
  'entity-grounding-snapshot.schema.json',
  'analyzer-canonical-export.schema.json',
  'dataset-jsonl-header.schema.json',
  'finetune-job.schema.json',
];

/**
 * koine's canonical `schemas/` directory — the source this snapshot is generated from. koine is a
 * SIBLING of the agora working tree (`../koine`, ADR-0001). It is resolved against the PRIMARY
 * working tree (via git's common dir) as well as this tree's own parent, so a git worktree — whose
 * own `../koine` does not exist — still finds the one checkout that does. Returns null when no koine
 * checkout is reachable, so callers can fail loudly rather than silently no-op.
 */
function findKoineSchemasDir() {
  const roots = [resolve(SCHEMAS_DIR, '..')]; // this working tree's repo root
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: SCHEMAS_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (commonDir) roots.push(dirname(commonDir)); // the primary working tree's root
  } catch {
    // git unavailable — the relative candidate above is the only one we can try.
  }
  for (const root of roots) {
    const dir = join(dirname(root), 'koine', 'schemas');
    if (existsSync(join(dir, 'provenance.schema.json'))) return dir;
  }
  return null;
}

function main() {
  const check = process.argv.includes('--check');
  const koineDir = findKoineSchemasDir();
  if (!koineDir) {
    console.error(
      'koine sibling checkout not found: expected a `koine/schemas/provenance.schema.json` ' +
        'beside the agora working tree (../koine). Clone koine next to agora, then re-run.',
    );
    process.exit(2);
  }

  const koineByFile = new Map();
  for (const file of SCHEMA_FILES) {
    const path = join(koineDir, file);
    if (!existsSync(path)) {
      console.error(`koine is missing ${file} — expected it under ${koineDir}. Has koine:10 landed?`);
      process.exit(2);
    }
    koineByFile.set(file, readFileSync(path));
  }

  if (check) {
    const drifted = [];
    for (const file of SCHEMA_FILES) {
      const local = join(SNAPSHOT_DIR, file);
      if (!existsSync(local) || !readFileSync(local).equals(koineByFile.get(file))) {
        drifted.push(`src/koine-schemas/${file}`);
      }
    }
    // A file the snapshot has but koine no longer does is drift too (a retired schema).
    const extra = existsSync(SNAPSHOT_DIR)
      ? readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.schema.json') && !SCHEMA_FILES.includes(f))
      : [];
    for (const file of extra) drifted.push(`src/koine-schemas/${file} (stale — not in koine)`);
    if (drifted.length > 0) {
      console.error(
        `koine schema snapshot is stale — regenerate it (npm run -w @agora/schemas regen:koine-schemas):\n  ${drifted.join('\n  ')}`,
      );
      process.exit(1);
    }
    console.log('koine schema snapshot is up to date with koine/schemas/.');
    return;
  }

  for (const file of SCHEMA_FILES) {
    writeFileSync(join(SNAPSHOT_DIR, file), koineByFile.get(file));
  }
  console.log(`Regenerated ${SCHEMA_FILES.length} koine schemas from ${koineDir}.`);
}

main();
