/**
 * Durable persistence for the resolver — so an offline restart is degraded, not amnesiac.
 *
 * Two things survive a process here, and they are kept as separate stores on purpose:
 *
 * 1. **A durable {@link ResolverCache}** ({@link createFileCache}) — the §8 "local resolver
 *    cache for offline use". It persists prior *authority* answers so a restart with the
 *    authority unreachable replays them as `authority:'cache'` (never `'authority'`), which is
 *    what keeps the authority (§11 decision 1) from being a hard dependency.
 * 2. **A durable {@link LinkStore}** ({@link createFileLinkStore}) — the equivalence layer's
 *    two lists (§11 decision 2): `applied` links auto-applied above the per-world threshold,
 *    and the `reviewQueue` of links held for the convergence-QA gate. A resolver that lost the
 *    queue on restart would be always-auto with extra steps; one that lost `applied` would
 *    re-decide links it had already asserted.
 *
 * Both mirror the memory-default-plus-durable-impl shape the interfaces already use
 * (`cache.ts`, and `registry/src/store.ts` for the registry side). Nothing here persists the
 * *merged view*: the cache stores the edges as the authority stated them and the closure is
 * **recomputed at read time by {@link closureOver}** (§4.1, §8), so a `based_on` edge can
 * never come back off disk masquerading as `same_as` — the firewall (§4.3) is structural,
 * not a property of what happened to be written.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ResolverCache } from './cache.ts';
import { closureOver } from './authority.ts';
import type { LinkProposal, ResolvedIdentity } from './types.ts';

/**
 * The equivalence-layer store behind an {@link AuthorityResolver}: the `applied` and
 * `reviewQueue` lists, held so both halves of the hybrid merge policy (§11 decision 2)
 * survive a restart. Deliberately an interface with a memory implementation, like
 * {@link ResolverCache} — a resolver that needs no durability passes nothing.
 */
export interface LinkStore {
  /** Links auto-applied above the threshold, in decision order — for rehydration on boot. */
  loadApplied(): LinkProposal[];
  /** Links queued for the convergence-QA gate — nothing here has been asserted. */
  loadReviewQueue(): LinkProposal[];
  /** Record an auto-applied link (§11 decision 2, the above-threshold half). */
  addApplied(proposal: LinkProposal): void;
  /** Record a queued link (below-threshold, ambiguous, or high-impact). */
  addReview(proposal: LinkProposal): void;
}

/** A non-durable {@link LinkStore} — the same shape backed by two arrays. */
export function createMemoryLinkStore(seed: {
  applied?: Iterable<LinkProposal>;
  reviewQueue?: Iterable<LinkProposal>;
} = {}): LinkStore {
  const applied: LinkProposal[] = [...(seed.applied ?? [])];
  const reviewQueue: LinkProposal[] = [...(seed.reviewQueue ?? [])];
  return {
    loadApplied: () => [...applied],
    loadReviewQueue: () => [...reviewQueue],
    addApplied: (proposal) => {
      applied.push(proposal);
    },
    addReview: (proposal) => {
      reviewQueue.push(proposal);
    },
  };
}

interface PersistedLinks {
  applied: LinkProposal[];
  reviewQueue: LinkProposal[];
}

/**
 * A file-backed {@link LinkStore} at a configurable path. Both lists live in one JSON object,
 * rewritten on every append — the equivalence layer is small (decisions, not payloads), so a
 * full flush is simpler and safer than an append log. A missing file is two empty lists.
 */
export function createFileLinkStore(path: string): LinkStore {
  const links = readLinks(path);
  const flush = (): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(links));
  };
  return {
    loadApplied: () => [...links.applied],
    loadReviewQueue: () => [...links.reviewQueue],
    addApplied: (proposal) => {
      links.applied.push(proposal);
      flush();
    },
    addReview: (proposal) => {
      links.reviewQueue.push(proposal);
      flush();
    },
  };
}

function readLinks(path: string): PersistedLinks {
  const raw = readMaybe(path);
  if (raw === undefined) return { applied: [], reviewQueue: [] };
  const parsed = JSON.parse(raw) as Partial<PersistedLinks>;
  return { applied: parsed.applied ?? [], reviewQueue: parsed.reviewQueue ?? [] };
}

/**
 * A file-backed {@link ResolverCache} at a configurable path — the durable form of
 * {@link createMemoryCache}. Prior authority answers live as one JSON object keyed by id,
 * rewritten on every `set`; a missing file is an empty cache.
 *
 * What is persisted is the edges, not the merged view: `get` re-runs {@link closureOver} over
 * the stored `same_as` / `based_on` edges every time, so the `same_as` closure is recomputed
 * at read time and a `based_on` edge is never walked into it (§4.3). The `authority` field is
 * stored as the authority stated it (`authority`); the *reader* stamps `cache` when it replays
 * one (see `offline` in `authority.ts`), so the record of who said what survives the restart.
 */
export function createFileCache(path: string): ResolverCache {
  const entries = readCache(path);
  const flush = (): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(entries)));
  };
  return {
    get: (id) => {
      const stored = entries.get(id);
      return stored === undefined ? undefined : reclose(stored);
    },
    set: (id, identity) => {
      entries.set(id, identity);
      flush();
    },
  };
}

/**
 * Rebuild a {@link ResolvedIdentity}'s two link sets from its stored edges by walking them
 * through {@link closureOver} — `same_as` transitively and in both directions, `based_on`
 * from the closure outward and never across. Re-closing the persisted edges is what makes the
 * firewall a property of the *read*, not of what was written: a store hand-edited to list a
 * `based_on` id under `same_as` still cannot leak it, because `same_as` is derived here.
 */
function reclose(record: ResolvedIdentity): ResolvedIdentity {
  const links = [
    ...record.sameAs.map((to) => ({ relation: 'same_as', from: record.id, to })),
    ...record.basedOn.map((to) => ({ relation: 'based_on', from: record.id, to })),
  ];
  const walked = closureOver(record.id, links);
  return { ...record, sameAs: walked.sameAs, basedOn: walked.basedOn };
}

function readCache(path: string): Map<string, ResolvedIdentity> {
  const raw = readMaybe(path);
  if (raw === undefined) return new Map();
  const records = JSON.parse(raw) as Record<string, ResolvedIdentity>;
  return new Map(Object.entries(records));
}

function readMaybe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
