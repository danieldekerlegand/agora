/**
 * KCB client — the shared way for a peer to *find* another peer.
 *
 * ADR-0001 decisions 2-4: the registry hands back **addresses**; the caller then dials
 * the provider directly over MCP/A2A. This client therefore only ever returns endpoints —
 * it must never grow a "call it for me" method that relays a payload, or the commons
 * becomes the traffic hub the ADR rejects.
 *
 * The lookup verbs live in `@agora/registry` (US-AG4); this module owns the address shape
 * every area agrees on, and the one projection that turns a manifest into an address.
 */
import { SPEC_VERSIONS, type Capability, type CapabilityManifest } from '@agora/schemas';

/**
 * The endpoints a KCB provider publishes (capability-bus.md §2).
 *
 * `mcp` and `a2a` are the spec's named transports; the map is open because a provider
 * publishes the addresses it actually serves and only those — the provider-router, for
 * one, serves `openai`/`doctor`/`manifest` and no MCP surface yet.
 */
export interface ProviderEndpoints {
  /** MCP server exposing the provider's tools. */
  mcp?: string;
  /** A2A agent card. */
  a2a?: string;
  [name: string]: string | undefined;
}

/** What a lookup resolves to: who the provider is and where to dial it. */
export interface ProviderAddress {
  /** KINP identity of the provider. */
  identity: string;
  endpoints: ProviderEndpoints;
}

/** The KCB spec version this client speaks. */
export const KCB_CLIENT_VERSION = SPEC_VERSIONS.kcb;

/** True when an address is dialable — a provider with no endpoint cannot be reached. */
export function isDialable(address: ProviderAddress): boolean {
  return Object.values(address.endpoints).some((endpoint) => Boolean(endpoint));
}

/** The address a manifest advertises. The only projection of a manifest this client makes. */
export function addressOf(manifest: CapabilityManifest): ProviderAddress {
  return { identity: manifest.identity, endpoints: { ...manifest.endpoints } };
}

/**
 * Where to dial one capability: its own `endpoint` when it declares one, otherwise the
 * provider's preferred transport. Returns `undefined` when the provider published nothing
 * dialable — the caller must not invent an address.
 */
export function endpointFor(
  address: ProviderAddress,
  capability?: Pick<Capability, 'endpoint'>,
): string | undefined {
  return capability?.endpoint ?? address.endpoints.mcp ?? address.endpoints.a2a;
}

/** The spec's named client transports — the protocol a wire opens against an address. */
export type Transport = 'mcp' | 'a2a' | 'openai';

/** The named transports a capability endpoint might be hosted on, checked in this order. */
const NAMED_TRANSPORTS: readonly Transport[] = ['openai', 'mcp', 'a2a'];

/**
 * OVER WHAT the address {@link endpointFor} resolves is dialed — the companion projection so
 * a caller learns both WHERE (the URL) and the transport, without re-implementing the
 * console's `wireFor` selection. Address-only, like everything here: it names a protocol, it
 * never opens one (ADR-0001 decisions 2-4).
 *
 * It honors `endpointFor`'s precedence: a capability's own `endpoint` first — named by the
 * provider endpoint that hosts it (the same URL equal to, or under, `endpoints.openai`/`mcp`/
 * `a2a`) — then `endpoints.mcp`, then `endpoints.a2a`. Returns `undefined` when the address
 * resolves to nothing dialable, or to a capability endpoint no published transport hosts:
 * the caller must not invent a transport any more than it invents an address.
 */
export function transportOf(
  address: ProviderAddress,
  capability?: Pick<Capability, 'endpoint'>,
): Transport | undefined {
  if (capability?.endpoint !== undefined) {
    return transportHosting(address.endpoints, capability.endpoint);
  }
  if (address.endpoints.mcp !== undefined) return 'mcp';
  if (address.endpoints.a2a !== undefined) return 'a2a';
  return undefined;
}

/** Which named transport an absolute capability endpoint is served under, if any. */
function transportHosting(
  endpoints: ProviderEndpoints,
  endpoint: string,
): Transport | undefined {
  for (const transport of NAMED_TRANSPORTS) {
    const base = endpoints[transport];
    if (base === undefined) continue;
    const boundary = base.endsWith('/') ? base : `${base}/`;
    if (endpoint === base || endpoint.startsWith(boundary)) return transport;
  }
  return undefined;
}
