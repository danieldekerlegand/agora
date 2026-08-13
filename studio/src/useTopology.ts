/**
 * Keeping the drawn graph equal to the current answer — the churn seam.
 *
 * A topology is not state Studio accumulates; it is the value one pass over the lookup
 * surfaces returned (`discoverTopology`). So this hook remembers nothing between passes: it
 * runs a pass, renders the answer, and runs another when there is reason to. A participant
 * that has left the index is absent from the next answer and therefore absent from the next
 * render — there is no roster it could linger in, which is the entire reason the graph
 * survives churn without anybody writing removal logic.
 *
 * Two things start a pass, and neither is a page reload:
 *
 * 1. **A new query object.** A host that discovers on its own schedule hands in the next
 *    snapshot — a different registry client, a narrowed {@link TopologyQuery} — and the pass
 *    follows the value. Identity, not deep equality: the host says when its picture moved.
 * 2. **`refresh()`.** For the other shape, where the same index mutates in place and the host
 *    learns about it some other way (a KCB announcement it subscribed to, a timer it owns).
 *
 * Studio still opens no transport of its own — `discovery` is an argument, the way every other
 * seam in this area takes its input, so both surfaces belong to the host.
 */
import { useCallback, useEffect, useState } from 'react';

import { discoverTopology, type Topology, type TopologyQuery } from './topology.ts';

/** No pass has answered yet, or the host has nothing to ask. Shared: it is never mutated. */
const NOTHING: Topology = Object.freeze({ nodes: [], edges: [] });

/** What the last pass over discovery produced, and how to ask for another. */
export interface TopologyReading {
  /** The graph as of the last answer. Empty until one arrives, and empty is a real answer. */
  topology: Topology;
  /** A pass is in flight. The previous picture stays on screen while it runs. */
  pending: boolean;
  /** Why the last pass could not answer. The lookup failed; it is not reported as an empty fabric. */
  problem?: string;
  /** Ask again — for a host whose index moves under an unchanged query. */
  refresh(): void;
}

/** What a pass produced, before `refresh` is attached to it. */
type Reading = Omit<TopologyReading, 'refresh'>;

/**
 * Draw whatever the lookups say now, and re-draw when they say something else.
 *
 * Pass `null` (a host with no discovery surface — the standalone bundle, which has none) and
 * the reading stays empty without a pass ever running.
 *
 * A pass that fails leaves the last good picture up and reports the problem beside it, because
 * a registry that could not be reached is not a fabric that emptied — blanking the graph would
 * assert a churn event that never happened. A pass that *succeeds* with nobody in it does
 * empty the graph: that answer is the fabric emptying.
 */
export function useTopology(query?: TopologyQuery | null): TopologyReading {
  const [reading, setReading] = useState<Reading>(() => ({
    topology: NOTHING,
    pending: Boolean(query),
  }));
  const [asked, setAsked] = useState(0);
  const refresh = useCallback(() => setAsked((count) => count + 1), []);

  useEffect(() => {
    if (!query) {
      setReading({ topology: NOTHING, pending: false });
      return undefined;
    }

    // An answer that arrives after the query moved on describes a fabric nobody asked about.
    let live = true;
    setReading((previous) => ({ topology: previous.topology, pending: true }));
    void discoverTopology(query).then(
      (topology) => {
        if (live) setReading({ topology, pending: false });
      },
      (error: unknown) => {
        if (live) {
          setReading((previous) => ({
            topology: previous.topology,
            pending: false,
            problem: problemOf(error),
          }));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [query, asked]);

  return { ...reading, refresh };
}

/** What to show a human for a failed lookup, whatever the surface threw. */
function problemOf(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `discovery could not be read: ${detail}`;
}
