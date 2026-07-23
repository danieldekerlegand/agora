/**
 * The discovery registry — a cache/index over KCB capability manifests.
 *
 * ADR-0001 decision 3: **route-by-lookup, not route-by-proxy.** The registry answers
 * "who can do X, and where do I dial them" with addresses. It has no data-plane path:
 * inter-service traffic never passes through it. `proxiesTraffic` below is asserted in
 * the test suite so the invariant fails loudly if anyone ever flips it.
 *
 * - `registry.ts` — the index and `find` (KCB §3)
 * - `path.ts`     — capability-path search across providers (§3 composition)
 * - `ports.ts`    — port matching, the arithmetic under both
 * - `cost.ts`     — the ranking: zero-cost routes first, unpriced last (delta K)
 * - `crawl.ts`    — pull population from a provider's well-known manifest
 */
import { SPEC_VERSIONS } from '@agora/schemas';

export {
  CapabilityRegistry,
  createDurableRegistry,
  createRegistry,
  type FindQuery,
  type Match,
  type MatchedCapability,
  type RegisterOptions,
  type Registration,
  type RegistrationSource,
} from './registry.ts';
export {
  createFileStore,
  createMemoryStore,
  type ManifestStore,
} from './store.ts';
export { compareByCost, costOf } from './cost.ts';
export {
  findCapabilityPath,
  type CapabilityPath,
  type PathQuery,
  type PathStep,
} from './path.ts';
export { matchesPort, satisfies, servesWorld, worldMatches, type PortQuery } from './ports.ts';
export {
  CrawlError,
  KCB_MANIFEST_PATH,
  manifestUrl,
  PROVIDER_ROUTER_BASE_URL,
  PROVIDER_ROUTER_IDENTITY,
  registerFromWellKnown,
  registerProviderRouter,
  registerTrainer,
  TRAINER_BASE_URL,
  TRAINER_IDENTITY,
  type CrawlOptions,
  type ManifestFetch,
} from './crawl.ts';
export {
  createRegistryServer,
  type RegistryServerOptions,
  type RegistryService,
  type ServiceAddress,
} from './server.ts';
export {
  createReplicator,
  REPLICATION_HEADER,
  SOURCE_HEADER,
  type ReplicationFetch,
  type Replicator,
} from './replication.ts';
export {
  DEFAULT_REGISTRY_HOST,
  DEFAULT_REGISTRY_PORT,
  registryLaunchFromEnv,
  startRegistry,
  type RegistryEnv,
  type RegistryLaunch,
  type StartedRegistry,
} from './main.ts';

/** KINP identity of the registry itself — a provider is a fabric entity too (KCB §2). */
export const REGISTRY_IDENTITY = 'agora:agent:registry';

export interface RegistryDescription {
  identity: string;
  kcbVersion: string;
  /** Always false — see ADR-0001 decision 3. */
  proxiesTraffic: false;
  /** The query verbs this build answers (KCB §3). Discovery only; `invoke` is the
   * caller's job, against the address this registry hands back. */
  verbs: readonly string[];
}

export function describeRegistry(): RegistryDescription {
  return {
    identity: REGISTRY_IDENTITY,
    kcbVersion: SPEC_VERSIONS.kcb,
    proxiesTraffic: false,
    verbs: ['register', 'remove', 'get', 'list', 'address', 'find', 'path'],
  };
}
