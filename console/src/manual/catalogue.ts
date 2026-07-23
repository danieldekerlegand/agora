/**
 * The capability catalogue — what the registry advertises, arranged for a human to browse.
 *
 * This is the reading half of manual mode ("Postman for the fabric"): KCB §3's `find` is a
 * machine query, and an operator needs the same index laid out as *providers → capabilities
 * → plane-typed ports* so they can see what is offerable before composing anything. Nothing
 * here dials, and nothing here invents: every field is copied out of a manifest the provider
 * published, including the `endpoint` the caller will dial **directly** (ADR-0001 decision 3
 * — the registry hands back an address, never a route through itself).
 *
 * Stand-ins are catalogued too, and stamped. A peer that has not adopted the bus has no
 * registration, so without this the explorer could only ever offer the one provider that has
 * — and an operator would have no way to see the shape of a capability before its provider
 * ships it. {@link CataloguedProvider.standin} carries the fixture path so the UI can say
 * "this is a fixture" everywhere it says the capability's name (KCS delta N).
 */
import { addressOf, endpointFor } from '@agora/kcb-client';
import type { CapabilityRegistry } from '@agora/registry';
import {
  parseManifestBody,
  type Capability,
  type CapabilityManifest,
  type Json,
  type Plane,
  type Port,
} from '@agora/schemas';

import { VERB_ENDPOINTS } from '../kcs/link.ts';
import { parseFixture, type StandinFixture } from '../kcs/standin.ts';

/**
 * The verbs manual mode can compose. A subset of the KCS §3 vocabulary on purpose: `emit`
 * and `subscribe` write to, or hold open, somebody else's plane, and neither is a thing an
 * operator should do by filling in a form with no scenario asserting what it meant.
 */
export type ManualVerb = 'invoke' | 'fetch' | 'resolve';

/** How a port is filled in: an inline structural payload, or a KINP id (KCS §3). */
export type FieldEntry = 'value' | 'ref';

/** One row of the composer's form, derived entirely from one port's declared type. */
export interface PortField {
  port: Port;
  /** The port's own type vocabulary, as the label an operator reads. */
  label: string;
  entry: FieldEntry;
  /** Prompt text. Never a prefilled payload — see {@link fieldsFor}. */
  placeholder: string;
}

export interface CataloguedCapability {
  /** KINP identity of the provider that declares it. */
  provider: string;
  name: string;
  /** The address to dial for this capability, when the manifest names one. */
  endpoint?: string | undefined;
  inputs: Port[];
  outputs: Port[];
  /** Every plane it touches, in and out — KCB §2.1's cross-plane view of one capability. */
  planes: Plane[];
  estUnits?: number | undefined;
  /** True when the provider could not price it. Not the same as free (delta K). */
  unpriced: boolean;
  tier?: string | undefined;
  basis?: string | undefined;
}

export interface CataloguedProvider {
  identity: string;
  endpoints: Record<string, string>;
  /** What the provider says a caller must hold to be granted a call (KCB §2 `auth`). */
  grantsRequired: string[];
  /** The fixture this manifest came from, when the peer has not adopted the bus (delta N). */
  standin?: string | undefined;
  /** Which manual verbs this provider can actually serve. */
  verbs: ManualVerb[];
  capabilities: CataloguedCapability[];
}

export interface CatalogueSource {
  /** The console's own index, already crawled — the same one a scenario run discovers through. */
  registry: CapabilityRegistry;
  /** Fixture path → fixture document, for peers with no registration of their own. */
  standins?: Record<string, Json> | undefined;
}

/**
 * Everything on offer, registrations first and stand-ins after.
 *
 * A registration always wins over a fixture of the same identity, for the same reason the
 * runner prefers one (`kcs/runner.ts`): offering the fixture would let an operator "explore"
 * a provider that is right there on the network, and read the fixture's answer as the
 * fabric's.
 */
export function catalogue(source: CatalogueSource): CataloguedProvider[] {
  const providers: CataloguedProvider[] = [];
  const seen = new Set<string>();
  for (const registration of source.registry.list()) {
    providers.push(describe(registration.manifest, undefined));
    seen.add(registration.identity);
  }
  for (const [path, document] of Object.entries(source.standins ?? {})) {
    const published = manifestIn(document, path);
    if (published === undefined || seen.has(published.manifest.identity)) continue;
    seen.add(published.manifest.identity);
    providers.push(describe(published.manifest, path, published.fixture));
  }
  return providers;
}

/** The manifest a stand-in fixture publishes on its peer's behalf, when it publishes one. */
function manifestIn(
  document: Json,
  path: string,
): { fixture: StandinFixture; manifest: CapabilityManifest } | undefined {
  try {
    const fixture = parseFixture(document, path);
    if (fixture.manifest === undefined) return undefined;
    return { fixture, manifest: parseManifestBody(fixture.manifest) };
  } catch {
    // A fixture that does not carry a readable manifest is simply not browsable. It is not
    // an error here: it may still be perfectly good at standing in for a scenario's peer.
    return undefined;
  }
}

function describe(
  manifest: CapabilityManifest,
  standin: string | undefined,
  fixture?: StandinFixture,
): CataloguedProvider {
  const capabilities = (manifest.capabilities ?? []).map((capability) =>
    describeCapability(manifest, capability),
  );
  const verbs: ManualVerb[] = [];
  if (capabilities.length > 0) verbs.push('invoke');
  if (servesFetch(manifest, fixture)) verbs.push('fetch');
  return {
    identity: manifest.identity,
    endpoints: { ...manifest.endpoints },
    grantsRequired: [...(manifest.auth?.grants_required ?? [])],
    ...(standin === undefined ? {} : { standin }),
    verbs,
    capabilities,
  };
}

/**
 * Whether `fetch` is composable against this provider: it publishes a CAS address, or — for
 * a stand-in — its fixture covers some asset. Offering the verb otherwise would compose a
 * request that can only ever come back `NoAddressError`.
 */
function servesFetch(manifest: CapabilityManifest, fixture: StandinFixture | undefined): boolean {
  if (fixture !== undefined) return Object.keys(fixture.fetch ?? {}).length > 0;
  return VERB_ENDPOINTS.fetch.some((name) => {
    const endpoint = manifest.endpoints[name];
    return typeof endpoint === 'string' && endpoint !== '';
  });
}

function describeCapability(
  manifest: CapabilityManifest,
  capability: Capability,
): CataloguedCapability {
  const inputs = capability.inputs ?? [];
  const outputs = capability.outputs ?? [];
  return {
    provider: manifest.identity,
    name: capability.name,
    endpoint: endpointFor(addressOf(manifest), capability),
    inputs,
    outputs,
    planes: [...new Set([...inputs, ...outputs].map((port) => port.plane))],
    estUnits: capability.cost?.est_units,
    unpriced: capability.cost === undefined || capability.cost.unpriced === true,
    tier: capability.cost?.tier,
    basis: capability.cost?.basis,
  };
}

/**
 * The composer's form for one capability, derived from its input ports and nothing else.
 *
 * Two things come out of the port's own declaration. The **label** is its type vocabulary —
 * the plane plus whatever that plane types by (§2.1), so an operator reads what the provider
 * declared rather than a console's paraphrase. The **entry** is whether this port is filled
 * with a payload or with an id: entity and media ports take a KINP id, because §3 is explicit
 * that payloads "reference things by KINP id … never inline blobs", and a media port offering
 * a textarea would be an invitation to break that.
 *
 * Nothing is prefilled. A skeleton payload is a guess at what the operator meant, and the
 * console would then be observing traffic it half-authored.
 */
export function fieldsFor(capability: CataloguedCapability): PortField[] {
  return capability.inputs.map((port) => {
    const entry: FieldEntry = port.plane === 'knowledge' ? 'value' : 'ref';
    return {
      port,
      label: describePort(port),
      entry,
      placeholder:
        entry === 'ref' ? 'a KINP id' : `JSON for a ${describePort(port)} payload`,
    };
  });
}

/** One port as its declared type reads — the plane, then what that plane types by (§2.1). */
export function describePort(port: Port): string {
  if (port.plane === 'media') {
    const world = port.world_pattern === undefined ? '' : ` · worlds ${port.world_pattern}`;
    return `media · ${port.media_types.join(', ')}${world}`;
  }
  if (port.plane === 'entity') return `entity · ${port.types.join(', ')}`;
  const parts = [
    port.shape === undefined ? undefined : `shape ${port.shape}`,
    port.dialect === undefined ? undefined : `dialect ${port.dialect}`,
    port.worlds === undefined ? undefined : `worlds ${port.worlds.join(', ')}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'knowledge' : `knowledge · ${parts.join(' · ')}`;
}
