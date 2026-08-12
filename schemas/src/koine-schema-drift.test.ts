import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The koine interchange schemas are vendored TWICE inside this repo: `src/koine-schemas/` (what
// the TS ajv validator and — via `SCHEMAS_DIR` in artifact_validator.py — the Python one both
// read) and `trainer/src/agora_trainer/schemas/` (what a DEPLOYED trainer ships, since a running
// service has no `../koine` beside it, ADR-0001). Both are snapshots DERIVED from koine, never
// authored here; a second authored copy is how the contract forks.
//
// Each copy is already pinned to koine on its own side — the snapshot by
// `scripts/regen-koine-schemas.mjs --check`, the trainer's by `trainer/tests/test_schema_drift.py`.
// Neither pin, though, is reachable from a checkout with no koine sibling (the script exits 2, the
// pytest skips), and neither ever compares the two copies to EACH OTHER. So the drift this file
// closes is the one that survives both: a refresh applied to one copy and not the other, which
// leaves the trainer admitting jobs the conformance validators reject (or the reverse) while every
// existing gate stays green.
//
// Two assertions, deliberately split by what they need:
//   1. copy ⇔ copy — pure bytes on disk, no koine, so it holds in ANY checkout. This is the one
//      that catches a half-applied refresh.
//   2. snapshot ⇔ koine — delegated to the regenerator's own `--check` mode rather than a fourth
//      hand-rolled koine resolver, so the pin and the derivation can never disagree about what
//      "up to date" means.

const HERE = dirname(fileURLToPath(import.meta.url)); // schemas/src
const SCHEMAS_PKG = resolve(HERE, '..'); // schemas
const REPO_ROOT = resolve(SCHEMAS_PKG, '..');
const SNAPSHOT_DIR = join(HERE, 'koine-schemas');
const TRAINER_SCHEMAS_DIR = join(REPO_ROOT, 'trainer', 'src', 'agora_trainer', 'schemas');

/** The `.schema.json` files a directory vendors, sorted so the two lists compare name for name. */
function vendoredFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.schema.json'))
    .sort();
}

describe('vendored koine schemas do not fork between ecosystems', () => {
  const trainerFiles = vendoredFiles(TRAINER_SCHEMAS_DIR);

  // Guard the loop below against passing vacuously: the trainer vendors the KFT §3 job manifest
  // plus the two schemas it $refs, and if that set ever reads empty the per-file assertions would
  // simply not run.
  it('the trainer vendors the KFT job manifest and the schemas it refs', () => {
    expect(trainerFiles).toEqual([
      'dataset-jsonl-header.schema.json',
      'finetune-job.schema.json',
      'provenance.schema.json',
    ]);
  });

  it.each(trainerFiles)(
    '%s is byte-identical between src/koine-schemas/ and the trainer package',
    (file) => {
      const snapshotPath = join(SNAPSHOT_DIR, file);
      expect(
        existsSync(snapshotPath),
        `trainer/src/agora_trainer/schemas/${file} has no counterpart in schemas/src/koine-schemas/ — ` +
          `add it to SCHEMA_FILES in scripts/regen-koine-schemas.mjs and regenerate`,
      ).toBe(true);
      expect(
        readFileSync(join(TRAINER_SCHEMAS_DIR, file), 'utf8'),
        `${file} has forked: the trainer's vendored copy differs from schemas/src/koine-schemas/. ` +
          `Both are snapshots of koine — refresh BOTH from koine, never hand-edit ` +
          `(npm run -w @agora/schemas regen:koine-schemas; cp ../koine/schemas/${file} ${TRAINER_SCHEMAS_DIR}/${file})`,
      ).toBe(readFileSync(snapshotPath, 'utf8'));
    },
  );

  it('pins the snapshot to koine via the regenerator that produced it', () => {
    // `--check` exits 0 when every file matches koine, 1 on drift, 2 when no koine sibling is
    // reachable. All three are surfaced: this package's gate already hard-requires koine
    // (conformance/version-drift.test.ts re-validates the fixtures against the LIVE schemas), so an
    // absent koine is a loud failure here too rather than a green no-op.
    try {
      execFileSync('node', [join(SCHEMAS_PKG, 'scripts', 'regen-koine-schemas.mjs'), '--check'], {
        cwd: SCHEMAS_PKG,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const { status, stderr } = error as { status?: number; stderr?: string };
      throw new Error(
        `regen-koine-schemas.mjs --check exited ${String(status)}:\n${stderr ?? String(error)}`,
      );
    }
  });
});
