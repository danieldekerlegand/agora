/**
 * Uptime is a duration, so it has to be counted — and the counting is all this module does.
 *
 * The passes below run through the real `monitorConnections` over a real `topologyOf` graph
 * (the manifests are sample data authored here — the `.example` hostnames say so), with a
 * probe that answers whatever the test needs and a clock the test moves. That is what makes
 * the claims assertable: an `up` connection accrues uptime across passes, a status change
 * resets the clock, and a connection nobody watched accrues nothing at all.
 */
import { describe, expect, it } from 'vitest';

import { monitorConnections, unwatchedConnections, type Observation } from './connection.ts';
import { connectionKey, trackConnections, uptimeOf, type ConnectionRecord } from './history.ts';
import { topologyOf, type Topology, type TopologyEdge, type TopologyNode } from './topology.ts';

const CALLER: TopologyNode = {
  identity: 'sample:agent:caller',
  address: { identity: 'sample:agent:caller', endpoints: { a2a: 'https://caller.example/card' } },
  reachable: true,
  discovered: true,
};

const PEER: TopologyNode = {
  identity: 'sample:agent:peer',
  address: { identity: 'sample:agent:peer', endpoints: { mcp: 'https://peer.example/mcp' } },
  reachable: true,
  discovered: true,
};

const OTHER: TopologyNode = {
  identity: 'sample:agent:other',
  address: { identity: 'sample:agent:other', endpoints: { mcp: 'https://other.example/mcp' } },
  reachable: true,
  discovered: true,
};

/** The graph the log is kept over: one link out to each peer named. */
function fabric(...peers: TopologyNode[]): Topology {
  return topologyOf({
    nodes: [CALLER, ...peers],
    observed: {
      connections: peers.map((peer) => ({ from: CALLER.identity, to: peer.identity })),
    },
  });
}

/** One monitoring pass, taken at `at`, with every connection answering the same way. */
async function pass(
  previous: ConnectionRecord[] | null,
  topology: Topology,
  at: number,
  answer: Omit<Observation, 'at'>,
): Promise<ConnectionRecord[]> {
  const monitored = await monitorConnections(topology, { probe: () => ({ ...answer, at }) });
  return trackConnections(previous, monitored);
}

/** The one record on a single-link graph. */
function only(records: readonly ConnectionRecord[]): ConnectionRecord {
  expect(records).toHaveLength(1);
  const [record] = records;
  if (!record) throw new Error('the pass recorded no connection');
  return record;
}

describe('a connection that keeps working accumulates uptime', () => {
  it('counts from the first reading that saw the status, across every pass since', async () => {
    const graph = fabric(PEER);
    const first = await pass(null, graph, 1_000, { answered: true, status: 200 });
    expect(only(first).health.status).toBe('up');
    expect(only(first).since).toBe(1_000);
    expect(uptimeOf(only(first))).toBe(0);

    const later = await pass(first, graph, 61_000, { answered: true, status: 200 });
    // Same status, so the clock is the one that started a minute ago — not this reading's.
    expect(only(later).since).toBe(1_000);
    expect(uptimeOf(only(later))).toBe(60_000);
    expect(only(later).errors).toEqual([]);
  });

  it('starts a new clock the moment the status changes, in either direction', async () => {
    const graph = fabric(PEER);
    const up = await pass(null, graph, 1_000, { answered: true, status: 200 });
    const down = await pass(up, graph, 31_000, { answered: false, reason: 'connection refused' });

    expect(only(down).health.status).toBe('down');
    expect(only(down).since).toBe(31_000);
    expect(only(down).heldMs).toBe(0);
    expect(uptimeOf(only(down))).toBeUndefined();

    const recovered = await pass(down, graph, 41_000, { answered: true, status: 200 });
    expect(only(recovered).since).toBe(41_000);
    expect(uptimeOf(only(recovered))).toBe(0);
  });
});

describe('a connection remembers what it said when it broke', () => {
  it('keeps the far end’s own words, newest first', async () => {
    const graph = fabric(PEER);
    const refused = await pass(null, graph, 1_000, {
      answered: true,
      status: 503,
      reason: 'upstream is busy',
    });
    const silent = await pass(refused, graph, 2_000, {
      answered: false,
      reason: 'connection refused',
    });

    expect(only(silent).errors.map((error) => error.detail)).toEqual([
      'connection refused',
      'upstream is busy',
    ]);
    expect(only(silent).errors[0]?.status).toBe('down');
    expect(only(silent).errors[1]?.status).toBe('degraded');
  });

  it('collapses a repeated failure into one row with a count, not a log file', async () => {
    const graph = fabric(PEER);
    let records = await pass(null, graph, 1_000, { answered: false, reason: 'timed out' });
    for (const at of [2_000, 3_000, 4_000]) {
      records = await pass(records, graph, at, { answered: false, reason: 'timed out' });
    }

    expect(only(records).errors).toHaveLength(1);
    expect(only(records).errors[0]).toMatchObject({ detail: 'timed out', count: 4, at: 4_000 });
    // Still down all along: one outage, timed from the first reading that saw it.
    expect(only(records).heldMs).toBe(3_000);
  });

  it('keeps only the most recent failures, and keeps them through a recovery', async () => {
    const graph = fabric(PEER);
    let records: ConnectionRecord[] | null = null;
    for (let nth = 1; nth <= 4; nth += 1) {
      records = await pass(records, graph, nth * 1_000, {
        answered: false,
        reason: `failure ${nth}`,
      });
    }
    records = trackConnections(
      records,
      await monitorConnections(graph, {
        probe: () => ({ answered: true, status: 200, at: 9_000 }),
      }),
      { keep: 2 },
    );

    // A recovery does not erase what it recovered from — that is the most useful minute of
    // the panel's life. The bound applies as failures arrive; recovery adds none.
    expect(only(records).health.status).toBe('up');
    expect(only(records).errors.map((error) => error.detail)).toEqual([
      'failure 4',
      'failure 3',
      'failure 2',
      'failure 1',
    ]);
  });
});

describe('the log claims nothing it did not observe', () => {
  it('gives an unwatched connection no uptime and no failures', () => {
    const graph = fabric(PEER);
    const records = trackConnections(null, unwatchedConnections(graph), { now: () => 5_000 });

    expect(only(records).health.status).toBe('unknown');
    expect(only(records).heldMs).toBeUndefined();
    expect(uptimeOf(only(records))).toBeUndefined();
    expect(only(records).errors).toEqual([]);
  });

  it('drops the history of a connection that is no longer on the graph', async () => {
    const both = fabric(PEER, OTHER);
    const watched = await pass(null, both, 1_000, { answered: true, status: 200 });
    expect(watched).toHaveLength(2);

    const remaining = await pass(watched, fabric(PEER), 61_000, { answered: true, status: 200 });
    // Nothing to reap: the record is keyed off the pass that just landed.
    expect(remaining.map((record) => record.to)).toEqual([PEER.identity]);
    expect(uptimeOf(only(remaining))).toBe(60_000);
  });

  it('keys a connection the way the graph draws it, so the two are the same rows', () => {
    const [edge] = fabric(PEER).edges;
    if (!edge) throw new Error('the graph drew no connection');
    expect(connectionKey(edge)).toContain(PEER.identity);
    // Scope is not part of it: the same link re-typed by the index is the same link.
    const reScoped: TopologyEdge = { ...edge, scope: 'external' };
    expect(connectionKey(edge)).toBe(connectionKey(reScoped));
  });
});
