/**
 * `@agora/sdk` — the client SDK for a KCB participant.
 *
 * This is the **one entry point** an out-of-tree consumer imports. Everything a newcomer needs
 * to become a discoverable participant and to find another one lives here: the KCB address
 * projection (`kcb.ts`), the relation-registry loader (`relation-registry.ts`), and the slice of
 * `@agora/schemas` a participant handles on the wire — its AgentCard, the KCB manifest extension
 * that card carries, and the parsers over both.
 *
 * **Addresses, never a relay.** By ADR-0001 (decisions 2–4) the control plane hands back
 * *addresses*; the caller dials the provider itself, directly, over MCP/A2A/OpenAI. So this
 * surface is pure and synchronous apart from {@link loadRelationRegistry} (which fetches koine's
 * own registry data and nothing else): there is no `invoke`, no `call`, no `send`, and there must
 * never be one — an SDK that dialed on the caller's behalf would make the commons the traffic hub
 * the topology exists to avoid. {@link SDK_API} enumerates the surface and `index.test.ts` fails
 * the build if a relay-shaped name ever appears in it.
 *
 * The published surface is this module and only this module: a consumer that reaches into
 * `@agora/sdk/src/…` is depending on a path this package does not promise.
 */
export {
  addressOf,
  endpointFor,
  isDialable,
  KCB_CLIENT_VERSION,
  transportOf,
  type ProviderAddress,
  type ProviderEndpoints,
  type Transport,
} from './kcb.ts';

export {
  indexRegistry,
  loadRelationRegistry,
  RegistryFetchError,
  type LoadedRegistry,
  type LoadOptions,
  type RegistryFetch,
} from './relation-registry.ts';

/**
 * The koine contract surface a participant handles, re-exported so the one-line install is
 * genuinely one line: a consumer builds and parses cards and manifests without adding a second
 * dependency. These are `@agora/schemas`'s own exports, unchanged — the schemas package remains
 * the definition, this is the SDK's curated view of it.
 */
export {
  embedManifest,
  isCapabilityManifest,
  isCompatibleKcbVersion,
  KCB_MANIFEST_EXTENSION_URI,
  ManifestError,
  parseManifest,
  parseManifestBody,
  SPEC_VERSIONS,
  toAgentCardExtension,
  type AgentCapabilities,
  type AgentCard,
  type AgentExtension,
  type Capability,
  type CapabilityCost,
  type CapabilityManifest,
  type EntityPort,
  type KnowledgePort,
  type ManifestAuth,
  type ManifestSigning,
  type MediaPort,
  type Port,
} from '@agora/schemas';

import { SPEC_VERSIONS } from '@agora/schemas';

/** The semantic version of this SDK. Kept equal to the package's `version` by `index.test.ts`. */
export const SDK_VERSION = '0.1.0';

/**
 * The public API, enumerated — the index a reader (and a test) can hold against the module.
 *
 * Grouped by what a consumer is doing, because that is how the surface is meant to be learned:
 * `discover` finds *where* a peer is, `participate` builds and reads the document that makes you
 * findable, `knowledge` loads the shared relation vocabulary.
 */
export const SDK_API = {
  /** Turn a manifest into an ADDRESS and decide what to dial it over. Never dials. */
  discover: [
    'addressOf',
    'endpointFor',
    'isDialable',
    'transportOf',
    'KCB_CLIENT_VERSION',
  ],
  /** Serve and read the AgentCard + KCB manifest extension that makes a peer discoverable. */
  participate: [
    'embedManifest',
    'isCapabilityManifest',
    'isCompatibleKcbVersion',
    'KCB_MANIFEST_EXTENSION_URI',
    'ManifestError',
    'parseManifest',
    'parseManifestBody',
    'toAgentCardExtension',
    'SPEC_VERSIONS',
  ],
  /** Load koine's shared relation registry (KGP) and index it. Fetches that data, nothing else. */
  knowledge: ['indexRegistry', 'loadRelationRegistry', 'RegistryFetchError'],
} as const;

/** What this SDK is, on its own surface — the same shape `describeRegistry()` reports. */
export interface SdkDescription {
  version: string;
  /** The koine spec versions this build speaks, pinned in `@agora/schemas`. */
  specs: typeof SPEC_VERSIONS;
  api: typeof SDK_API;
  /**
   * ADR-0001 decisions 2–4, asserted rather than merely documented: this SDK returns addresses
   * the caller dials directly. It is always `false`, and a change that made it anything else
   * would be a change to the topology, not to a library.
   */
  relaysPayloads: false;
}

/** Describe the SDK: its version, the specs it speaks, its surface, and what it will not do. */
export function describeSdk(): SdkDescription {
  return { version: SDK_VERSION, specs: SPEC_VERSIONS, api: SDK_API, relaysPayloads: false };
}
