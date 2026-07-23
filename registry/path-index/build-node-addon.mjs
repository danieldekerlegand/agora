// Build the N-API addon and copy it next to the crate as `agora_path_index.node`, where the TS
// shim (`registry/src/path-index.ts`) looks for it. Invoked by `npm run build:native -w
// @agora/registry`. Not part of the gate: the shim falls back to pure TS when the artifact is
// absent, so a platform with no prebuilt addon still runs (US-5).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));

execFileSync('cargo', ['build', '--release', '--features', 'binding'], {
  cwd: here,
  stdio: 'inherit',
});

// The dynamic library name is platform-specific; the addon Node loads is always `*.node`.
const releaseDir = join(here, 'target', 'release');
const candidates = [
  'libagora_path_index.dylib',
  'libagora_path_index.so',
  'agora_path_index.dll',
];
const built = candidates.map((name) => join(releaseDir, name)).find(existsSync);
if (built === undefined) {
  console.error(`no built artifact found in ${releaseDir}`);
  process.exit(1);
}

const dest = join(here, 'agora_path_index.node');
copyFileSync(built, dest);
console.log(`copied ${built} -> ${dest}`);
