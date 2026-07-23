// Regenerate the koine relation-registry test fixture from the koine sibling checkout.
//
// The registry is DATA and data lives in koine (ADR-0001: koine specifies, agora implements);
// agora holds the tooling, not a copy. A second AUTHORED copy of the registry is how the
// registry forks, so the snapshot under schemas/src/fixtures/koine-registry/ is DERIVED from
// koine — never hand-edited. This script is that derivation, and it is the only supported way
// to refresh the fixture.
//
// It (re)writes two artifacts, both verbatim from koine:
//   - src/fixtures/koine-registry/predicate-mapping.json — koine's bridge mappings, byte-for-byte
//   - src/fixtures/koine-registry.ts                     — the four vocabulary TSVs, machine-emitted
//                                                          as the CORE/CINE/MEDIA/SOCIAL literals
//
//   node schemas/scripts/regen-koine-fixture.mjs          rewrite the fixture from koine
//   node schemas/scripts/regen-koine-fixture.mjs --check   verify-only: exit 1 if the committed
//                                                          fixture differs from koine, else 0
//
// Wired as `npm run -w @agora/schemas regen:koine-fixture[:check]`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // schemas/scripts
const SCHEMAS_DIR = resolve(HERE, '..'); // schemas
const FIXTURE_JSON = join(SCHEMAS_DIR, 'src', 'fixtures', 'koine-registry', 'predicate-mapping.json');
const FIXTURE_TS = join(SCHEMAS_DIR, 'src', 'fixtures', 'koine-registry.ts');

// The vocabulary TSVs, in the order the loader fetches them: core first, then the domains.
// `const` is the TS binding the fixture emits; `koinePath` / `registryPath` are the paths within
// koine's `registry/` and the fixture's declared `path`, which the loader keys on.
const VOCABULARY = [
  { const: 'CORE_RELATIONS', koinePath: 'relations.tsv', registryPath: 'registry/relations.tsv' },
  {
    const: 'CINEMATOGRAPHY_RELATIONS',
    koinePath: 'relations/cinematography.tsv',
    registryPath: 'registry/relations/cinematography.tsv',
  },
  {
    const: 'MEDIA_RELATIONS',
    koinePath: 'relations/media.tsv',
    registryPath: 'registry/relations/media.tsv',
  },
  {
    const: 'SOCIAL_RELATIONS',
    koinePath: 'relations/social.tsv',
    registryPath: 'registry/relations/social.tsv',
  },
];

/**
 * koine's canonical `registry/` directory — the source this fixture is generated from. koine is
 * a SIBLING of the agora working tree (`../koine`, ADR-0001). It is resolved against the PRIMARY
 * working tree (via git's common dir) as well as this tree's own parent, so a git worktree —
 * whose own `../koine` does not exist — still finds the one checkout that does. Returns null when
 * no koine checkout is reachable, so callers can fail loudly rather than silently no-op.
 */
function findKoineRegistryDir() {
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
    const dir = join(dirname(root), 'koine', 'registry');
    if (existsSync(join(dir, 'predicate-mapping.json'))) return dir;
  }
  return null;
}

/** Escape a TSV blob so it is safe inside a `...` template literal. */
function asTemplateLiteral(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `\`${escaped}\``;
}

/** The full text of the generated koine-registry.ts, given koine's TSVs keyed by const name. */
function renderFixtureTs(tsvByConst) {
  const literals = VOCABULARY.map(
    (v) => `const ${v.const} = ${asTemplateLiteral(tsvByConst[v.const])};\n`,
  ).join('\n');
  const entries = VOCABULARY.map(
    (v) => `  { path: '${v.registryPath}', text: ${v.const} },`,
  ).join('\n');
  return `/**
 * A snapshot of the real koine relation registry, for tests only.
 *
 * GENERATED — do not edit by hand. Regenerated verbatim from the koine sibling checkout by
 * \`schemas/scripts/regen-koine-fixture.mjs\` (\`npm run -w @agora/schemas regen:koine-fixture\`).
 * That regenerator is the ONLY supported way to refresh this fixture: a second AUTHORED copy of
 * the registry is how the registry forks (ADR-0001 — koine specifies, agora implements; agora
 * holds the tooling, not a copy), so the snapshot is derived from koine and never pasted in.
 *
 * The registry itself lives in koine and is fetched over the wire (\`relation-registry.ts\`);
 * nothing in \`@agora/schemas\`'s library surface reads what is here, and this module is exported
 * as \`@agora/schemas/fixtures\` (never from \`./index.ts\`) so it cannot become the vendored second
 * copy the registry exists to prevent. It is here because the validator has to be tested against
 * the *real* registry — a hand-written sample proves only that the validator accepts hand-written
 * samples.
 *
 * To refresh after a koine bump: run the regenerator. \`--check\` mode (\`npm run -w @agora/schemas
 * regen:koine-fixture:check\`) fails when the committed snapshot has drifted from koine.
 */
import mapping from './koine-registry/predicate-mapping.json';
import type { VocabularyFile } from '../registry-schema.ts';

/** \`koine/registry/predicate-mapping.json\` verbatim, typed as what it arrives as: unknown. */
export const KOINE_PREDICATE_MAPPING: unknown = mapping;

${literals}
/** The vocabulary files, core first — the order the loader fetches them in. */
export const KOINE_VOCABULARY: readonly VocabularyFile[] = [
${entries}
];
`;
}

function main() {
  const check = process.argv.includes('--check');
  const koineDir = findKoineRegistryDir();
  if (!koineDir) {
    console.error(
      'koine sibling checkout not found: expected a `koine/registry/predicate-mapping.json` ' +
        'beside the agora working tree (../koine). Clone koine next to agora, then re-run.',
    );
    process.exit(2);
  }

  const koineJson = readFileSync(join(koineDir, 'predicate-mapping.json'));
  const tsvByConst = {};
  for (const v of VOCABULARY) {
    tsvByConst[v.const] = readFileSync(join(koineDir, v.koinePath), 'utf8');
  }
  const fixtureTs = renderFixtureTs(tsvByConst);

  if (check) {
    const drifted = [];
    if (!existsSync(FIXTURE_JSON) || !readFileSync(FIXTURE_JSON).equals(koineJson)) {
      drifted.push('src/fixtures/koine-registry/predicate-mapping.json');
    }
    if (!existsSync(FIXTURE_TS) || readFileSync(FIXTURE_TS, 'utf8') !== fixtureTs) {
      drifted.push('src/fixtures/koine-registry.ts');
    }
    if (drifted.length > 0) {
      console.error(
        `koine fixture is stale — regenerate it (npm run -w @agora/schemas regen:koine-fixture):\n  ${drifted.join('\n  ')}`,
      );
      process.exit(1);
    }
    console.log('koine fixture is up to date with koine/registry/.');
    return;
  }

  writeFileSync(FIXTURE_JSON, koineJson);
  writeFileSync(FIXTURE_TS, fixtureTs);
  console.log(`Regenerated the koine fixture from ${koineDir}.`);
}

main();
