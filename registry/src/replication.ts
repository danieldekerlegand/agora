/**
 * Basic clustering: push a registration to configured peer nodes so every node's index
 * converges (capability-bus.md §3; ADR-0001 "the registry is a cache/index").
 *
 * The invariant that governs this file is the one the whole registry lives by: **each node
 * stays a cache, never a data-plane hop.** Replication carries only what `register` already
 * stores — identity + the verbatim manifest + `source` — over the *same* `/register`/`/remove`
 * discovery routes, so a replicated entry lands through {@link CapabilityRegistry.register}'s
 * parseManifest/freezeCopy path just like a direct push. `proxiesTraffic` stays false on every
 * node and no peer becomes a mandatory hop for traffic (ADR-0001 decision 3); the optional
 * aggregator facade of decision 4 is deliberately out of scope.
 *
 * Loop-free and idempotent (§4, the way content-addressed KCB redelivery is): a replicated
 * delivery is marked with {@link REPLICATION_HEADER} so the receiving node applies it locally
 * but does **not** re-propagate, and the server only propagates a write that actually changed
 * the local index — re-receiving an already-current registration is a no-op. An unreachable
 * peer degrades gracefully: propagation swallows the failure so the local register still
 * succeeds and the local index still answers.
 */
import type { Registration, RegistrationSource } from './registry.ts';

/** Marks a `/register` or `/remove` as a replicated delivery — the receiver must not re-fan it
 * out, which is what keeps the mesh loop-free. */
export const REPLICATION_HEADER = 'x-agora-replicated';

/** Carries the origin's {@link RegistrationSource} on a replicated `/register`, so a crawled
 * (`pull`) entry stays `pull` on every node rather than being relabelled `push`. */
export const SOURCE_HEADER = 'x-agora-source';

/** The slice of `fetch` replication needs — a POST with headers and a body. Structural so a
 * test can stand in three lines; defaults to the global `fetch`. */
export type ReplicationFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/** Fans a local write out to peer nodes. A node with no peers has no replicator. */
export interface Replicator {
  /** The peers this node pushes to — empty means clustering is off. */
  readonly peers: readonly string[];
  /** Propagate a registration (verbatim manifest + source) to every peer. */
  register(registration: Registration): Promise<void>;
  /** Propagate a removal to every peer. */
  remove(identity: string): Promise<void>;
}

/**
 * Build a replicator over a set of peer base URLs. Each call fans out with
 * {@link https://developer.mozilla.org/en-US/docs/Web/API/Promise/allSettled Promise.allSettled}
 * so one unreachable peer never fails the others — or the local write that triggered it.
 */
export function createReplicator(
  peers: readonly string[],
  fetchImpl?: ReplicationFetch,
): Replicator {
  const post = fetchImpl ?? (globalThis.fetch as unknown as ReplicationFetch);
  const fanOut = async (path: string, headers: Record<string, string>, body: string): Promise<void> => {
    await Promise.allSettled(
      peers.map((peer) =>
        post(`${peer.replace(/\/+$/, '')}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [REPLICATION_HEADER]: '1', ...headers },
          body,
        }),
      ),
    );
  };
  return {
    peers,
    register: (registration) =>
      fanOut(
        '/register',
        { [SOURCE_HEADER]: registration.source },
        JSON.stringify(registration.manifest),
      ),
    remove: (identity) => fanOut('/remove', {}, JSON.stringify({ identity })),
  };
}

/**
 * Whether a just-applied registration is a genuine change against the pre-write snapshot — a
 * new identity, a different `source`, or a different (verbatim) manifest. Only a change is
 * worth propagating; re-registering an already-current manifest is a no-op that must not ripple
 * across the mesh.
 */
export function isNewOrChanged(before: readonly Registration[], current: Registration): boolean {
  const prior = before.find((registration) => registration.identity === current.identity);
  if (prior === undefined) return true;
  return (
    prior.source !== current.source ||
    JSON.stringify(prior.manifest) !== JSON.stringify(current.manifest)
  );
}

/** Read the origin {@link RegistrationSource} off a replicated request's headers, defaulting to
 * `push`. */
export function sourceFromHeader(value: string | undefined): RegistrationSource {
  return value === 'pull' ? 'pull' : 'push';
}
