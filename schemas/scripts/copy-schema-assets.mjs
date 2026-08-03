// Copy the vendored koine JSON Schemas into the publish build.
//
// `validator.ts` loads them at RUNTIME, off its own module directory
// (`join(dirname(fileURLToPath(import.meta.url)), 'koine-schemas')`), so the emitted
// `dist/validator.js` needs `dist/koine-schemas/` beside it or the published package throws on
// first validate(). tsc does not copy non-TypeScript assets, so this does — it is the second half
// of `npm run -w @agora/schemas build`.
//
// It copies; it never edits. The snapshot itself is derived from koine by
// `regen-koine-schemas.mjs`, which stays the only supported way to change it.

import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // schemas/scripts
const PACKAGE_DIR = resolve(HERE, '..'); // schemas
const SOURCE = join(PACKAGE_DIR, 'src', 'koine-schemas');
const TARGET = join(PACKAGE_DIR, 'dist', 'koine-schemas');

if (!existsSync(join(PACKAGE_DIR, 'dist'))) {
  console.error('dist/ is missing — run `tsc -p tsconfig.build.json` first');
  process.exit(1);
}

cpSync(SOURCE, TARGET, { recursive: true });
console.log(`copied ${String(readdirSync(TARGET).length)} koine schema(s) into dist/koine-schemas`);
