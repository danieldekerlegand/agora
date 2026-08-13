/**
 * What the graph shows for a discovery snapshot — and what it shows for the *next* one.
 *
 * These tests drive a **real** registry and a **real** KINP resolver rather than hand-built
 * topologies, for the same reason `topology.test.ts` does: the claim is that what is on screen
 * is discovery's answer, so the answer has to come from discovery. The manifests below are
 * sample data authored for this file (the `.example` hostnames say so) and none of them is
 * known to `studio/src` — populate the registry with anyone else's and their graph is what
 * renders instead.
 *
 * The churn tests are the point of the story: a participant leaves the index, or joins it, and
 * the rendered graph follows within the same mounted tree. Nothing is reloaded, nothing is
 * remembered, and no removal logic exists to forget to run.
 */
import { createRegistry } from '@agora/registry';
import { createAuthorityResolver } from '@agora/resolver';
import { SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.tsx';
import { TopologyGraph } from './TopologyGraph.tsx';
import { discoverTopology, type Topology, type TopologyQuery } from './topology.ts';
import { useTopology } from './useTopology.ts';

const kcb_version = SPEC_VERSIONS.kcb;

/** A free local hop — cheapest, so discovery ranks it first (KCB §3 delta K). */
const FREE: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:free-hop',
  endpoints: { mcp: 'https://free.example/mcp' },
  capabilities: [
    {
      name: 'render',
      inputs: [{ plane: 'media', media_types: ['audio/midi'] }],
      outputs: [{ plane: 'media', media_types: ['audio/wav'] }],
      cost: { tier: 'local', est_units: 0 },
    },
  ],
};

/** The same hop, paid, over A2A — present so there is a second transport on the picture. */
const PAID: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:paid-hop',
  endpoints: { a2a: 'https://paid.example/.well-known/agent-card.json' },
  capabilities: [
    {
      name: 'render',
      inputs: [{ plane: 'media', media_types: ['audio/midi'] }],
      outputs: [{ plane: 'media', media_types: ['audio/wav'] }],
      cost: { tier: 'paid', est_units: 900 },
    },
  ],
};

/** Indexed with capabilities but no published endpoint: discovered, and undialable. */
const SILENT: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:silent',
  endpoints: {},
  capabilities: [{ name: 'describe' }],
};

/** Joins the index between two passes — the arrival half of churn. */
const NEWCOMER: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:newcomer',
  endpoints: { a2a: 'https://newcomer.example/.well-known/agent-card.json' },
  capabilities: [{ name: 'summarize.text' }],
};

/** Consumes media, produces knowledge: the plane crossing the registry finds when it plans. */
const CROSSING: CapabilityManifest = {
  kcb_version,
  identity: 'sample:agent:crossing',
  endpoints: { a2a: 'https://crossing.example/.well-known/agent-card.json' },
  capabilities: [
    {
      name: 'describe.audio',
      inputs: [{ plane: 'media', media_types: ['audio/wav'] }],
      outputs: [{ plane: 'knowledge' }],
      cost: { tier: 'paid', est_units: 10 },
    },
  ],
};

/** Somebody the host talks to who is in nobody's index — the outside end of an external edge. */
const OUTSIDE = 'sample:agent:outside-peer';

/** Two halves of one entity: only the authority knows they are the same thing. */
const TWIN_HERE: CapabilityManifest = {
  kcb_version,
  identity: 'sample:ent:twin-here',
  endpoints: { mcp: 'https://twin-here.example/mcp' },
  capabilities: [{ name: 'observe' }],
};

const TWIN_THERE: CapabilityManifest = {
  kcb_version,
  identity: 'sample:ent:twin-there',
  endpoints: { mcp: 'https://twin-there.example/mcp' },
  capabilities: [{ name: 'observe' }],
};

function indexed(...manifests: CapabilityManifest[]) {
  const registry = createRegistry();
  for (const manifest of manifests) registry.register(manifest);
  return registry;
}

/** A real KINP resolver, told what its authority says (see `topology.test.ts`). */
function authorityStating(links: Record<string, string[]>) {
  return createAuthorityResolver({
    endpoint: 'https://authority.example',
    fetch: (url) => {
      const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      const stated = links[id];
      if (stated === undefined) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ same_as: stated }),
      });
    },
  });
}

/** The rows of a named list, as text — the graph is text, so this is all there is to read. */
function rowsOf(name: 'participants' | 'connections'): string[] {
  const list = screen.queryByRole('list', { name });
  if (!list) return [];
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '');
}

/** Wait for a pass to land, then read the graph the shell drew. */
async function drawn(name: 'participants' | 'connections'): Promise<string[]> {
  await waitFor(() => expect(screen.queryByRole('list', { name })).not.toBeNull());
  return rowsOf(name);
}

afterEach(() => {
  cleanup();
});

describe('the graph is the discovery snapshot it was handed', () => {
  async function snapshot(query: TopologyQuery): Promise<Topology> {
    return discoverTopology(query);
  }

  it('draws one row per discovered participant, in the order discovery ranked them', async () => {
    render(<TopologyGraph topology={await snapshot({ discovery: indexed(PAID, FREE, SILENT) })} />);

    const participants = rowsOf('participants');
    expect(participants).toHaveLength(3);
    // The free route leads because `find` ranked it there; the view re-sorts nothing.
    expect(participants[0]).toContain(FREE.identity);
    expect(participants[1]).toContain(PAID.identity);
    expect(participants[2]).toContain(SILENT.identity);
    expect(screen.getByText(/3 participants/)).toBeTruthy();
  });

  it('says which participants came from the index, and which are merely reachable-looking', async () => {
    const topology = await snapshot({
      discovery: indexed(FREE, SILENT),
      observed: { participants: [{ identity: OUTSIDE, label: 'an outside peer' }] },
    });
    render(<TopologyGraph topology={topology} />);

    const [free, silent, outside] = rowsOf('participants');
    expect(free).toContain('discovered');
    expect(free).not.toContain('unreachable');
    // Indexed, and published no endpoint: an ordinary state of a real fabric, drawn as one.
    expect(silent).toContain('unreachable');
    // Never in the index — the host watched it, so it is on the picture as an observed peer.
    expect(outside).toContain('observed');
    expect(outside).toContain('an outside peer');
  });

  it('types every edge by which side of the index it ends on, and how the pair speaks', async () => {
    const topology = await snapshot({
      discovery: indexed(FREE, PAID),
      observed: {
        participants: [{ identity: OUTSIDE }],
        connections: [
          { from: FREE.identity, to: PAID.identity },
          { from: FREE.identity, to: OUTSIDE, transport: 'mcp' },
        ],
      },
    });
    render(<TopologyGraph topology={topology} />);

    const [inside, leaving] = rowsOf('connections');
    expect(inside).toContain('internal');
    // Nobody observed a transport for it; the far end's published address named one.
    expect(inside).toContain('a2a');
    expect(leaving).toContain('external');
    expect(leaving).toContain('mcp');
  });

  it('draws a planned cross-plane route as the handoff the registry computed', async () => {
    const topology = await snapshot({
      discovery: indexed(FREE, CROSSING),
      routes: [{ from: { plane: 'media', mediaType: 'audio/midi' }, to: { plane: 'knowledge' } }],
    });
    render(<TopologyGraph topology={topology} />);

    const [hop] = rowsOf('connections');
    expect(hop).toContain(FREE.identity);
    expect(hop).toContain(CROSSING.identity);
    expect(hop).toContain('describe.audio');
    expect(hop).toContain('media');
    expect(hop).toContain('cross-plane');
  });

  it('draws two addresses the resolver called one entity as one node, saying so', async () => {
    const topology = await snapshot({
      discovery: indexed(TWIN_HERE, TWIN_THERE),
      resolver: authorityStating({
        [TWIN_HERE.identity]: [TWIN_THERE.identity],
        [TWIN_THERE.identity]: [TWIN_HERE.identity],
      }),
    });
    render(<TopologyGraph topology={topology} />);

    const participants = rowsOf('participants');
    expect(participants).toHaveLength(1);
    expect(participants[0]).toContain(TWIN_HERE.identity);
    // The identity that was folded in is still legible: a merge should not read as a loss.
    expect(participants[0]).toContain(TWIN_THERE.identity);
  });

  it('is a picture and not a console: nothing on it can be pressed', async () => {
    render(
      <TopologyGraph
        topology={await snapshot({
          discovery: indexed(FREE, PAID),
          observed: { connections: [{ from: FREE.identity, to: PAID.identity }] },
        })}
      />,
    );

    // An advertised capability name is a label; an address is where a *peer* dials. Studio
    // observes (ADR-0001 decisions 3 and 7), so there is no verb on screen at all.
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryAllByRole('link')).toEqual([]);
    expect(screen.queryAllByRole('textbox')).toEqual([]);
  });
});

describe('the graph follows the fabric as it churns, without a reload', () => {
  it('re-draws for the next snapshot: the departed are gone, the arrived are drawn', async () => {
    const { rerender } = render(<App discovery={{ discovery: indexed(FREE, PAID) }} />);

    expect(await drawn('participants')).toHaveLength(2);
    // The mounted tree, captured before the churn — the update has to happen inside it.
    const stage = screen.getByRole('main', { name: 'studio stage' });

    rerender(<App discovery={{ discovery: indexed(FREE, NEWCOMER) }} />);

    await waitFor(() => {
      const participants = rowsOf('participants');
      expect(participants.some((row) => row.includes(NEWCOMER.identity))).toBe(true);
      expect(participants.some((row) => row.includes(PAID.identity))).toBe(false);
    });
    expect(rowsOf('participants')).toHaveLength(2);
    // Same element, not a fresh document: this was a re-render, not a page reload.
    expect(screen.getByRole('main', { name: 'studio stage' })).toBe(stage);
  });

  it('re-asks the same index when the host says it moved, and drops what left it', async () => {
    // The other churn shape: one long-lived registry whose contents change under a query that
    // never does. The host learns of it however it likes and asks for another pass.
    const registry = indexed(FREE, PAID);
    const query: TopologyQuery = { discovery: registry };

    function Watching() {
      const { topology, refresh } = useTopology(query);
      return (
        <>
          <button onClick={refresh}>ask again</button>
          <TopologyGraph topology={topology} />
        </>
      );
    }

    render(<Watching />);
    expect(await drawn('participants')).toHaveLength(2);

    expect(registry.remove(PAID.identity)).toBe(true);
    registry.register(NEWCOMER);
    screen.getByRole('button', { name: 'ask again' }).click();

    await waitFor(() => {
      const participants = rowsOf('participants');
      expect(participants.some((row) => row.includes(NEWCOMER.identity))).toBe(true);
      expect(participants.some((row) => row.includes(PAID.identity))).toBe(false);
    });
  });

  it('empties when discovery does, rather than keeping a cast nobody answered with', async () => {
    const { rerender } = render(<App discovery={{ discovery: indexed(FREE, PAID) }} />);
    expect(await drawn('participants')).toHaveLength(2);

    rerender(<App discovery={{ discovery: indexed() }} />);

    // Back to the fresh-install state, which is a state and not a failure: an emptied index
    // is an answer, and there is no remembered roster for the old cast to linger in.
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeNull());
    expect(screen.getByRole('status').textContent).toContain('0 participants · 0 connections');
    expect(rowsOf('participants')).toEqual([]);
  });

  it('draws the configured cast when there is no discovery surface to ask', () => {
    render(<App backbone={{ participants: [{ identity: OUTSIDE, label: 'Outside' }], connections: [] }} />);

    const participants = rowsOf('participants');
    expect(participants).toHaveLength(1);
    expect(participants[0]).toContain('Outside');
    expect(participants[0]).toContain('observed');
  });

  it('reports a lookup it could not make, and leaves the last good picture up', async () => {
    const { rerender } = render(<App discovery={{ discovery: indexed(FREE, PAID) }} />);
    expect(await drawn('participants')).toHaveLength(2);

    rerender(
      <App discovery={{ discovery: { find: () => Promise.reject(new Error('registry offline')) } }} />,
    );

    // A registry Studio could not read is not a fabric that emptied — saying so would be
    // asserting a churn event that never happened.
    expect((await screen.findByRole('alert')).textContent).toContain('registry offline');
    expect(rowsOf('participants')).toHaveLength(2);
  });
});
