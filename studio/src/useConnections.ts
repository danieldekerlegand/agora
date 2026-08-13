/**
 * Keeping the drawn health equal to the last reading — the monitoring seam.
 *
 * The sibling of `useTopology`, and it runs on the same rule: a pass is what the host asked
 * for, never something this area started on its own. It has no timer, opens no transport, and
 * holds no connection — it runs `monitorConnections` over the graph it was handed and folds
 * the answer into the running log (`trackConnections`), which is what turns a sequence of
 * moments into uptime and a list of recent failures.
 *
 * The log is the one thing here that *is* remembered between passes, and only because uptime
 * cannot be observed any other way — it is a duration, so somebody has to have been counting.
 * It is still not a roster: a connection that is not on the newest pass has no record, so the
 * memory dies with the link rather than outliving it.
 *
 * Three things start a pass, none of them a page reload: a new graph (discovery answered
 * again), new monitor options (a different probe, or the host's own tick), or `refresh()`.
 * Identity decides, not deep equality — the host says when its picture moved, exactly as it
 * does for the discovery query.
 */
import { useCallback, useEffect, useState } from 'react';

import { monitorConnections, type MonitorOptions } from './connection.ts';
import { trackConnections, type ConnectionRecord, type TrackOptions } from './history.ts';
import type { Topology } from './topology.ts';

/** Nothing has been watched yet, or there is nothing to watch. Shared: it is never mutated. */
const NONE: readonly ConnectionRecord[] = Object.freeze([]);

/** What the last monitoring pass produced, and how to ask for another. */
export interface ConnectionsReading {
  /** Every connection on the graph, with its health, its uptime and its recent failures. */
  connections: readonly ConnectionRecord[];
  /** A pass is in flight. The previous readings stay on screen while it runs. */
  pending: boolean;
  /** Why the last pass could not be taken at all. Not the same as a connection being down. */
  problem?: string;
  /** Watch again — for a host that ticks on its own schedule. */
  refresh(): void;
}

/** What a pass produced, before `refresh` is attached to it. */
type Reading = Omit<ConnectionsReading, 'refresh'>;

/** How the graph's connections are watched, and how the readings are folded into a log. */
export type ConnectionsOptions = MonitorOptions & TrackOptions;

/**
 * Watch the connections of a graph, and keep watching as it changes.
 *
 * Pass `null` (or a host with no graph yet) and the reading stays empty without a pass ever
 * running. Pass options with no probe and every connection reads `unknown` — an honest report
 * from a host that watches nothing, which is what a monitor owes over a fabricated green.
 *
 * A pass that throws leaves the previous readings up and reports the problem beside them: a
 * monitor that could not run is not a fabric that went down, and saying otherwise would put
 * every connection in the user's setup into an outage that never happened.
 */
export function useConnections(
  topology?: Topology | null,
  options?: ConnectionsOptions | null,
): ConnectionsReading {
  const [reading, setReading] = useState<Reading>(() => ({
    connections: NONE,
    pending: Boolean(topology),
  }));
  const [asked, setAsked] = useState(0);
  const refresh = useCallback(() => setAsked((count) => count + 1), []);

  useEffect(() => {
    if (!topology) {
      setReading({ connections: NONE, pending: false });
      return undefined;
    }

    // A reading that lands after the graph moved on describes connections nobody asked about.
    let live = true;
    const watch = options ?? {};
    setReading((previous) => ({ connections: previous.connections, pending: true }));
    void monitorConnections(topology, watch).then(
      (monitored) => {
        if (!live) return;
        setReading((previous) => ({
          connections: trackConnections(previous.connections, monitored, watch),
          pending: false,
        }));
      },
      (error: unknown) => {
        if (!live) return;
        setReading((previous) => ({
          connections: previous.connections,
          pending: false,
          problem: problemOf(error),
        }));
      },
    );
    return () => {
      live = false;
    };
  }, [topology, options, asked]);

  return { ...reading, refresh };
}

/** What to show a human for a pass that could not be taken, whatever the monitor threw. */
function problemOf(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `connections could not be watched: ${detail}`;
}
