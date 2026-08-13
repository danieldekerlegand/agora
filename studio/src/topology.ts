/**
 * The topology's nodes — the cast of the graph, learned from discovery rather than held.
 *
 * A node is a participant the KCB discovery registry answered with: an identity, and the
 * address peers dial it at. Studio keeps no roster and reads no manifest of its own — the
 * `registry/` area already answers "who can do X, and where do I dial them", ranked by cost
 * (KCB §3), and this module is only the projection of that answer into something a view can
 * draw. Whoever is indexed is who appears; nobody is written down here.
 *
 * Two rules follow from that, and they are the whole file:
 *
 * 1. **Discovery arrives as an argument, never as a lookup.** The host hands in the find
 *    surface — the registry in-process, or a client onto a remote one — exactly the way the
 *    config seam is handed text. Nothing here goes and gets one, so this area still opens no
 *    transport at all.
 * 2. **An address is the end of it.** A node carries where a peer *would* dial, and Studio is
 *    never that peer (ADR-0001 decisions 3 and 7). Advertised capability names ride along as
 *    labels on the node — drawn, never invoked.
 *
 * Discovery that answers with nobody yields no nodes: the same empty stage a fresh install
 * draws, which is a state and not a failure. That is also what makes the graph churn-safe —
 * a participant that has left the index simply is not in the next answer, and there is no
 * remembered cast for it to linger in.
 */
import type { FindQuery, Match } from '@agora/registry';
import { isDialable, type ProviderAddress } from '@agora/sdk';

import type { Participant } from './backbone.ts';

/**
 * One discovered participant, ready to draw.
 *
 * A {@link Participant} — so every view already reading a backbone reads a node too, `labelOf`
 * included — plus the two things only discovery can say: where it is dialable, and whether it
 * published anything dialable at all.
 */
export interface TopologyNode extends Participant {
  /** Where peers connect directly. The registry's whole answer, carried verbatim. */
  address: ProviderAddress;
  /** False when the provider published no endpoint: discovered, indexed, and unreachable. */
  reachable: boolean;
}

/**
 * The discovery surface Studio reads — structurally the registry's own `find`.
 *
 * Stated as the one verb this area needs rather than as the registry class, so an in-process
 * `CapabilityRegistry`, a client onto a remote one, or a test's canned answer are the same
 * thing from here. `find` is a lookup that returns addresses; there is deliberately no other
 * method on this type, because there is no other verb Studio is entitled to.
 */
export interface Discovery {
  find(query?: FindQuery): readonly Match[] | Promise<readonly Match[]>;
}

/**
 * The nodes a discovery answer describes, in the order discovery ranked them.
 *
 * Order is kept because it is meaningful: `find` returns cost-ranked matches (zero-cost first,
 * unpriced last), and re-sorting here would throw away a judgement the registry already made.
 * A match with no identity is dropped and a repeated identity collapses to its first sighting,
 * the same way the backbone treats a configured cast: one node per discovered address.
 */
export function nodesOf(matches?: readonly Match[] | null): TopologyNode[] {
  if (!matches) return [];

  const nodes: TopologyNode[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const identity = match?.identity?.trim();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);

    const address: ProviderAddress = match.address ?? { identity, endpoints: {} };
    const node: TopologyNode = { identity, address, reachable: isDialable(address) };

    const capabilities = (match.capabilities ?? [])
      .map((capability) => capability?.name?.trim())
      .filter((name): name is string => Boolean(name));
    if (capabilities.length) node.capabilities = capabilities;

    nodes.push(node);
  }
  return nodes;
}

/**
 * Ask discovery who is on the fabric, and project the answer into nodes.
 *
 * The default query is the empty one, which the registry reads as "every indexed provider" —
 * the graph's question is who is *there*, not who serves some capability Studio picked. Narrow
 * it by passing a query through; it is the registry's own {@link FindQuery}, unwrapped and
 * un-second-guessed.
 */
export async function discoverNodes(
  discovery: Discovery,
  query: FindQuery = {},
): Promise<TopologyNode[]> {
  return nodesOf(await discovery.find(query));
}
