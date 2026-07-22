/**
 * The observation log (KCS §4.2).
 *
 * Every request, response and stream frame the console sees is recorded here, "stamped
 * with participant, plane, KINP ids touched, transaction time". Assertions (§5) are
 * evaluated *against the log*, not against a return value, which is what makes the console
 * an observer rather than a test harness with opinions: the report can always show the
 * slice of traffic that supports each verdict.
 *
 * Entries hold summaries and ids, never blobs — KMI §7 says bytes are fetched by id, and a
 * log that inlined them would be the payload hub ADR-0001 forbids.
 */
import type { Json, JsonObject, Plane } from '@agora/schemas';

import {
  idsIn,
  isEmpty,
  noFacts,
  type Facts,
  type ObservedAsset,
  type ObservedClaim,
  type ObservedLink,
} from './facts.ts';

/** Which side of a connection an entry recorded. */
export type Direction = 'request' | 'response' | 'frame';

/** A fact and the entry that saw it — a verdict's support slice comes back in this shape. */
export interface Sighting<T> {
  entry: Observation;
  value: T;
}

export interface Observation {
  /** Monotonic within a run — the log's own ordering, independent of wall clock. */
  seq: number;
  /** Transaction time (§4.2), ISO-8601. */
  at: string;
  /** The step that produced the traffic. */
  step: string;
  /** KINP identity of the peer, or `agora:agent:console` for the console's own acts. */
  participant: string;
  plane?: Plane | undefined;
  direction: Direction;
  /** KINP ids this entry touched — entities, worlds, assets, capabilities. */
  entities: string[];
  /** A summary: status, endpoint, resolved tier, cost. Never payload bytes. */
  detail: JsonObject;
  /**
   * The plane-typed records this entry carried (KGP claims, KMI assets, KINP links).
   * Present only when the peer stated them in a plane shape — the §5 assertions read
   * these, which is how a verdict is about the fabric rather than about generated text.
   */
  facts?: Facts | undefined;
}

/** What a caller hands {@link ObservationLog.record}; `seq` and `at` are the log's to stamp. */
export type ObservationDraft = Omit<Observation, 'seq' | 'at'>;

/** The console's own KINP identity — it is a participant too (KCS §4). */
export const CONSOLE_IDENTITY = 'agora:agent:console';

export class ObservationLog {
  private readonly recorded: Observation[] = [];
  private seq = 0;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  record(draft: ObservationDraft): Observation {
    // Ids the facts touched join `entities` automatically: §4.2 wants every entry stamped
    // with the KINP ids it touched, and a recorder that had to list them by hand would
    // eventually forget one — silently narrowing what an assertion can find.
    const facts = draft.facts;
    const entities =
      facts === undefined || isEmpty(facts)
        ? draft.entities
        : [...new Set([...draft.entities, ...idsIn(facts)])];
    const entry: Observation = { ...draft, entities, seq: ++this.seq, at: this.now() };
    this.recorded.push(entry);
    return entry;
  }

  entries(): readonly Observation[] {
    return this.recorded;
  }

  /** The slice of traffic a step produced — what a report shows beneath its verdict. */
  forStep(id: string): Observation[] {
    return this.recorded.filter((entry) => entry.step === id);
  }

  /** Every KINP id the run touched, in first-seen order. */
  entitiesTouched(): string[] {
    const seen = new Set<string>();
    for (const entry of this.recorded) for (const id of entry.entities) seen.add(id);
    return [...seen];
  }

  /** Every claim the run observed, each with the entry that saw it. */
  claimsSeen(): Sighting<ObservedClaim>[] {
    return this.sightings((facts) => facts.claims);
  }

  /** Every asset envelope the run observed, each with the entry that saw it. */
  assetsSeen(): Sighting<ObservedAsset>[] {
    return this.sightings((facts) => facts.assets);
  }

  /** Every equivalence / lineage link the run observed (KINP §4.2, KMI §3). */
  linksSeen(): Sighting<ObservedLink>[] {
    return this.sightings((facts) => facts.links);
  }

  /** The facts one step produced, merged — what a per-step assertion evaluates over. */
  factsForStep(id: string): Facts {
    const merged = noFacts();
    for (const entry of this.forStep(id)) {
      if (entry.facts === undefined) continue;
      merged.claims.push(...entry.facts.claims);
      merged.assets.push(...entry.facts.assets);
      merged.links.push(...entry.facts.links);
      merged.packs.push(...entry.facts.packs);
    }
    return merged;
  }

  private sightings<T>(pick: (facts: Facts) => T[]): Sighting<T>[] {
    const found: Sighting<T>[] = [];
    for (const entry of this.recorded) {
      if (entry.facts === undefined) continue;
      for (const value of pick(entry.facts)) found.push({ entry, value });
    }
    return found;
  }
}

/** A summary field, guarded: `undefined` is dropped rather than serialised as null. */
export function detail(fields: Record<string, Json | undefined>): JsonObject {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as JsonObject;
}
