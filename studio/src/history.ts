/**
 * The connection log — how long each connection has held its status, and what it said when it
 * stopped working.
 *
 * A reading from `connection.ts` is a single moment: this connection answered, or it did not,
 * just now. What a person watching a fabric actually needs is the two things a moment cannot
 * carry — *how long* it has been that way, and *what the last failures said* — so this module
 * folds a sequence of passes into exactly those, and nothing else.
 *
 * It is a pure fold, deliberately: `trackConnections(previous, monitored)` is a function of
 * the last records and the newest pass, with the clock injected. No timer lives here, nothing
 * subscribes, and there is no background loop to leak — the host decides when a pass happens
 * (`useConnections`), the same way it owns the probe and the discovery surface.
 *
 * Two rules keep the log honest, and they are the whole file:
 *
 * 1. **Uptime is measured, never assumed.** A connection's clock starts at the first reading
 *    that saw its current status and resets the moment that status changes. A status nobody
 *    observed (`unknown`) accrues no uptime at all — a monitor that counted unwatched minutes
 *    as green would be inventing the very fact it exists to report.
 * 2. **A connection that leaves the graph takes its history with it.** Records are keyed off
 *    the edges of the pass that just landed, so a link that is no longer on the fabric has no
 *    row, exactly as `discoverTopology` keeps no departed node. There is nothing to reap.
 */
import type { MonitoredEdge, MonitoredTopology } from './connection.ts';
import type { TopologyEdge } from './topology.ts';

/** What one failure said, and how many readings in a row have said it. */
export interface ConnectionError {
  /** The far end's own words, or what stopped the dial. Never Studio's paraphrase. */
  detail: string;
  /** The status the reading carried: it answered unhappily, or it did not answer. */
  status: 'degraded' | 'down';
  /** When it was last seen (epoch ms), on the clock the reading was taken against. */
  at?: number;
  /** How many consecutive readings said this same thing — one row, not a hundred. */
  count: number;
}

/** One connection, its latest reading, how long that reading has held, and its recent failures. */
export interface ConnectionRecord extends MonitoredEdge {
  /** Identifies this connection across passes — the same key the graph draws rows by. */
  key: string;
  /** When the current status was first observed (epoch ms). */
  since: number;
  /** How long the current status has held, in ms. Uptime while the status is `up`. */
  heldMs?: number;
  /** The most recent failures, newest first. Bounded, and empty when there were none. */
  errors: readonly ConnectionError[];
}

/** How a pass is folded into the log. */
export interface TrackOptions {
  /** The clock, for readings that carried no timestamp. Injected so a gate can pin it. */
  now?: () => number;
  /** How many recent failures to keep per connection. Older ones fall off the end. */
  keep?: number;
}

/** How many failures a connection remembers. Enough to see a pattern, not a log file. */
const RECENT = 5;

/** What a failure is called when the reading carried no words of the far end's own. */
const SILENT_FAILURE = 'no answer';
const UNSTATED_FAILURE = 'answered with an error';

/**
 * What identifies a connection across passes — two ends, plus whatever distinguishes parallel
 * links between them. The same key `edgesOf` dedupes on, so the log's rows and the graph's are
 * the same rows.
 */
export function connectionKey(
  edge: Pick<TopologyEdge, 'from' | 'to' | 'transport' | 'capability'>,
): string {
  return `${edge.from}→${edge.to}:${edge.transport ?? ''}:${edge.capability ?? ''}`;
}

/**
 * Fold the newest monitoring pass into the running log.
 *
 * Every connection on the new pass gets a record; connections that were on the previous one
 * carry their clock and their failures forward. A status that is unchanged keeps its `since`,
 * so uptime accumulates across passes; a status that moved starts a new clock, because that is
 * precisely the moment being timed.
 */
export function trackConnections(
  previous: readonly ConnectionRecord[] | null | undefined,
  monitored: MonitoredTopology,
  options: TrackOptions = {},
): ConnectionRecord[] {
  const now = options.now ?? (() => Date.now());
  const keep = options.keep ?? RECENT;
  const before = new Map((previous ?? []).map((record) => [record.key, record]));

  return monitored.edges.map((edge) => {
    const key = connectionKey(edge);
    const prior = before.get(key);
    const at = edge.health.at ?? now();
    const unchanged = prior !== undefined && prior.health.status === edge.health.status;
    const held = unchanged ? prior.since : at;

    const record: ConnectionRecord = {
      ...edge,
      key,
      since: held,
      errors: foldError(prior?.errors ?? [], edge, at, keep),
    };
    // An unobserved connection has nothing to time: no reading ever placed it in this state.
    if (edge.health.status !== 'unknown') record.heldMs = Math.max(0, at - held);
    return record;
  });
}

/** A connection's uptime — how long it has been up, and `undefined` when it is not up. */
export function uptimeOf(record: ConnectionRecord): number | undefined {
  return record.health.status === 'up' ? record.heldMs : undefined;
}

/**
 * The failures a connection remembers after this reading.
 *
 * A healthy or unobserved reading adds nothing and erases nothing: what a connection said when
 * it last broke is the most useful thing on the panel for the minute after it recovers. A
 * repeat of the failure already at the head collapses into it — a peer that has been refusing
 * for an hour is one fact with a count, not sixty identical rows.
 */
function foldError(
  previous: readonly ConnectionError[],
  edge: MonitoredEdge,
  at: number,
  keep: number,
): readonly ConnectionError[] {
  const status = edge.health.status;
  if (status !== 'degraded' && status !== 'down') return previous;

  const detail =
    edge.health.detail ?? (status === 'down' ? SILENT_FAILURE : UNSTATED_FAILURE);
  const [head, ...rest] = previous;
  if (head && head.status === status && head.detail === detail) {
    return [{ ...head, at, count: head.count + 1 }, ...rest];
  }
  return [{ detail, status, at, count: 1 }, ...previous].slice(0, keep);
}
