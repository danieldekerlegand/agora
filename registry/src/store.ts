/**
 * Durable persistence behind the index — so a registration survives a process restart.
 *
 * Deliberately an interface with a memory implementation, mirroring the resolver's
 * `resolver/src/cache.ts`: the default {@link createRegistry} needs no durability, and a
 * deployment that does can back the same three methods with its own store. The store sits
 * *behind* {@link CapabilityRegistry}; it never becomes a second opinion on a manifest.
 *
 * The record it persists is exactly what `register` stored — identity, the verbatim
 * (frozen-on-rehydrate) manifest, the `addressOf` address, `source`, and the 1-based
 * sequence — so a rehydrated index is byte-identical to the live one (capability-bus.md §3:
 * "a provider's manifest is authoritative; the registry just makes it findable").
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Registration } from './registry.ts';

export interface ManifestStore {
  /** Every persisted registration, for rehydration on boot. Order is immaterial —
   * {@link CapabilityRegistry.list} re-sorts by `sequence`. */
  load(): Registration[];
  /** Persist (or replace) a registration by identity — exactly as the index holds it. */
  save(registration: Registration): void;
  /** Drop a registration from durable storage. Redeploys aside, `remove` means gone. */
  delete(identity: string): void;
}

/**
 * A non-durable store — the same shape as the durable one, backed by a Map. Useful for
 * tests and for wiring code that wants a store seam without committing to a file yet.
 */
export function createMemoryStore(seed: Iterable<Registration> = []): ManifestStore {
  const entries = new Map<string, Registration>();
  for (const registration of seed) entries.set(registration.identity, registration);
  return {
    load: () => [...entries.values()],
    save: (registration) => {
      entries.set(registration.identity, registration);
    },
    delete: (identity) => {
      entries.delete(identity);
    },
  };
}

/**
 * A file-backed JSON store at a configurable path. The whole index is one JSON array of
 * {@link Registration} records, rewritten on every `save`/`delete` — small enough (an index
 * of addresses, not payloads) that a full flush is simpler and safer than an append log, and
 * the round-trip is the same JSON a manifest already is. A missing file is an empty index.
 */
export function createFileStore(path: string): ManifestStore {
  const entries = readFile(path);
  const flush = (): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...entries.values()]));
  };
  return {
    load: () => [...entries.values()],
    save: (registration) => {
      entries.set(registration.identity, registration);
      flush();
    },
    delete: (identity) => {
      if (entries.delete(identity)) flush();
    },
  };
}

function readFile(path: string): Map<string, Registration> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
  const records = JSON.parse(raw) as Registration[];
  return new Map(records.map((record) => [record.identity, record]));
}
