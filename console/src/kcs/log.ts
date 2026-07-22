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

/** Which side of a connection an entry recorded. */
export type Direction = 'request' | 'response' | 'frame';

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
    const entry: Observation = { ...draft, seq: ++this.seq, at: this.now() };
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
}

/** A summary field, guarded: `undefined` is dropped rather than serialised as null. */
export function detail(fields: Record<string, Json | undefined>): JsonObject {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as JsonObject;
}
