/**
 * The live feed — the observation log, read as fabric events.
 *
 * The monitor holds no store of its own. It subscribes as a consumer, the frames land in the
 * same {@link ObservationLog} a scenario run records into, and this module projects that log
 * into one row per *thing that happened on the fabric*: a claim asserted, an asset published,
 * an exchange reported. That projection is the whole of the difference between the timeline
 * (which shows traffic the console was part of) and the feed (which shows what crossed the
 * fabric), and it is a pure function of the log — nothing here dials, buffers or retains.
 *
 * Only `frame` entries become events. A request or a response is the console's own exchange
 * with a peer; a frame is something the peer chose to publish, which is the only kind of event
 * a passive observer is entitled to (ADR-0001 decision 7).
 */
import type { Plane } from '@agora/schemas';

import { worldOf } from '../kcs/facts.ts';
import type { Observation } from '../kcs/log.ts';
import { summariseSpan } from '../kcs/spans.ts';

/**
 * A feed row's plane. `control` is not a KCB `Plane` (§2.1 types ports by the three data
 * planes) — it is where an emitted exchange record belongs, and naming it keeps the filter
 * honest about which rows are telemetry.
 */
export type FeedPlane = Plane | 'control';

export interface FabricEvent {
  /** Stable within a log: the entry's seq, its kind, and its position within that entry. */
  id: string;
  /** The observation that carried it — the timeline row this event can be traced back to. */
  seq: number;
  /** Transaction time: when the console *saw* it (KCS §4.2), not when the peer minted it. */
  at: string;
  /** The peer whose stream delivered it. */
  participant: string;
  plane: FeedPlane;
  kind: 'claim' | 'asset' | 'span';
  world?: string | undefined;
  /** Every KINP id the event links to (KINP §5) — what makes a row navigable. */
  ids: string[];
  summary: string;
  /** True when it came from a stand-in fixture rather than a live producer (KCS delta N). */
  standin: boolean;
}

/** Project a log into the feed, in the order the console observed it. */
export function eventsFrom(entries: readonly Observation[]): FabricEvent[] {
  const events: FabricEvent[] = [];
  for (const entry of entries) {
    if (entry.direction !== 'frame') continue;
    const standin = entry.detail.standin === true;
    let index = 0;
    const push = (event: Omit<FabricEvent, 'id' | 'seq' | 'at' | 'participant' | 'standin'>): void => {
      events.push({
        ...event,
        id: `${entry.seq}:${event.kind}:${index++}`,
        seq: entry.seq,
        at: entry.at,
        participant: entry.participant,
        standin,
      });
    };
    for (const claim of entry.facts?.claims ?? []) {
      push({
        plane: 'knowledge',
        kind: 'claim',
        // A claim that stated no world is still scoped by the grammar of its subject's id
        // (KINP §5) — reading that is not a guess, it is where the id says it lives.
        world: claim.world ?? worldOf(claim.subject),
        ids: [claim.id, claim.subject, claim.object, claim.world].filter(isId),
        summary: `${claim.subject} ${claim.relation}${
          claim.object === undefined ? '' : ` ${claim.object}`
        }`,
      });
    }
    for (const asset of entry.facts?.assets ?? []) {
      push({
        plane: 'media',
        kind: 'asset',
        // `null` is the envelope's positive "depicts no world" (KMI delta H) and must not
        // become a world; `undefined` is an envelope that said nothing.
        world: typeof asset.source_world === 'string' ? asset.source_world : undefined,
        ids: [asset.id, ...asset.attaches_to, ...asset.constituents].filter(isId),
        summary: `${asset.id}${asset.media_type === undefined ? '' : ` · ${asset.media_type}`}${
          asset.present ? '' : ' · referenced, bytes not yet propagated'
        }`,
      });
    }
    if (entry.span !== undefined) {
      const span = entry.span;
      push({
        plane: 'control',
        kind: 'span',
        world: span.world,
        ids: [span.provider, span.caller, span.world, ...span.entities].filter(isId),
        summary: summariseSpan(span),
      });
    }
  }
  return events;
}

/** Every axis the feed can be narrowed on. An absent clause does not narrow. */
export interface FeedFilter {
  world?: string | undefined;
  plane?: FeedPlane | undefined;
  participant?: string | undefined;
  /** ISO-8601, inclusive — compared against the transaction time the log stamped. */
  since?: string | undefined;
  until?: string | undefined;
}

/** The rows a filter admits. Every stated clause must hold. */
export function filterFeed(
  events: readonly FabricEvent[],
  filter: FeedFilter = {},
): FabricEvent[] {
  return events.filter((event) => {
    if (filter.world !== undefined && event.world !== filter.world) return false;
    if (filter.plane !== undefined && event.plane !== filter.plane) return false;
    if (filter.participant !== undefined && event.participant !== filter.participant) return false;
    if (filter.since !== undefined && event.at < filter.since) return false;
    if (filter.until !== undefined && event.at > filter.until) return false;
    return true;
  });
}

/** The values actually present in a feed — what the UI offers to filter by. */
export interface FeedFacets {
  worlds: string[];
  planes: FeedPlane[];
  participants: string[];
}

export function feedFacets(events: readonly FabricEvent[]): FeedFacets {
  const worlds = new Set<string>();
  const planes = new Set<FeedPlane>();
  const participants = new Set<string>();
  for (const event of events) {
    if (event.world !== undefined) worlds.add(event.world);
    planes.add(event.plane);
    participants.add(event.participant);
  }
  return { worlds: [...worlds], planes: [...planes], participants: [...participants] };
}

function isId(value: string | undefined): value is string {
  return value !== undefined;
}
