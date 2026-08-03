/**
 * US-5 — retire legacy as the interchange home: the guards that keep the absorbed conformance
 * suite honest once legacy is gone.
 *
 * Three drifts this closes, none caught by the US-1/US-2/US-3 suites (which read the vendored
 * SNAPSHOT and never look back at koine or at the pinned spec versions):
 *
 *  1. The validation home is agora, resolved through `@agora/schemas` — never a `legacy-contract`
 *     import, never the `https://legacy.ecosystem/schemas/` id base (ADR-0001 / koine ADR-0003).
 *  2. The KGP artifact's contract version is pinned to agora's `SPEC_VERSIONS.kgp`, so the
 *     grounding-pack fixture and the koine spec version cannot silently diverge — one place goes
 *     red on a bump, the same discipline as the `versions.ts` ↔ Python cross-pin.
 *  3. The fixtures still satisfy the LIVE `koine/schemas/` files, not just the committed snapshot —
 *     a koine schema edit the fixtures no longer meet fails HERE rather than drifting undetected
 *     behind the regenerator until someone re-runs it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import * as schemas from '../index.ts';
import { SPEC_VERSIONS } from '../versions.ts';
import { ARTIFACT_SCHEMAS, BASE_URI, buildAjv, validate, type ArtifactName } from '../validator.ts';

const HERE = dirname(fileURLToPath(import.meta.url)); // schemas/src/conformance
const SNAPSHOT_DIR = join(HERE, '..', 'koine-schemas');
const FIXTURES_DIR = join(HERE, 'fixtures');

/** The deprecated legacy id base the ported schemas must have been rebased OFF of (ADR-0003). */
const ROSETTA_BASE_URI = 'https://legacy.ecosystem/schemas/';

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

/**
 * koine's canonical `schemas/` directory — the LIVE source the snapshot is derived from. koine is a
 * SIBLING of the agora working tree (`../koine`, ADR-0001), resolved against both this tree's own
 * repo root and the PRIMARY working tree (via git's common dir) so a git worktree — whose own
 * `../koine` does not exist — still finds the one checkout that does. Mirrors `findKoineSchemasDir`
 * in `scripts/regen-koine-schemas.mjs` and `koineRegistryDir` in `koine-fixture-drift.test.ts`.
 * Throws (never returns a bogus path) so an absent koine is a loud failure, never a green no-op.
 */
function koineSchemasDir(): string {
  const roots = [resolve(HERE, '..', '..')]; // this working tree's repo root (schemas/..)
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (commonDir) roots.push(dirname(commonDir)); // the primary working tree's root
  } catch {
    // git unavailable — the relative candidate above is the only one we can try.
  }
  for (const root of roots) {
    const dir = join(dirname(root), 'koine', 'schemas');
    if (existsSync(join(dir, 'provenance.schema.json'))) return dir;
  }
  throw new Error(
    'koine sibling checkout not found: expected `koine/schemas/provenance.schema.json` beside ' +
      'the agora working tree (../koine, ADR-0001). This test re-validates the fixtures against ' +
      'koine and cannot silently pass without it — clone koine next to agora and re-run.',
  );
}

describe('validation home is agora, not legacy (ADR-0001 / ADR-0003)', () => {
  it('exposes the artifact validator on the @agora/schemas surface, as its own entry point', () => {
    // Consumers resolve interchange validation through `@agora/schemas` — never a `legacy-contract`
    // import. It is a SUBPATH (`@agora/schemas/validator`) rather than an index re-export because
    // it reads the vendored schemas off disk: `node:fs`/`node:path` on the main entry point put
    // those builtins in every consumer's module graph and broke the console's browser bundle at
    // link time. Same package, same home for validation — one specifier further in.
    const exports = (JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8')) as {
      exports: Record<string, string>;
    }).exports;
    expect(exports['./validator']).toBe('./src/validator.ts');
    expect(typeof validate).toBe('function');
    expect(Object.keys(ARTIFACT_SCHEMAS).length).toBeGreaterThan(0);
    // ...and the main entry point stays environment-free, which is the half that rots silently.
    expect(schemas).not.toHaveProperty('validate');
    expect(schemas).not.toHaveProperty('ARTIFACT_SCHEMAS');
  });

  it('every ported schema resolves under the koine base-URI, never legacy', () => {
    const files = readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.schema.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const raw = readFileSync(join(SNAPSHOT_DIR, file), 'utf8');
      const { $id } = JSON.parse(raw) as { $id?: string };
      expect($id, `${file} declares no $id`).toBeTypeOf('string');
      expect($id, `${file} still lives under the legacy id base`).toBe(BASE_URI + file);
      // Belt-and-suspenders: no relative `$ref` or description drags the legacy base back in.
      expect(raw, `${file} still references ${ROSETTA_BASE_URI}`).not.toContain(ROSETTA_BASE_URI);
    }
  });
});

describe('grounding-pack contract version is pinned to SPEC_VERSIONS.kgp', () => {
  // The KGP artifact stamps the koine spec version into `kgp_version`. Tie the golden fixture to
  // agora's pinned `SPEC_VERSIONS.kgp` (schemas/src/versions.ts) so a KGP bump that touches only one
  // side goes red here — the fixture's contract version and the koine spec version cannot diverge
  // in silence, mirroring the versions.ts ↔ Python KCB_VERSION cross-pin.
  it('the golden fixture kgp_version equals SPEC_VERSIONS.kgp', () => {
    const fixture = loadFixture('grounding-pack');
    expect(fixture.kgp_version).toBe(SPEC_VERSIONS.kgp);
  });
});

describe('finetune-job contract version is pinned to SPEC_VERSIONS.kft', () => {
  // The KFT job manifest stamps the koine spec version into `kft_version`. Tie the golden fixture
  // to agora's pinned `SPEC_VERSIONS.kft` (schemas/src/versions.ts) so a KFT bump that touches only
  // one side goes red here — the fixture's KFT version and the koine spec version cannot diverge in
  // silence, the same discipline as the KGP pin above and the versions.ts ↔ Python KCB cross-pin.
  it('the golden fixture kft_version equals SPEC_VERSIONS.kft', () => {
    const fixture = loadFixture('finetune-job');
    expect(fixture.kft_version).toBe(SPEC_VERSIONS.kft);
  });
});

describe('fixtures re-validate against the LIVE koine/schemas (not the snapshot)', () => {
  const liveAjv = buildAjv(koineSchemasDir());

  /** Validate a fixture against the LIVE koine schema, reusing production's registration + naming. */
  function validateLive(name: ArtifactName, instance: unknown): string[] {
    const fn = liveAjv.getSchema(BASE_URI + ARTIFACT_SCHEMAS[name]) as ValidateFunction | undefined;
    if (!fn) throw new Error(`live koine/schemas is missing ${ARTIFACT_SCHEMAS[name]}`);
    if (fn(instance)) return [];
    return (fn.errors ?? []).map((e) => `${e.instancePath || '<root>'}: ${e.message}`);
  }

  // Data-driven over the same sorted keys as the snapshot conformance suite: a koine edit that the
  // fixtures no longer satisfy fails on THIS artifact, naming it.
  describe.each(Object.keys(ARTIFACT_SCHEMAS).sort())('%s', (name) => {
    it('golden fixture validates green against live koine', () => {
      expect(validateLive(name as ArtifactName, loadFixture(name))).toEqual([]);
    });
  });
});
