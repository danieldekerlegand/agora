/**
 * Agora Studio — the shell.
 *
 * The backbone the topology graph, connection monitoring, the message viewer, the analytics
 * dashboards and the spec viewer all mount into. It ships with **nothing**: no apps, no
 * services, no connections, no roster. A fresh install is an empty stage, and it stays empty
 * until the user's own configuration supplies a cast — the same capability-never-caller rule
 * the rest of this tree obeys, so no participant is named in this source at all.
 *
 * Like the conformance console it is an **observer, not a hub** (ADR-0001 decision 7):
 * whatever it eventually draws, it draws from what it watched. Traffic between participants
 * never passes through Studio, and the shell holds no seam through which it could.
 *
 * What it renders is the frame — who this is, where a view goes, which koine contracts this
 * build speaks — around the topology graph. The graph's cast is not the shell's either: hand
 * in the lookup surfaces and it draws whoever discovery answers with, re-drawn on the next
 * answer, so a fabric that churns needs no reload and leaves nothing stale behind.
 */
import { useMemo } from 'react';
import { SPEC_VERSIONS } from '@agora/schemas';

import './App.css';
import { Stage } from './Stage.tsx';
import { backboneOf, type Backbone } from './backbone.ts';
import type { TopologyQuery } from './topology.ts';
import { useConnections, type ConnectionsOptions } from './useConnections.ts';
import { useTopology } from './useTopology.ts';

/** The koine contracts a Studio build speaks, in the order the footer lists them. */
const CONTRACTS = Object.entries(SPEC_VERSIONS);

export interface AppProps {
  /**
   * The fabric to draw. A prop, and only ever a prop: the cast arrives at runtime from the
   * user's own configuration, so there is nothing to default it *to* except nothing.
   */
  backbone?: Backbone;
  /**
   * Whatever the user's config said that could not be read (`readStudioConfig().problems`).
   * Shown rather than swallowed: a dropped entry the user cannot see is a bug they cannot fix.
   */
  problems?: readonly string[];
  /**
   * The lookup surfaces to draw the live graph from — the KCB discovery registry, optionally
   * the KINP resolver, and what to ask them. A prop like everything else: Studio opens no
   * transport, so a host that has a registry hands one in and a host that has none (the
   * standalone bundle) passes nothing and keeps the configured picture.
   */
  discovery?: TopologyQuery | null;
  /**
   * How to watch the connections on that graph — the probe, and how long a log to keep. A prop
   * for the same reason the discovery surface is: the dial belongs to the host, Studio opens
   * no transport of its own, and it is only ever the far end's own published address that gets
   * dialed (`connection.ts`). Without one, every connection is reported honestly as unwatched.
   *
   * Identity, not deep equality, starts a pass: hand in the same object until the host's own
   * schedule says to look again.
   */
  monitor?: ConnectionsOptions | null;
  /**
   * The AgentCards the host read at the participants' own well-known addresses, by identity —
   * what the spec viewer renders beside whatever discovery indexed. A prop for the reason
   * every document seam here is one: Studio opens no transport, so a host that fetched cards
   * hands them in, and a host that fetched none shows the indexed manifests and nothing more.
   */
  cards?: Readonly<Record<string, unknown>>;
}

export function App({
  backbone,
  problems = [],
  discovery = null,
  monitor = null,
  cards = {},
}: AppProps = {}) {
  const fabric = backboneOf(backbone);

  // The configured cast is what the host says it watched, so it rides in as the pass's own
  // `observed` unless the host already said otherwise — that is what puts a peer discovery
  // never heard of on the graph as the outside end of an external edge.
  const query = useMemo<TopologyQuery | null>(
    () => (discovery ? { ...discovery, observed: discovery.observed ?? backbone ?? null } : null),
    [discovery, backbone],
  );
  const { topology, problem } = useTopology(query);

  // Only what discovery answered with is watched: a configured cast carries no address to
  // dial, so probing it could say nothing a panel of unwatched rows does not already say.
  const { connections, problem: unwatchable } = useConnections(
    monitor ? topology : null,
    monitor,
  );

  return (
    <div className="studio">
      <header className="studio-header">
        <h1>agora studio</h1>
        <p className="studio-tagline">
          the topology and observability view over your own fabric — an observer on real
          connections, never a hub
        </p>
      </header>

      <main className="studio-stage" aria-label="studio stage">
        <Stage backbone={fabric} topology={topology} connections={connections} cards={cards} />
        {problem ? (
          <p className="studio-alert" role="alert">
            {problem}
          </p>
        ) : null}
        {unwatchable ? (
          <p className="studio-alert" role="alert">
            {unwatchable}
          </p>
        ) : null}
        {problems.length > 0 ? (
          <section className="studio-problems" aria-label="config problems">
            <h2>some of your config was not read</h2>
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>

      <footer className="studio-footer">
        <h2>koine contracts</h2>
        <ul>
          {CONTRACTS.map(([spec, version]) => (
            <li key={spec}>
              <span className="spec">{spec}</span> <span className="version">{version}</span>
            </li>
          ))}
        </ul>
      </footer>
    </div>
  );
}
