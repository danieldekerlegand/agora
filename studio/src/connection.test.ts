/**
 * A connection's health is what the far end answered, and nothing else.
 *
 * The topology under test is built by the real `topologyOf`/`edgesOf` from sample manifests
 * authored here (the `.example` hostnames say so) — no participant in this file is known to
 * `studio/src`. The probe is driven against a fake fetch rather than a network, which is what
 * makes the two claims assertable: that the URL dialed is the *far end's own published
 * address* (Studio relays nothing, ADR-0001 decisions 3 and 7), and that an unprobed link is
 * reported as unknown rather than assumed healthy.
 */
import { describe, expect, it } from 'vitest';

import {
  directLink,
  healthOf,
  httpProbe,
  monitorConnections,
  statusOf,
  type DirectLink,
  type Observation,
  type ProbeFetch,
  type ProbeRequestInit,
  type ProbeResponse,
} from './connection.ts';
import { topologyOf, type Topology, type TopologyNode } from './topology.ts';

/** A peer that serves MCP — dialed with an `initialize`, the way the console's wire opens one. */
const SERVER: TopologyNode = {
  identity: 'sample:agent:server',
  address: { identity: 'sample:agent:server', endpoints: { mcp: 'https://server.example/mcp' } },
  reachable: true,
  discovered: true,
};

/** A peer that serves A2A — dialed with a GET of its Agent Card. */
const CARD: TopologyNode = {
  identity: 'sample:agent:card',
  address: {
    identity: 'sample:agent:card',
    endpoints: { a2a: 'https://card.example/.well-known/agent-card.json' },
  },
  reachable: true,
  discovered: true,
};

/** Indexed, but published no endpoint: there is nowhere to dial, and that is not a failure. */
const SILENT: TopologyNode = {
  identity: 'sample:agent:silent',
  address: { identity: 'sample:agent:silent', endpoints: {} },
  reachable: false,
  discovered: true,
};

/** The graph the monitor reads: one caller with a link out to each of the three. */
function fabric(): Topology {
  return topologyOf({
    nodes: [SERVER, CARD, SILENT],
    observed: {
      connections: [
        { from: SERVER.identity, to: CARD.identity, transport: 'a2a' },
        { from: CARD.identity, to: SERVER.identity, transport: 'mcp' },
        { from: SERVER.identity, to: SILENT.identity },
      ],
    },
  });
}

/** A fetch that answers from a table and records every URL it was asked for. */
function fetching(
  answers: Record<string, ProbeResponse | Error>,
): ProbeFetch & { dialed: { url: string; init?: ProbeRequestInit }[] } {
  const dialed: { url: string; init?: ProbeRequestInit }[] = [];
  const probe = async (url: string, init?: ProbeRequestInit): Promise<ProbeResponse> => {
    dialed.push(init === undefined ? { url } : { url, init });
    const answer = answers[url];
    if (answer === undefined) throw new Error(`nothing is listening at ${url}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return Object.assign(probe, { dialed });
}

/** A happy answer, with an optional body the reader can parse. */
function answers(status: number, body?: unknown): ProbeResponse {
  const response: ProbeResponse = { ok: status >= 200 && status < 300, status };
  if (body === undefined) return response;
  return { ...response, text: () => Promise.resolve(JSON.stringify(body)) };
}

/** A clock that ticks a fixed amount per read, so latency is a fact and not a flake. */
function clock(start: number, step: number): () => number {
  let at = start - step;
  return () => (at += step);
}

const healthByEdge = (edges: { to: string; health: { status: string } }[]) =>
  Object.fromEntries(edges.map((edge) => [edge.to, edge.health.status]));

describe('a status is what came back', () => {
  it('reads a clean answer as up, a refusal as degraded, and silence as down', () => {
    expect(statusOf({ answered: true, status: 200 })).toBe('up');
    expect(statusOf({ answered: true, status: 503, reason: 'no backend' })).toBe('degraded');
    expect(statusOf({ answered: true, status: 401 })).toBe('degraded');
    expect(statusOf({ answered: false, reason: 'connection refused' })).toBe('down');
  });

  it('reads a protocol error at HTTP 200 as degraded, not as health', () => {
    // MCP refuses inside a JSON-RPC envelope with an ok status; a monitor that read only
    // the status code would report every MCP refusal as a healthy connection.
    expect(statusOf({ answered: true, status: 200, reason: 'method not found' })).toBe('degraded');
  });

  it('reads no observation as unknown, and says so rather than assuming health', () => {
    expect(statusOf()).toBe('unknown');
    expect(statusOf(null)).toBe('unknown');
    expect(healthOf()).toEqual({ status: 'unknown', detail: 'not probed' });
  });

  it('carries the far end’s own words and the round trip into the reading', () => {
    const observation: Observation = {
      answered: true,
      status: 429,
      reason: 'over ceiling',
      latencyMs: 12,
      at: 1_000,
    };
    expect(healthOf(observation)).toEqual({
      status: 'degraded',
      detail: 'over ceiling',
      latencyMs: 12,
      at: 1_000,
    });
  });
});

describe('where a connection is dialed is the far end’s own address', () => {
  it('uses the address the far end published for the transport the pair speak', () => {
    const topology = fabric();
    const toCard = topology.edges.find((edge) => edge.to === CARD.identity);
    const toServer = topology.edges.find((edge) => edge.to === SERVER.identity);

    expect(directLink(toCard!, topology.nodes)).toEqual<DirectLink>({
      identity: CARD.identity,
      endpoint: CARD.address.endpoints.a2a as string,
      transport: 'a2a',
    });
    expect(directLink(toServer!, topology.nodes)).toEqual<DirectLink>({
      identity: SERVER.identity,
      endpoint: SERVER.address.endpoints.mcp as string,
      transport: 'mcp',
    });
  });

  it('has nowhere to dial a peer that published nothing', () => {
    const topology = fabric();
    const toSilent = topology.edges.find((edge) => edge.to === SILENT.identity);
    expect(directLink(toSilent!, topology.nodes)).toBeUndefined();
  });

  it('follows an address the resolver folded in when the first one serves no transport', () => {
    const merged: TopologyNode = {
      ...SILENT,
      alsoAt: [{ identity: 'sample:agent:silent-b', endpoints: { mcp: 'https://b.example/mcp' } }],
    };
    const edge = { from: SERVER.identity, to: merged.identity, scope: 'internal' as const };
    expect(directLink(edge, [merged])).toEqual<DirectLink>({
      identity: merged.identity,
      endpoint: 'https://b.example/mcp',
      transport: 'mcp',
    });
  });
});

describe('monitoring a graph of reachable and unreachable connections', () => {
  it('reports each connection as its own dial found it', async () => {
    const fetch = fetching({
      [CARD.address.endpoints.a2a as string]: answers(200, { name: 'card' }),
      [SERVER.address.endpoints.mcp as string]: new Error('ECONNREFUSED'),
    });
    const monitored = await monitorConnections(fabric(), { probe: httpProbe(fetch) });

    expect(healthByEdge(monitored.edges)).toEqual({
      [CARD.identity]: 'up',
      [SERVER.identity]: 'down',
      // Indexed, but nowhere to dial: unobserved, and reported as such.
      [SILENT.identity]: 'unknown',
    });

    const down = monitored.edges.find((edge) => edge.to === SERVER.identity);
    expect(down?.health.detail).toBe('ECONNREFUSED');
    const unknown = monitored.edges.find((edge) => edge.to === SILENT.identity);
    expect(unknown?.health.detail).toBe('the far end publishes no address to dial');
  });

  it('times the round trip it made, on the host’s clock', async () => {
    // One dial, so the reading is exactly one tick of the injected clock — probes run
    // concurrently, and a shared clock read across them would be timing the pass, not the link.
    const fetch = fetching({ [CARD.address.endpoints.a2a as string]: answers(200) });
    const probe = httpProbe(fetch, { now: clock(1_000, 5) });
    const observation = await probe(
      { identity: CARD.identity, endpoint: CARD.address.endpoints.a2a as string, transport: 'a2a' },
      { from: SERVER.identity, to: CARD.identity, scope: 'internal' },
    );

    expect(observation).toEqual({ answered: true, status: 200, latencyMs: 5, at: 1_000 });
    expect(healthOf(observation)).toEqual({ status: 'up', latencyMs: 5, at: 1_000 });
  });

  it('reports a peer that answered unhappily as degraded, in the peer’s own words', async () => {
    const fetch = fetching({
      [CARD.address.endpoints.a2a as string]: answers(503, { detail: 'draining' }),
      [SERVER.address.endpoints.mcp as string]: answers(200, {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'initialize is not served here' },
      }),
    });
    const monitored = await monitorConnections(fabric(), { probe: httpProbe(fetch) });

    expect(healthByEdge(monitored.edges)).toEqual({
      [CARD.identity]: 'degraded',
      [SERVER.identity]: 'degraded',
      [SILENT.identity]: 'unknown',
    });
    expect(monitored.edges.find((edge) => edge.to === CARD.identity)?.health.detail).toBe(
      'draining',
    );
    expect(monitored.edges.find((edge) => edge.to === SERVER.identity)?.health.detail).toBe(
      'initialize is not served here',
    );
  });

  it('leaves every connection unknown when the host supplies no probe', async () => {
    const monitored = await monitorConnections(fabric());
    expect(monitored.edges).toHaveLength(3);
    for (const edge of monitored.edges) {
      expect(edge.health).toEqual({ status: 'unknown', detail: 'not probed' });
    }
  });

  it('is an empty reading for an empty graph, not a failure', async () => {
    expect(await monitorConnections({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
  });

  it('lets one unreachable peer fail alone', async () => {
    const exploding = () => {
      throw new Error('the probe itself blew up');
    };
    const monitored = await monitorConnections(fabric(), { probe: exploding });
    expect(healthByEdge(monitored.edges)).toEqual({
      [CARD.identity]: 'down',
      [SERVER.identity]: 'down',
      [SILENT.identity]: 'unknown',
    });
  });
});

describe('a monitor observes; it never relays', () => {
  it('dials only the addresses the participants themselves published', async () => {
    const fetch = fetching({
      [CARD.address.endpoints.a2a as string]: answers(200),
      [SERVER.address.endpoints.mcp as string]: answers(200),
    });
    await monitorConnections(fabric(), { probe: httpProbe(fetch) });

    const published = [CARD.address.endpoints.a2a, SERVER.address.endpoints.mcp];
    expect(fetch.dialed.map((call) => call.url).sort()).toEqual([...published].sort());
  });

  it('opens each transport the way the console’s wires open it, carrying no one’s payload', async () => {
    const fetch = fetching({
      [CARD.address.endpoints.a2a as string]: answers(200),
      [SERVER.address.endpoints.mcp as string]: answers(200),
    });
    await monitorConnections(fabric(), { probe: httpProbe(fetch) });

    const card = fetch.dialed.find((call) => call.url === CARD.address.endpoints.a2a);
    expect(card?.init?.method).toBe('GET');
    expect(card?.init?.body).toBeUndefined();

    const server = fetch.dialed.find((call) => call.url === SERVER.address.endpoints.mcp);
    expect(server?.init?.method).toBe('POST');
    const body = JSON.parse(server?.init?.body ?? '{}') as {
      method: string;
      params: { clientInfo: { name: string } };
    };
    // A handshake this prober is a party to — never a capability, never anyone else's bytes.
    expect(body.method).toBe('initialize');
    expect(body.params.clientInfo.name).toBe('agora-studio');
  });

  it('attaches health without putting anything callable on the graph', async () => {
    const fetch = fetching({ [CARD.address.endpoints.a2a as string]: answers(200) });
    const monitored = await monitorConnections(fabric(), { probe: httpProbe(fetch) });

    expect(monitored.edges.length).toBeGreaterThan(0);
    for (const edge of monitored.edges) {
      expect(Object.values(edge).some((value) => typeof value === 'function')).toBe(false);
      expect(Object.values(edge.health).some((value) => typeof value === 'function')).toBe(false);
    }
  });
});
