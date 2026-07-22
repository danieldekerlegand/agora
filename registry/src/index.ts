/**
 * The discovery registry — a cache/index over KCB capability manifests.
 *
 * ADR-0001 decision 3: **route-by-lookup, not route-by-proxy.** The registry answers
 * "who can do X, and where do I dial them" with addresses. It has no data-plane path:
 * inter-service traffic never passes through it. `proxiesTraffic` below is asserted in
 * the test suite so the invariant fails loudly if anyone ever flips it.
 *
 * The index, the `find` verbs and capability-path search land in US-AG4.
 */
import { SPEC_VERSIONS } from '@agora/schemas';

/** KINP identity of the registry itself — a provider is a fabric entity too (KCB §2). */
export const REGISTRY_IDENTITY = 'agora:agent:registry';

export interface RegistryDescription {
  identity: string;
  kcbVersion: string;
  /** Always false — see ADR-0001 decision 3. */
  proxiesTraffic: false;
}

export function describeRegistry(): RegistryDescription {
  return {
    identity: REGISTRY_IDENTITY,
    kcbVersion: SPEC_VERSIONS.kcb,
    proxiesTraffic: false,
  };
}
