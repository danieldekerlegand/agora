/**
 * The discovery registry — a thin index of KCB capability manifests (spec §3).
 *
 * Three invariants hold this file down:
 *
 * 1. **Route-by-lookup, never proxy** (ADR-0001 decision 3). Every query answers with a
 *    {@link ProviderAddress}; peers then connect *directly*. There is no `invoke`, no
 *    transport, no `fetch` of a payload here — and `proxiesTraffic` is asserted false in
 *    the tests so the invariant fails loudly if anyone adds one.
 * 2. **The provider's manifest is authoritative; this is a cache** (§3). `register`
 *    stores the manifest verbatim (frozen, so an index consumer cannot edit the record)
 *    and *replaces* rather than merges — the index never becomes a second opinion.
 * 3. **Zero-cost routes are preferred** (§3 delta K), and *unpriced* is not zero: a
 *    capability whose provider could not price it ranks after every priced one, or an
 *    unknown cost would masquerade as the cheapest route.
 */
import { addressOf, endpointFor, type ProviderAddress } from '@agora/kcb-client';
import {
  parseManifest,
  type Capability,
  type CapabilityManifest,
  type Plane,
  type Port,
} from '@agora/schemas';

import { compareByCost, costOf } from './cost.ts';
import { findCapabilityPath, type CapabilityPath, type PathQuery } from './path.ts';
import { matchesPort, type PortQuery } from './ports.ts';

/** How a manifest reached the index (§3 population: push register, or crawl). */
export type RegistrationSource = 'push' | 'pull';

/** One indexed provider. */
export interface Registration {
  identity: string;
  /** Exactly what the provider published, frozen. */
  manifest: CapabilityManifest;
  address: ProviderAddress;
  source: RegistrationSource;
  /** 1-based registration order — stable tie-break, and what "first entry" means. */
  sequence: number;
}

export interface RegisterOptions {
  source?: RegistrationSource;
}

/**
 * A discovery query. Every stated clause must hold (KCB §3: `find(port | plane | world |
 * capability)`); an empty query lists every provider.
 */
export interface FindQuery {
  /** Exact capability name, e.g. `generate.text`. */
  capability?: string;
  /** Any port on this plane, in either direction. */
  plane?: Plane;
  /** A port in either direction. */
  port?: PortQuery;
  /** A port the provider emits. */
  produces?: PortQuery;
  /** A port the provider accepts. */
  consumes?: PortQuery;
  /** A concrete world the provider serves material for (delta J). */
  world?: string;
}

/** A capability that answered the query, and where to dial it. */
export interface MatchedCapability {
  /** The invocable name, per KCB §2. */
  name: string;
  /** The address to connect to directly — never a route through the registry. */
  endpoint?: string | undefined;
  estUnits: number;
  unpriced: boolean;
  tier?: string | undefined;
}

/** A provider that answered the query. `address` is the whole point: peers dial it. */
export interface Match {
  identity: string;
  address: ProviderAddress;
  capabilities: MatchedCapability[];
  /** The cheapest matching capability's projection — the ranking key. */
  estUnits: number;
  /** True when nothing that matched carries a usable cost. */
  unpriced: boolean;
  registration: Registration;
}

export class CapabilityRegistry {
  /** ADR-0001 decision 3. Not a setting — a statement about what this service is. */
  readonly proxiesTraffic = false;

  private readonly entries = new Map<string, Registration>();
  private nextSequence = 1;

  /**
   * Index a manifest (§3 push population). Throws `ManifestError` on anything that is not
   * a readable KCB manifest — an unreadable entry would be handed to peers as an address.
   *
   * Re-registering an identity replaces its record wholesale and keeps its original
   * sequence: the provider is the authority on its own manifest, and a redeploy is not a
   * new provider.
   */
  register(manifest: unknown, options: RegisterOptions = {}): Registration {
    const parsed = parseManifest(manifest);
    const previous = this.entries.get(parsed.identity);
    const registration: Registration = {
      identity: parsed.identity,
      manifest: freezeCopy(parsed),
      address: addressOf(parsed),
      source: options.source ?? 'push',
      sequence: previous?.sequence ?? this.nextSequence++,
    };
    this.entries.set(parsed.identity, registration);
    return registration;
  }

  /** Drop a provider from the index. The provider itself is unaffected — this is a cache. */
  remove(identity: string): boolean {
    return this.entries.delete(identity);
  }

  get(identity: string): Registration | undefined {
    return this.entries.get(identity);
  }

  /** Every provider, in registration order. */
  list(): Registration[] {
    return [...this.entries.values()].sort((a, b) => a.sequence - b.sequence);
  }

  /** Where to dial a provider, by identity. The registry's whole job, in one call. */
  address(identity: string): ProviderAddress | undefined {
    return this.entries.get(identity)?.address;
  }

  /** `find(port | plane | world | capability)` → matching providers, ranked (§3). */
  find(query: FindQuery = {}): Match[] {
    const matches: Match[] = [];
    for (const registration of this.list()) {
      const capabilities = matchingCapabilities(registration, query);
      if (capabilities === undefined) continue;
      const ranked = [...capabilities].sort((a, b) =>
        compareByCost(
          { ...a, sequence: registration.sequence },
          { ...b, sequence: registration.sequence },
        ),
      );
      // No named capability means no declared price — findable, but never the cheap route.
      const cheapest = ranked[0] ?? { estUnits: 0, unpriced: true };
      matches.push({
        identity: registration.identity,
        address: registration.address,
        capabilities: ranked,
        estUnits: cheapest.estUnits,
        unpriced: cheapest.unpriced,
        registration,
      });
    }
    return matches.sort((a, b) =>
      compareByCost(
        { ...a, sequence: a.registration.sequence },
        { ...b, sequence: b.registration.sequence },
      ),
    );
  }

  /**
   * A capability path from one port to another, across providers (§3 composition).
   * Returns the plan — addresses to dial in order — never a route through here.
   */
  path(query: PathQuery): CapabilityPath | undefined {
    return findCapabilityPath(this.list(), query);
  }
}

export function createRegistry(): CapabilityRegistry {
  return new CapabilityRegistry();
}

/**
 * The capabilities of one provider that answer `query`, or `undefined` if the provider
 * does not match at all.
 *
 * An empty array is a real answer, not a miss: a provider that declares no capabilities is
 * still discoverable through its manifest-level `produces`/`consumes` (§2) — it can be
 * found and dialed, it just has nothing *named* to invoke, so a `capability` clause can
 * never match it and its cost is unknown.
 */
function matchingCapabilities(
  registration: Registration,
  query: FindQuery,
): MatchedCapability[] | undefined {
  const { manifest, address } = registration;
  const declared = manifest.capabilities ?? [];
  if (declared.length === 0) {
    if (query.capability !== undefined) return undefined;
    const matched = clausesHold(query, manifest.consumes ?? [], manifest.produces ?? []);
    return matched ? [] : undefined;
  }
  const matches = declared
    .filter((capability) => capabilityMatches(capability, query))
    .map((capability) => {
      const { units, unpriced } = costOf(capability);
      return {
        name: capability.name,
        endpoint: endpointFor(address, capability),
        estUnits: units,
        unpriced,
        tier: capability.cost?.tier,
      };
    });
  return matches.length === 0 ? undefined : matches;
}

function capabilityMatches(capability: Capability, query: FindQuery): boolean {
  if (query.capability !== undefined && capability.name !== query.capability) return false;
  return clausesHold(query, capability.inputs ?? [], capability.outputs ?? []);
}

function clausesHold(query: FindQuery, inputs: readonly Port[], outputs: readonly Port[]): boolean {
  const { produces, consumes, port, plane, world } = query;
  const both = [...inputs, ...outputs];
  if (produces !== undefined && !outputs.some((p) => matchesPort(p, produces))) return false;
  if (consumes !== undefined && !inputs.some((p) => matchesPort(p, consumes))) return false;
  if (port !== undefined && !both.some((p) => matchesPort(p, port))) return false;
  if (plane !== undefined && !both.some((p) => p.plane === plane)) return false;
  if (world !== undefined && !both.some((p) => matchesPort(p, { world }))) return false;
  return true;
}

/**
 * Store a manifest the index owns: a JSON round-trip (a manifest *is* JSON — it arrived
 * over the wire) so a later mutation by the registrant cannot rewrite the record, then
 * frozen so a consumer of the index cannot either. Both directions matter: the record has
 * to keep saying what the provider published.
 */
function freezeCopy(manifest: CapabilityManifest): CapabilityManifest {
  return deepFreeze(JSON.parse(JSON.stringify(manifest)) as CapabilityManifest);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
