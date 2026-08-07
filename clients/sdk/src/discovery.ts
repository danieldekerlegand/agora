/**
 * The discovery client — publish your manifest to a KCB registry, and find a peer through it.
 *
 * A producer becomes findable one of two ways (capability-bus.md §3): a registry **crawls** the
 * manifest you serve at your well-known path, or you **push** it. Crawling needs the registry to
 * be able to reach you; pushing is the path that works from behind a NAT, from a short-lived job,
 * or from any producer that would rather announce itself than wait to be found. This is that push
 * path plus the lookup verbs a caller needs afterwards — over HTTP, because the registry's
 * in-process API lives in a workspace package no out-of-tree consumer installs, and a producer
 * holding only `@agora/sdk` could otherwise not join the index at all.
 *
 * **It speaks to the control plane and to nothing else.** What crosses this client is a manifest,
 * a query, an identity; what comes back is an ADDRESS the caller dials *itself*, directly
 * (ADR-0001 decisions 2–4). {@link DISCOVERY_ROUTES} is the complete list of routes it will ever
 * dial, and every one of them is a lookup verb the registry already names in its own
 * `describe()` — there is no route here that carries a peer's payload, and the registry has none
 * to offer it: `proxiesTraffic` is `false`, and {@link DiscoveryClient.describe} lets a producer
 * confirm that about a strange registry *before* it publishes anything to it.
 *
 * The provider's manifest stays authoritative (§3: the index is a cache). So a result's address
 * is projected *here*, by {@link addressOf}, from the manifest the registry handed back — an
 * index cannot answer with an address the provider never published.
 */
import { parseManifestBody, type CapabilityManifest, type Plane } from '@agora/schemas';

import { addressOf, type ProviderAddress } from './kcb.ts';

/**
 * Every route this client dials, by the verb it serves. Discovery only — an entry here that
 * relayed a payload would be a change to the topology, not to a library.
 */
export const DISCOVERY_ROUTES = {
  /** GET — identity, KCB version, verbs, and `proxiesTraffic`. */
  describe: '/describe',
  /** POST — index a manifest (§3 push population). */
  publish: '/register',
  /** POST — drop an identity from the index. The provider itself is untouched. */
  withdraw: '/remove',
  /** POST — ranked matches, each carrying the address to dial. */
  find: '/find',
  /** GET — where one identity is dialed. */
  address: '/address',
} as const;

/** The slice of `fetch` a discovery call needs — structural, so a test can pass three lines. */
export type DiscoveryFetch = (
  url: string,
  init?: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface DiscoveryOptions {
  fetch?: DiscoveryFetch;
}

/**
 * Thrown when a registry could not be reached, refused a call, or answered something this
 * client cannot read. A malformed *manifest* throws `@agora/schemas`'s `ManifestError` instead.
 *
 * `url` and `status` are declared fields assigned in the constructor rather than TypeScript
 * *parameter properties*: Node's strip-only loader refuses those, and the SDK's source is what
 * `node participant.ts` runs (see `RegistryFetchError`).
 */
export class DiscoveryError extends Error {
  /** The registry route the call was dialing when it failed. */
  readonly url: string;
  /** The HTTP status, when the registry answered at all. */
  readonly status: number | undefined;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = 'DiscoveryError';
    this.url = url;
    this.status = status;
  }
}

/** What a registry says about itself (KCB §3). `proxiesTraffic` is the invariant worth checking. */
export interface RegistryDescription {
  identity: string;
  kcbVersion: string;
  /** `false` on any conformant registry — ADR-0001 decision 3. */
  proxiesTraffic: boolean;
  verbs: readonly string[];
}

/** The receipt for a published manifest: you are in the index, under this identity. */
export interface PublishedRegistration {
  identity: string;
  /** Projected from the manifest you published — what callers will be handed. */
  address: ProviderAddress;
  /** How the manifest reached the index: `push` for this client, `pull` for a crawl. */
  source: string;
  /** Registration order in the index; stable across re-publishing the same identity. */
  sequence: number;
}

/** One capability that answered a query, with the index's cost projection over it. */
export interface DiscoveredCapability {
  name: string;
  /** Where this capability is dialed, when it names its own endpoint. */
  endpoint?: string | undefined;
  estUnits: number;
  /** True when the provider could not price it — ranked last, never read as free (§3 delta K). */
  unpriced: boolean;
  tier?: string | undefined;
}

/** A provider that answered a query. The address is the point: you dial it, directly. */
export interface DiscoveredProvider {
  identity: string;
  address: ProviderAddress;
  capabilities: readonly DiscoveredCapability[];
  /** The cheapest matching capability's projection — the ranking key. */
  estUnits: number;
  unpriced: boolean;
  /** The provider's own manifest, as the registry stored it, re-validated on arrival. */
  manifest: CapabilityManifest;
}

/** The scalar clauses of a KCB §3 `find`. Every stated clause must hold. */
export interface DiscoveryQuery {
  /** Exact capability name, e.g. `summarize.text`. */
  capability?: string;
  /** Any port on this plane, in either direction. */
  plane?: Plane;
  /** A concrete world the provider serves material for. */
  world?: string;
}

/** A registry, reachable over HTTP. Discovery verbs only — see {@link DISCOVERY_ROUTES}. */
export interface DiscoveryClient {
  /** The registry this client talks to, normalized (no trailing slash). */
  readonly registryUrl: string;
  /** What the registry is, in its own words — check `proxiesTraffic` before you trust it. */
  describe(): Promise<RegistryDescription>;
  /**
   * Push your manifest into the index (§3). Validated locally first, by the same parser the
   * registry uses, so a malformed manifest fails in your process instead of over the wire.
   * Re-publishing an identity replaces its record: a redeploy is not a new provider.
   */
  publish(manifest: unknown): Promise<PublishedRegistration>;
  /** Drop an identity from the index. `false` when it was not there. The provider is untouched. */
  withdraw(identity: string): Promise<boolean>;
  /** Ranked matches for a query; an empty query lists every provider. */
  find(query?: DiscoveryQuery): Promise<readonly DiscoveredProvider[]>;
  /** Where one identity is dialed, or `undefined` when the index does not know it. */
  address(identity: string): Promise<ProviderAddress | undefined>;
}

/**
 * Build a client against a registry's base URL. Nothing is dialed until a verb is called; the
 * `fetch` defaults to the global one, and is structural so a test can pass its own.
 */
export function createDiscoveryClient(
  registryUrl: string,
  options: DiscoveryOptions = {},
): DiscoveryClient {
  const base = registryUrl.replace(/\/+$/, '');
  const http = options.fetch ?? (globalThis as { fetch?: DiscoveryFetch }).fetch;

  async function exchange(
    route: string,
    init?: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ url: string; status: number; body: string }> {
    const url = `${base}${route}`;
    if (http === undefined) throw new DiscoveryError('no fetch implementation available', url);
    let response;
    try {
      response = await (init === undefined ? http(url) : http(url, init));
    } catch (err) {
      throw new DiscoveryError(`registry could not be reached: ${reasonOf(err)}`, url);
    }
    return { url, status: response.status, body: await response.text() };
  }

  /** An exchange whose only acceptable answer is a JSON body — anything else is an error. */
  async function json(
    route: string,
    payload?: unknown,
  ): Promise<{ url: string; value: unknown }> {
    const init =
      payload === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          };
    const { url, status, body } = await exchange(route, init);
    if (status >= 400) throw refusal(url, status, body);
    return { url, value: parseJson(url, body) };
  }

  return {
    registryUrl: base,

    async describe(): Promise<RegistryDescription> {
      const { url, value } = await json(DISCOVERY_ROUTES.describe);
      const described = asObject(value, url, 'a registry description');
      return {
        identity: asString(described.identity, url, 'identity'),
        kcbVersion: asString(described.kcbVersion, url, 'kcbVersion'),
        proxiesTraffic: described.proxiesTraffic === true,
        verbs: Array.isArray(described.verbs) ? described.verbs.map(String) : [],
      };
    },

    async publish(manifest: unknown): Promise<PublishedRegistration> {
      // The producer's own document is the authority; parse it here so an unreadable manifest
      // is the producer's error, raised where it can be fixed, not a 400 from a stranger.
      const parsed = parseManifestBody(manifest);
      const { url, value } = await json(DISCOVERY_ROUTES.publish, parsed);
      const registration = asObject(value, url, 'a registration');
      const indexed = asString(registration.identity, url, 'identity');
      if (indexed !== parsed.identity) {
        throw new DiscoveryError(
          `published ${parsed.identity} but the registry indexed ${indexed}`,
          url,
        );
      }
      return {
        identity: parsed.identity,
        address: addressOf(parsed),
        source: typeof registration.source === 'string' ? registration.source : 'push',
        sequence: typeof registration.sequence === 'number' ? registration.sequence : 0,
      };
    },

    async withdraw(identity: string): Promise<boolean> {
      const { url, value } = await json(DISCOVERY_ROUTES.withdraw, { identity });
      return asObject(value, url, 'a removal result').removed === true;
    },

    async find(query: DiscoveryQuery = {}): Promise<readonly DiscoveredProvider[]> {
      const { url, value } = await json(DISCOVERY_ROUTES.find, query);
      if (!Array.isArray(value)) {
        throw new DiscoveryError('registry answered a find with something other than a list', url);
      }
      return value.map((match) => providerFrom(match, url));
    },

    async address(identity: string): Promise<ProviderAddress | undefined> {
      const route = `${DISCOVERY_ROUTES.address}?identity=${encodeURIComponent(identity)}`;
      const { url, status, body } = await exchange(route);
      // Not in the index is an answer, not a failure — and not an invitation to invent one.
      if (status === 404) return undefined;
      if (status >= 400) throw refusal(url, status, body);
      const address = asObject(parseJson(url, body), url, 'an address');
      return {
        identity: asString(address.identity, url, 'identity'),
        endpoints: endpointsFrom(address.endpoints),
      };
    },
  };
}

/**
 * A match, read as the provider's own document. `registration.manifest` is what the provider
 * published, so the address is re-projected from it rather than taken from the index's copy.
 */
function providerFrom(value: unknown, url: string): DiscoveredProvider {
  const match = asObject(value, url, 'a match');
  const registration = asObject(match.registration, url, 'a match registration');
  const manifest = parseManifestBody(registration.manifest);
  const capabilities = Array.isArray(match.capabilities) ? match.capabilities : [];
  return {
    identity: manifest.identity,
    address: addressOf(manifest),
    capabilities: capabilities.map((capability) => capabilityFrom(capability, url)),
    estUnits: numberOr(match.estUnits, 0),
    unpriced: match.unpriced === true,
    manifest,
  };
}

function capabilityFrom(value: unknown, url: string): DiscoveredCapability {
  const capability = asObject(value, url, 'a matched capability');
  return {
    name: asString(capability.name, url, 'capability name'),
    endpoint: typeof capability.endpoint === 'string' ? capability.endpoint : undefined,
    estUnits: numberOr(capability.estUnits, 0),
    unpriced: capability.unpriced === true,
    tier: typeof capability.tier === 'string' ? capability.tier : undefined,
  };
}

/** The endpoints an address carries, keeping only the string-valued ones. */
function endpointsFrom(value: unknown): Record<string, string> {
  const endpoints: Record<string, string> = {};
  if (typeof value !== 'object' || value === null) return endpoints;
  for (const [name, endpoint] of Object.entries(value as Record<string, unknown>)) {
    if (typeof endpoint === 'string') endpoints[name] = endpoint;
  }
  return endpoints;
}

/** The registry's own words about a refusal, when it sent any. */
function refusal(url: string, status: number, body: string): DiscoveryError {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === 'string') detail = parsed.message;
    else if (typeof parsed.error === 'string') detail = parsed.error;
  } catch {
    // Not JSON — the truncated body is the best detail there is.
  }
  return new DiscoveryError(
    detail === '' ? `registry answered ${String(status)}` : detail,
    url,
    status,
  );
}

function parseJson(url: string, body: string): unknown {
  try {
    return body === '' ? undefined : JSON.parse(body);
  } catch {
    throw new DiscoveryError('registry answered with something that is not JSON', url);
  }
}

function asObject(value: unknown, url: string, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DiscoveryError(`registry did not answer with ${what}`, url);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, url: string, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new DiscoveryError(`registry answered without a ${field}`, url);
  }
  return value;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
