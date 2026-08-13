/**
 * The graph — discovery's answer, drawn.
 *
 * Everything on screen here came out of {@link Topology}: nodes the KCB registry answered
 * with (plus whatever the host watched but discovery has never heard of), and edges typed by
 * what somebody else already decided — the internal/external split off the discovery index,
 * the capability and plane off the registry's path-finding, the transport off the address the
 * far end published. This component computes no classification of its own. It is a projection
 * of a value into elements, and re-rendering it with the next answer is the whole update path.
 *
 * It is also, deliberately, only text. There is no button, no link and no handler on a node
 * or an edge: an advertised capability name is a label, and an address is where a *peer*
 * would dial (ADR-0001 decisions 3 and 7). Studio watches this fabric; nothing here drives it.
 *
 * The vocabulary stays the shell's — participants and connections — because a node *is* a
 * participant and an edge *is* a connection, only with what discovery knows attached.
 */
import { labelOf } from './backbone.ts';
import type { Topology, TopologyEdge, TopologyNode } from './topology.ts';

export interface TopologyGraphProps {
  /** The picture to draw. Whatever the last pass over discovery returned — never state. */
  topology: Topology;
}

export function TopologyGraph({ topology }: TopologyGraphProps) {
  const { nodes, edges } = topology;

  return (
    <div className="studio-graph">
      <p className="studio-counts">
        {nodes.length} participants · {edges.length} connections
      </p>

      <section>
        <h2 id="studio-participants">participants</h2>
        <ul aria-labelledby="studio-participants">
          {nodes.map((node) => (
            <li key={node.identity} className="studio-node">
              <NodeRow node={node} />
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 id="studio-connections">connections</h2>
        {edges.length === 0 ? (
          <p className="studio-none">none observed</p>
        ) : (
          <ul aria-labelledby="studio-connections">
            {edges.map((edge) => (
              <li key={edgeKey(edge)} className={`studio-edge studio-edge-${edge.scope}`}>
                <EdgeRow edge={edge} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * One participant: what to call it, who it is, and what discovery could say about it.
 *
 * `discovered` versus `observed` is the honest difference between a manifest the registry
 * indexed and a peer the host merely saw traffic with, and `unreachable` reports a provider
 * that is indexed but published no endpoint — indexed and undialable is a real state, not an
 * error to hide. Aliases are the identities the KINP resolver folded into this one; showing
 * them is what keeps a merge legible instead of looking like a participant went missing.
 */
function NodeRow({ node }: { node: TopologyNode }) {
  return (
    <>
      <span className="label">{labelOf(node)}</span>{' '}
      <span className="identity">{node.identity}</span>{' '}
      <span className="origin">{node.discovered ? 'discovered' : 'observed'}</span>
      {node.discovered && !node.reachable ? (
        <span className="unreachable"> unreachable</span>
      ) : null}
      {node.capabilities?.length ? (
        <span className="capabilities"> {node.capabilities.join(' · ')}</span>
      ) : null}
      {node.aliases?.length ? (
        <span className="aliases"> also {node.aliases.join(' · ')}</span>
      ) : null}
    </>
  );
}

/**
 * One MCP/A2A connection, with the typing that makes it worth drawing as a graph rather than
 * a list: which transport the pair speaks, whether it stays inside the discovered fabric, the
 * capability the far end serves for this hop, and the plane they hand off on — the last two
 * present only when the link came out of the registry's own cross-plane path-finding.
 */
function EdgeRow({ edge }: { edge: TopologyEdge }) {
  return (
    <>
      <span className="identity">{edge.from}</span> → <span className="identity">{edge.to}</span>
      {edge.transport ? <span className="transport"> {edge.transport}</span> : null}
      <span className="scope"> {edge.scope}</span>
      {edge.capability ? <span className="capability"> {edge.capability}</span> : null}
      {edge.plane ? <span className="plane"> {edge.plane}</span> : null}
      {edge.crossPlane ? <span className="cross-plane"> cross-plane</span> : null}
    </>
  );
}

/** Two ends plus what distinguishes parallel links between them — the same key `edgesOf` dedupes on. */
function edgeKey(edge: TopologyEdge): string {
  return `${edge.from}→${edge.to}:${edge.transport ?? ''}:${edge.capability ?? ''}`;
}
