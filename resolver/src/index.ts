/**
 * The KINP resolver reference implementation (`koine/specs/identity.md` §8).
 *
 * Resolves identifiers and reconciles duplicate entity references, backed by Pinakes as
 * the authoritative store for real-world entities. Like the registry it is a *lookup*
 * service (ADR-0001 decision 3) — it returns identity, never relayed payloads.
 *
 * The `resolve` / `reconcile` verbs are out of scope for the bootstrap; US-AG4 defines
 * the interface stub the console depends on, and the full implementation is backlogged
 * to grounding-pinakes / capability-registry.
 */
import { SPEC_VERSIONS } from '@agora/schemas';

/** KINP identity of the resolver service itself. */
export const RESOLVER_IDENTITY = 'agora:agent:resolver';

export interface ResolverDescription {
  identity: string;
  kinpVersion: string;
}

export function describeResolver(): ResolverDescription {
  return {
    identity: RESOLVER_IDENTITY,
    kinpVersion: SPEC_VERSIONS.kinp,
  };
}
