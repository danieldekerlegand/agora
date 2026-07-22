/**
 * KCB client — the shared way for a peer to *find* another peer.
 *
 * ADR-0001 decisions 2-4: the registry hands back **addresses**; the caller then dials
 * the provider directly over MCP/A2A. This client therefore only ever returns endpoints —
 * it must never grow a "call it for me" method that relays a payload, or the commons
 * becomes the traffic hub the ADR rejects.
 *
 * The lookup verbs land with the registry (US-AG4); this module currently defines the
 * address shape every area agrees on.
 */
import { SPEC_VERSIONS } from '@agora/schemas';

/** The endpoints a KCB provider publishes (capability-bus.md §2). */
export interface ProviderEndpoints {
  /** MCP server exposing the provider's tools. */
  mcp?: string;
  /** A2A agent card. */
  a2a?: string;
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
  return Boolean(address.endpoints.mcp ?? address.endpoints.a2a);
}
