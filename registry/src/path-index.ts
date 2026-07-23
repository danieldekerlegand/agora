/**
 * The binding boundary for the Rust path-index (`registry/path-index`).
 *
 * {@link findCapabilityPathIndexed} is a drop-in for `findCapabilityPath` — same
 * `Registration[]` + {@link PathQuery} in, same {@link CapabilityPath} out — that routes the search
 * through the in-process Rust N-API addon when its artifact is present, and falls back to the
 * pure-TypeScript implementation when it is not. Callers see no new types and no new failure mode:
 * the source-first package (`@agora/schemas` exports still point at `./src/index.ts`) imports and
 * runs whether or not a native artifact was ever built (US-5).
 *
 * The boundary carries JSON, never a payload or a transport: the addon receives the registry's own
 * registrations and returns a plan of addresses + capability names. Nothing crosses a network hop
 * and nothing is proxied — ADR-0001 decision 3 holds on the Rust side exactly as it does here.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCapabilityPath, type CapabilityPath, type PathQuery } from './path.ts';
import type { Registration } from './registry.ts';

/** The N-API surface the Rust addon exposes: JSON in, JSON out (or `null` for "no path"). */
interface NativeIndex {
  searchPath(registrationsJson: string, queryJson: string): string | null;
}

/** The artifact `npm run build:native -w @agora/registry` produces next to the crate. */
const ARTIFACT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'path-index',
  'agora_path_index.node',
);

// `undefined` = not yet probed, `null` = probed and absent/unusable, else the loaded addon.
let native: NativeIndex | null | undefined;

/** Load the addon once, memoizing both success and absence. Any load failure is a clean fallback. */
function loadNative(): NativeIndex | null {
  if (native !== undefined) return native;
  native = null;
  if (existsSync(ARTIFACT)) {
    try {
      const nodeRequire = createRequire(import.meta.url);
      const loaded = nodeRequire(ARTIFACT) as Partial<NativeIndex>;
      if (typeof loaded.searchPath === 'function') native = loaded as NativeIndex;
    } catch {
      native = null;
    }
  }
  return native;
}

/** True when the native path-index is loaded and serving searches (else the TS fallback is). */
export function isNativeIndexActive(): boolean {
  return loadNative() !== null;
}

/**
 * The best path from `query.from` to `query.to`, or `undefined` if the index has none — computed
 * by the Rust index when available, otherwise by the pure-TS `findCapabilityPath`. Identical
 * `CapabilityPath` either way (pinned by the golden parity harness).
 */
export function findCapabilityPathIndexed(
  registrations: readonly Registration[],
  query: PathQuery,
): CapabilityPath | undefined {
  const index = loadNative();
  if (index === null) return findCapabilityPath(registrations, query);
  const result = index.searchPath(JSON.stringify(registrations), JSON.stringify(query));
  return result === null ? undefined : (JSON.parse(result) as CapabilityPath);
}
