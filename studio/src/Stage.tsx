/**
 * The stage — what the shell shows for a given fabric.
 *
 * Empty is the first thing anyone sees and a legitimate steady state, so it says so plainly:
 * zero participants, zero connections, and where a cast comes from. It is not a spinner and
 * not an error. Studio bundles no apps, no services and no connections, so an install nobody
 * has configured and nobody has pointed at a registry has genuinely nothing to draw.
 *
 * Anything else is one picture: the topology graph. A configured cast and a discovered one are
 * the same shape — a node is a participant, an edge is a connection — so rather than two views
 * competing to describe the fabric, a backbone with no discovery behind it is projected into a
 * graph of observed nodes and drawn by the same component. Discovery's answer wins when there
 * is one, because it is the live reading; the configured cast is what Studio was *told*.
 *
 * Populated, it is still only a read: labels, identities, advertised capability names, and the
 * links the participants hold with each other. Nothing here dials anything — the capability
 * names are text on a page, not buttons, because Studio watches this fabric rather than
 * driving it (ADR-0001 decision 7).
 */
import { TopologyGraph } from './TopologyGraph.tsx';
import type { Backbone } from './backbone.ts';
import { topologyOf, type Topology } from './topology.ts';

export interface StageProps {
  /** The picture to draw. Whatever was observed or configured — never anything from here. */
  backbone: Backbone;
  /**
   * Discovery's own answer, when the host has a registry to ask. Takes precedence over the
   * configured backbone: it is what is reachable *now*, re-read on every pass.
   */
  topology?: Topology;
}

export function Stage({ backbone, topology }: StageProps) {
  const graph = graphOf(backbone, topology);

  if (graph.nodes.length === 0 && graph.edges.length === 0) {
    return (
      <div className="studio-empty" role="status">
        <h2>nothing on the fabric yet</h2>
        <p className="studio-counts">0 participants · 0 connections</p>
        <p>
          Studio ships with no apps, no services and no connections. Point it at your own
          configuration and the cast that appears is exactly the one you described.
        </p>
      </div>
    );
  }

  return <TopologyGraph topology={graph} />;
}

/**
 * The graph to draw: discovery's answer when it found anything, else the configured cast.
 *
 * A discovery pass that answered with nobody falls back rather than blanking a cast the user
 * described — it emptied the *discovered* fabric, and it has no standing to erase what the
 * host says it is watching.
 */
function graphOf(backbone: Backbone, topology?: Topology): Topology {
  if (topology && (topology.nodes.length > 0 || topology.edges.length > 0)) return topology;
  return topologyOf({ observed: backbone });
}
