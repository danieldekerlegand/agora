/**
 * The local resolver cache — identity.md §8: "each project can run a local resolver cache
 * for offline use that syncs `same_as` links opportunistically."
 *
 * This is what keeps Pinakes-as-authority (§11 decision 1) from becoming a hard dependency.
 * Minting is local (§6) and reconciliation is eventually consistent, so an unreachable
 * authority must degrade to "what it last said" rather than to a failure — Analyzer's
 * zero-spend/local-first operation and Insimul's embedded execution both depend on it.
 *
 * Deliberately an interface with a memory implementation: the console needs no durability,
 * and a project that does can back the same two methods with its own store.
 */
import type { ResolvedIdentity } from './types.ts';

export interface ResolverCache {
  get(id: string): ResolvedIdentity | undefined;
  set(id: string, identity: ResolvedIdentity): void;
}

/**
 * An in-process cache, optionally warmed with resolutions a caller already holds.
 *
 * Entries are stored exactly as the authority answered them, `authority` field included —
 * the *reader* stamps `cache` when it replays one, so the record of who said what survives
 * the round trip.
 */
export function createMemoryCache(seed: Iterable<ResolvedIdentity> = []): ResolverCache {
  const entries = new Map<string, ResolvedIdentity>();
  for (const identity of seed) entries.set(identity.id, identity);
  return {
    get: (id) => entries.get(id),
    set: (id, identity) => {
      entries.set(id, identity);
    },
  };
}
