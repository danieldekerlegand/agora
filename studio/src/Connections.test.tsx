/**
 * What the panel says a connection is doing — and what it refuses to say.
 *
 * The records under test come out of the real fold over real monitoring passes
 * (`monitorConnections` → `trackConnections`) against a probe the test answers for, because
 * the claim is that the panel shows what was *observed*: a healthy link shows how long it has
 * been up, a failing one shows the far end's own words, and a fabric with no connections
 * shows nothing at all rather than a reassuring row. The manifests and identities below are
 * sample data authored for this file (`.example` hostnames), known to no source in the shell.
 */
import { createRegistry } from '@agora/registry';
import { SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.tsx';
import { Connections } from './Connections.tsx';
import { Stage } from './Stage.tsx';
import { EMPTY_BACKBONE } from './backbone.ts';
import {
  monitorConnections,
  type ConnectionProbe,
  type Observation,
} from './connection.ts';
import { trackConnections, type ConnectionRecord } from './history.ts';
import { topologyOf, type Topology, type TopologyNode } from './topology.ts';

const kcb_version = SPEC_VERSIONS.kcb;

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

/** One link, watched: caller → peer over the transport the peer published. */
function fabric(): Topology {
  return topologyOf({
    nodes: [CALLER, PEER],
    observed: { connections: [{ from: CALLER.identity, to: PEER.identity }] },
  });
}

/** Two passes over that link, so there is a duration to report and not just a moment. */
async function watched(first: Observation, second: Observation): Promise<ConnectionRecord[]> {
  const graph = fabric();
  const one = trackConnections(null, await monitorConnections(graph, { probe: () => first }));
  return trackConnections(one, await monitorConnections(graph, { probe: () => second }));
}

/** The rows of the health panel, as text — it is text, so this is all there is to read. */
function rows(): string[] {
  const panel = screen.queryByRole('list', { name: 'connection health' });
  if (!panel) return [];
  return within(panel)
    .getAllByRole('listitem')
    .map((row) => row.textContent ?? '');
}

afterEach(() => {
  cleanup();
});

describe('a connection that is working', () => {
  it('shows how long it has been up, and reports no failure it never had', async () => {
    const connections = await watched(
      { answered: true, status: 200, at: 1_000, latencyMs: 12 },
      { answered: true, status: 200, at: 121_000, latencyMs: 9 },
    );
    render(<Connections connections={connections} />);

    const [link] = rows();
    expect(link).toContain(PEER.identity);
    expect(link).toContain('mcp');
    expect(link).toContain('up');
    expect(link).toContain('up 2m 0s');
    expect(link).not.toContain('degraded');
    expect(screen.queryByText(/no answer/)).toBeNull();
  });
});

describe('a connection that is not', () => {
  it('shows the far end’s own words for a refusal, and how long it has been refusing', async () => {
    const connections = await watched(
      { answered: true, status: 503, reason: 'upstream is busy', at: 1_000 },
      { answered: true, status: 503, reason: 'upstream is busy', at: 31_000 },
    );
    render(<Connections connections={connections} />);

    const [link] = rows();
    expect(link).toContain('degraded');
    expect(link).toContain('upstream is busy');
    // Two readings said the same thing: one row with a count, not two rows.
    expect(link).toContain('×2');
    expect(link).toContain('for 30s');
    expect(link).not.toContain('up ');
  });

  it('shows a silent peer as down, saying what stopped the dial', async () => {
    const connections = await watched(
      { answered: true, status: 200, at: 1_000 },
      { answered: false, reason: 'connection refused', at: 2_000 },
    );
    render(<Connections connections={connections} />);

    const [link] = rows();
    expect(link).toContain('down');
    expect(link).toContain('connection refused');
  });

  it('is a readout and not a console: nothing on it can be pressed', async () => {
    const connections = await watched(
      { answered: false, reason: 'connection refused', at: 1_000 },
      { answered: false, reason: 'connection refused', at: 2_000 },
    );
    render(<Connections connections={connections} />);

    // Studio watches these links; it is not on them, so there is no retry (ADR-0001 3 and 7).
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryAllByRole('link')).toEqual([]);
  });
});

describe('a connection nobody watched', () => {
  it('says so, rather than being drawn as healthy', () => {
    render(<Stage backbone={EMPTY_BACKBONE} topology={fabric()} />);

    const [link] = rows();
    expect(link).toContain('unknown');
    expect(link).toContain('not probed');
    expect(link).not.toContain('up ');
  });
});

describe('an unconfigured fabric', () => {
  it('draws an empty panel rather than inventing a connection to reassure about', () => {
    render(<Connections connections={[]} />);

    expect(rows()).toEqual([]);
    expect(screen.queryAllByRole('listitem')).toEqual([]);
    expect(screen.getByText(/no connections to watch/)).toBeTruthy();
  });

  it('shows no panel at all on the empty stage, which has no fabric to report on', () => {
    render(<Stage backbone={EMPTY_BACKBONE} />);

    expect(screen.queryByRole('list', { name: 'connection health' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('0 participants · 0 connections');
  });
});

describe('the panel follows the statuses as they change', () => {
  const SERVER: CapabilityManifest = {
    kcb_version,
    identity: 'sample:agent:server',
    endpoints: { mcp: 'https://server.example/mcp' },
    capabilities: [{ name: 'observe' }],
  };

  const CLIENT: CapabilityManifest = {
    kcb_version,
    identity: 'sample:agent:client',
    endpoints: { a2a: 'https://client.example/.well-known/agent-card.json' },
    capabilities: [{ name: 'summarize.text' }],
  };

  function indexed() {
    const registry = createRegistry();
    registry.register(CLIENT);
    registry.register(SERVER);
    return registry;
  }

  /** A probe that answers the same way for every link — the host's seam, in ten lines. */
  function answering(observation: Observation): ConnectionProbe {
    return () => observation;
  }

  it('redraws a link that fell over, with what it said, inside the mounted tree', async () => {
    const discovery = {
      discovery: indexed(),
      observed: { connections: [{ from: CLIENT.identity, to: SERVER.identity }] },
    };
    const { rerender } = render(
      <App
        discovery={discovery}
        monitor={{ probe: answering({ answered: true, status: 200, at: 1_000 }) }}
      />,
    );
    await waitFor(() => expect(rows()[0]).toContain('up'));
    const stage = screen.getByRole('main', { name: 'studio stage' });

    rerender(
      <App
        discovery={discovery}
        monitor={{
          probe: answering({ answered: false, reason: 'connection refused', at: 61_000 }),
        }}
      />,
    );

    await waitFor(() => expect(rows()[0]).toContain('connection refused'));
    expect(rows()[0]).toContain('down');
    // Same element, not a fresh document: the status moved inside the tree that was mounted.
    expect(screen.getByRole('main', { name: 'studio stage' })).toBe(stage);
  });
});
