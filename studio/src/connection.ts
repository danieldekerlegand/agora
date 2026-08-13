/**
 * Per-connection monitoring — is this link up, and when it is not, what did the far end say.
 *
 * The graph (`topology.ts`) says which MCP/A2A connections exist. This module says how each
 * one is *doing*, and it learns that the only way an observer is entitled to: by dialing the
 * far end at the address the far end itself published, directly, exactly as a peer on that
 * link would. Nothing is relayed. Studio never sits between two participants, never carries a
 * byte from one to the other, and has no verb here that could — a probe's request goes to one
 * address and its answer comes back to the prober, which is a *second* direct connection
 * beside the one being reported on, not a tap on it (ADR-0001 decisions 3 and 7).
 *
 * Three things follow, and they are the whole file:
 *
 * 1. **The dial is an argument.** {@link httpProbe} is handed the fetch, the way `topology.ts`
 *    is handed the discovery surface and `config.ts` is handed text. This area still opens no
 *    transport of its own; the host owns every socket, and a host that supplies no probe gets
 *    a graph whose connections are honestly reported as unobserved.
 * 2. **The opening leg is the protocol's, not a lookalike.** What "dial it" means per
 *    transport is the console's, by reference: `console/src/kcs/a2a-wire.ts` opens A2A with a
 *    GET of the peer's Agent Card, and `console/src/kcs/mcp-wire.ts` opens MCP with a JSON-RPC
 *    `initialize` carrying the official SDK's pinned {@link LATEST_PROTOCOL_VERSION}. Those
 *    first legs are what a probe replays — the same request production makes, so a green
 *    reading means the link production uses actually works. {@link ProbeFetch} is likewise the
 *    console's `HttpFetch` seam (`console/src/kcs/http.ts`) narrowed to what a probe needs:
 *    structural, so the platform `fetch` satisfies it and a test satisfies it in ten lines.
 *    It is restated rather than imported for the reason `topology.ts` restates `Discovery` —
 *    the console is a private leaf app, not a library, and the shape is the contract.
 * 3. **Unobserved is a status, not a default.** A connection nobody probed reads `unknown`,
 *    never `up`. A monitor that reported silence as health would be the one thing worse than
 *    no monitor: the empty stage is honest, and so is an unprobed edge.
 */
import { endpointFor, transportOf, type ProviderAddress } from '@agora/sdk';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import type { Topology, TopologyEdge, TopologyNode } from './topology.ts';

/**
 * How one connection is doing.
 *
 * `up` — the far end answered its own opening leg cleanly. `degraded` — it answered, but with
 * a refusal, an error status or a protocol-level error: the link carried a round trip, so it
 * is the service that is unwell rather than the connection. `down` — nothing came back at all.
 * `unknown` — nobody looked, or there was no address to look at.
 */
export type ConnectionStatus = 'up' | 'degraded' | 'down' | 'unknown';

/** What one direct dial of a peer's own published address returned. */
export interface Observation {
  /** True when the far end answered at all — the link carried a round trip. */
  answered: boolean;
  /** The status it answered with, when it answered one. */
  status?: number;
  /** Its own words: the refusal it gave, or the transport error that stopped the dial. */
  reason?: string;
  /** How long the round trip took, in milliseconds. */
  latencyMs?: number;
  /** When the dial started, on the host's clock (epoch ms). */
  at?: number;
}

/** A connection's health, as the last observation of it had it. */
export interface ConnectionHealth {
  status: ConnectionStatus;
  /** Why it reads that way — the far end's own words wherever there are any. */
  detail?: string;
  /** The round trip that produced this reading. */
  latencyMs?: number;
  /** When the reading was taken (epoch ms). */
  at?: number;
}

/** An edge, plus how the connection it describes is doing. */
export interface MonitoredEdge extends TopologyEdge {
  health: ConnectionHealth;
}

/** The graph with every connection's health attached. Same nodes, same edge order. */
export interface MonitoredTopology {
  nodes: TopologyNode[];
  edges: MonitoredEdge[];
}

/**
 * Where a peer dials for one connection — the far end's own URL, and what it is spoken over.
 *
 * Always the *far* end's published address, never a route through Studio and never anything
 * derived from the near end. The transport is the SDK's projection (`transportOf`), so the
 * naming is the one the whole tree shares.
 */
export interface DirectLink {
  /** The far end's identity, so an observation is attributable. */
  identity: string;
  /** The address it published for this transport. Verbatim; nothing is invented. */
  endpoint: string;
  /** How it is dialed — `mcp`, `a2a`, whatever the pair advertised. */
  transport?: string;
}

/**
 * The seam that observes one link: given where a peer would dial, say what came back.
 *
 * A probe that returns `undefined` observed nothing, which reads `unknown` — that is how a
 * host says "I do not watch this one" without having to lie about it.
 */
export type ConnectionProbe = (
  link: DirectLink,
  edge: TopologyEdge,
) => Promise<Observation | undefined> | Observation | undefined;

/** How the graph's connections are watched: with what, and against whose clock. */
export interface MonitorOptions {
  /** The probe to run per connection. Without one, every connection reads `unknown`. */
  probe?: ConnectionProbe | null;
}

/** What a monitor says when it had no reading, and why it had none. */
const UNPROBED = 'not probed';
const NO_ADDRESS = 'the far end publishes no address to dial';
const NO_READING = 'the probe returned no reading';

/**
 * The status one observation implies.
 *
 * The split that matters is *answered* versus *not*: a connection that carried a round trip is
 * a working connection however unhappy the answer, so a refusal or a 5xx is `degraded` and only
 * silence is `down`. A protocol-level error at HTTP 200 — a JSON-RPC `error` envelope, which is
 * how MCP refuses — counts as unhappy too, or every MCP refusal would read as health.
 */
export function statusOf(observation?: Observation | null): ConnectionStatus {
  if (!observation) return 'unknown';
  if (!observation.answered) return 'down';
  if (observation.reason !== undefined && observation.reason !== '') return 'degraded';
  const status = observation.status;
  if (status !== undefined && (status < 200 || status >= 400)) return 'degraded';
  return 'up';
}

/** One observation as a health reading — the status it implies, plus what it reported. */
export function healthOf(observation?: Observation | null): ConnectionHealth {
  if (!observation) return { status: 'unknown', detail: UNPROBED };

  const health: ConnectionHealth = { status: statusOf(observation) };
  const detail = detailOf(observation);
  if (detail !== undefined) health.detail = detail;
  if (observation.latencyMs !== undefined) health.latencyMs = observation.latencyMs;
  if (observation.at !== undefined) health.at = observation.at;
  return health;
}

/**
 * Where to dial for one connection, or nothing when there is nowhere.
 *
 * The edge's own transport wins when the far end published an address for it — that is the
 * link the two participants actually hold. Otherwise the SDK's preference order decides, and
 * every address the KINP resolver folded into this node is tried before giving up. Returning
 * `undefined` is the honest answer for a peer that is on the graph but published nothing: the
 * monitor reports `unknown` for it rather than inventing a URL to fail against.
 */
export function directLink(
  edge: TopologyEdge,
  nodes: readonly TopologyNode[],
): DirectLink | undefined {
  const node = nodes.find((candidate) => candidate.identity === edge.to);
  if (!node) return undefined;

  const addresses: readonly ProviderAddress[] = [node.address, ...(node.alsoAt ?? [])];
  const spoken = edge.transport;
  if (spoken !== undefined) {
    for (const address of addresses) {
      const named = address.endpoints[spoken];
      if (named) return { identity: node.identity, endpoint: named, transport: spoken };
    }
  }
  for (const address of addresses) {
    const endpoint = endpointFor(address);
    if (endpoint === undefined) continue;
    const transport = transportOf(address);
    return transport === undefined
      ? { identity: node.identity, endpoint }
      : { identity: node.identity, endpoint, transport };
  }
  return undefined;
}

/**
 * Attach a health reading to every connection on the graph.
 *
 * One pass, like `discoverTopology`: nothing is remembered between calls, so a connection that
 * left the graph leaves the reading with it and there is no stale row to reap. Probes run
 * concurrently — they are independent direct dials to different peers, and serialising them
 * would make a monitor's latency the sum of the fabric's.
 *
 * A probe that throws is an observation, not a crash: the dial failed, which is precisely what
 * `down` means, and the thrown reason is what the UI shows. One unreachable peer must never be
 * able to take the reading of every other connection with it.
 */
export async function monitorConnections(
  topology: Topology,
  options: MonitorOptions = {},
): Promise<MonitoredTopology> {
  const { probe } = options;
  const nodes = topology.nodes;

  if (!probe) return unwatchedConnections(topology);

  const edges = await Promise.all(
    topology.edges.map(async (edge): Promise<MonitoredEdge> => {
      const link = directLink(edge, nodes);
      if (!link) return { ...edge, health: { status: 'unknown', detail: NO_ADDRESS } };

      let observation: Observation | undefined;
      try {
        observation = await probe(link, edge);
      } catch (error) {
        observation = { answered: false, reason: reasonOf(error) };
      }
      if (!observation) return { ...edge, health: { status: 'unknown', detail: NO_READING } };
      return { ...edge, health: healthOf(observation) };
    }),
  );

  return { nodes: [...nodes], edges };
}

/**
 * The graph with nothing observed about it — every connection reported as unwatched.
 *
 * What a host with no probe sees, said synchronously so a view can draw it without a pass:
 * the connections are real (discovery and the host's own observation put them there), and what
 * is unknown about them is their health. Same rule as everywhere else in this file — nobody
 * looked, so nobody may claim they are up.
 */
export function unwatchedConnections(topology: Topology): MonitoredTopology {
  return {
    nodes: [...topology.nodes],
    edges: topology.edges.map((edge) => ({
      ...edge,
      health: { status: 'unknown' as const, detail: UNPROBED },
    })),
  };
}

/** The slice of a `fetch` answer a probe reads — the console's `HttpResponse`, narrowed. */
export interface ProbeResponse {
  ok: boolean;
  status: number;
  /** Optional: a peer that answered nothing readable still answered, which is the reading. */
  text?(): Promise<string>;
}

/** The slice of `fetch`'s init a probe sends — the console's `HttpRequestInit`, narrowed. */
export interface ProbeRequestInit {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** The console's `HttpFetch` seam (`console/src/kcs/http.ts`), stated structurally. */
export type ProbeFetch = (url: string, init?: ProbeRequestInit) => Promise<ProbeResponse>;

/** How {@link httpProbe} dials and times. Every knob is the host's, including the clock. */
export interface HttpProbeOptions {
  /** The clock latency and timestamps are read from. Injected so a gate can pin it. */
  now?: () => number;
  /** Abort in flight — a pass the host has moved on from should not keep a socket open. */
  signal?: AbortSignal;
}

/** How Studio names itself to a peer it is dialing. Capability, never caller. */
const CLIENT_INFO = { name: 'agora-studio', version: '0.0.0' } as const;

/** The Streamable-HTTP client MUST accept both answer content types (MCP transport spec). */
const MCP_ACCEPT = 'application/json, text/event-stream';

/**
 * The default probe: open each transport's own first leg against the far end, and time it.
 *
 * A2A opens with a GET of the peer's Agent Card and MCP with a JSON-RPC `initialize` — the
 * opening legs of `console/src/kcs/a2a-wire.ts` and `mcp-wire.ts`, so a probe asks exactly
 * what a real client asks and a peer that answers this answers production. Anything else
 * published is dialed with a plain GET of the address it published, which is the most a
 * monitor can honestly say about a transport it does not speak.
 *
 * No capability is invoked and no payload of anybody's is sent, here or anywhere else in this
 * file: the request bodies are a handshake this prober is a party to.
 */
export function httpProbe(fetch: ProbeFetch, options: HttpProbeOptions = {}): ConnectionProbe {
  const now = options.now ?? (() => Date.now());

  return async (link: DirectLink): Promise<Observation> => {
    const leg = openingLeg(link, options.signal);
    const at = now();
    let response: ProbeResponse;
    try {
      response = await fetch(leg.url, leg.init);
    } catch (error) {
      return { answered: false, reason: reasonOf(error), latencyMs: now() - at, at };
    }

    const latencyMs = now() - at;
    const reason = await refusalOf(response);
    const observation: Observation = { answered: true, status: response.status, latencyMs, at };
    return reason === undefined ? observation : { ...observation, reason };
  };
}

/** The first request the far end's transport expects, aimed at the address it published. */
function openingLeg(
  link: DirectLink,
  signal: AbortSignal | undefined,
): { url: string; init: ProbeRequestInit } {
  if (link.transport === 'mcp') {
    return {
      url: link.endpoint,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: MCP_ACCEPT },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { ...CLIENT_INFO },
          },
        }),
        signal,
      },
    };
  }
  return {
    url: link.endpoint,
    init: { method: 'GET', headers: { accept: 'application/json' }, signal },
  };
}

/**
 * The far end's own words for an unhappy answer, or `undefined` when it was happy.
 *
 * A non-ok status is always unhappy; an ok status carrying a JSON-RPC `error` envelope is too,
 * because that is how MCP refuses (HTTP 200, error inside). Mirrors the console's
 * `refusalReason`, on the same two shapes: FastAPI's `detail` and JSON-RPC's `error.message`.
 */
async function refusalOf(response: ProbeResponse): Promise<string | undefined> {
  let body: unknown;
  if (response.text !== undefined) {
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = undefined;
    }
  }
  const stated = reasonIn(body);
  if (response.ok) return stated;
  return stated ?? `answered ${response.status}`;
}

/** A refusal as either of the two shapes this fabric's peers state one in. */
function reasonIn(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.detail === 'string' && record.detail !== '') return record.detail;
  const error = record.error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return undefined;
}

/** What to show for a reading, in the far end's words where it gave any. */
function detailOf(observation: Observation): string | undefined {
  if (observation.reason !== undefined && observation.reason !== '') return observation.reason;
  if (!observation.answered) return 'no answer';
  return undefined;
}

/** What stopped a dial, whatever the transport threw. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
