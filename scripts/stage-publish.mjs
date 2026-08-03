// Stage the publishable packages — the bridge between the source-first workspace and npm.
//
// In-tree, every package's `exports` points at `src/index.ts`: nothing is emitted, so there is no
// cross-package build ordering (README "Stack"). An out-of-tree consumer cannot compile our
// TypeScript, so what we publish must point at the `dist/` that `npm run build` emits.
//
// The obvious wiring — `publishConfig.exports` in package.json — does NOT work: npm (10.x) leaves
// `exports` untouched when it builds the tarball, so the published package would send consumers to
// `src/index.ts`, which is not even shipped. Verified, not assumed: an earlier revision did exactly
// that and `npm install <tarball>` failed with ERR_MODULE_NOT_FOUND on `@agora/sdk/src/index.ts`.
//
// So instead of mutating package.json in place (a crash mid-publish would leave the workspace
// pointing at dist), each package is staged into its own `.publish/` directory: the emitted dist,
// the README, and a package.json DERIVED from the real one with every export remapped
// `./src/x.ts` → `./dist/x.js`. `npm publish schemas/.publish clients/sdk/.publish` ships those.
//
//   node scripts/stage-publish.mjs        (run by `make build-sdk`, after the dists are emitted)
//
// A subpath whose target is not in dist is dropped with a note — that is how `@agora/schemas`'s
// `./fixtures` (test data, excluded from the publish build) stays out of the published surface.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The only packages that leave this repo: the SDK, and the one dependency it carries with it. */
const PUBLISHABLE = ['schemas', 'clients/sdk'];

/** The package.json fields that describe the artifact rather than how the workspace builds it. */
const CARRIED = [
  'name',
  'version',
  'description',
  'keywords',
  'license',
  'author',
  'homepage',
  'repository',
  'bugs',
  'type',
  'sideEffects',
  'engines',
  'dependencies',
  'peerDependencies',
  'publishConfig',
];

for (const relative of PUBLISHABLE) {
  const packageDir = join(ROOT, relative);
  const source = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const dist = join(packageDir, 'dist');
  if (!existsSync(dist)) {
    console.error(`${source.name}: dist/ is missing — run \`npm run build -w ${source.name}\` first`);
    process.exit(1);
  }

  const staging = join(packageDir, '.publish');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(dist, join(staging, 'dist'), { recursive: true });
  cpSync(join(packageDir, 'README.md'), join(staging, 'README.md'));

  const manifest = { files: ['dist', 'README.md'] };
  for (const field of CARRIED) if (source[field] !== undefined) manifest[field] = source[field];
  manifest.main = './dist/index.js';
  manifest.types = './dist/index.d.ts';
  manifest.exports = {};
  for (const [subpath, target] of Object.entries(source.exports)) {
    const js = target.replace(/^\.\/src\//, './dist/').replace(/\.tsx?$/, '.js');
    if (!existsSync(join(staging, js))) {
      console.log(`${source.name}: dropping "${subpath}" — ${js} is not in the publish build`);
      continue;
    }
    manifest.exports[subpath] = { types: js.replace(/\.js$/, '.d.ts'), default: js };
  }
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${source.name}@${source.version} staged in ${relative}/.publish`);
}
