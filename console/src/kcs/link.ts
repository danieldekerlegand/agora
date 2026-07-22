/**
 * A direct link to one participant.
 *
 * ADR-0001 decision 7 in code: the console opens the same connection production opens, to
 * the address the registry handed back, and records both directions. Nothing is relayed on
 * anyone's behalf and no traffic passes through the registry — this module is the only
 * place the console dials anybody, and it dials the provider itself.
 *
 * A refusal is a first-class outcome, not an exception to be swallowed: KCS delta O makes
 * "was correctly refused" an assertable property, so {@link RefusedError} carries the
 * status and the provider's own reason into the report.
 */
import { endpointFor, type ProviderAddress } from '@agora/kcb-client';
import type { Registration } from '@agora/registry';
import type { Capability, Json, JsonObject, Plane } from '@agora/schemas';
import { isJsonObject } from '@agora/schemas';

import { noFacts, readFacts, type Facts, type ObservedAsset } from './facts.ts';
import { detail, type ObservationLog } from './log.ts';
import type { HttpFetch, HttpResponse } from './http.ts';
import { wireFor, type InvocationResult, type Wire } from './wire.ts';

/** The provider refused the call (an over-ceiling invoke, an unauthorized fetch, a 4xx). */
export class RefusedError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`refused with ${status}: ${reason}`);
    this.name = 'RefusedError';
  }
}

/** Thrown when a capability a scenario names is not one the provider declares. */
export class UnknownCapabilityError extends Error {
  constructor(identity: string, capability: string) {
    super(`${identity} declares no capability ${capability}`);
    this.name = 'UnknownCapabilityError';
  }
}

/**
 * Thrown when a scenario asks for a verb the provider publishes no address for.
 *
 * Deliberately *not* a {@link RefusedError}: nobody refused anything. A provider with no
 * CAS address has not denied the fetch, it has not offered one — and a step declaring
 * `expect: reject` must not go green on a peer that was never asked.
 */
export class NoAddressError extends Error {
  constructor(identity: string, verb: string, named: string) {
    super(`${identity} publishes no \`${named}\` address — nothing to ${verb} against`);
    this.name = 'NoAddressError';
  }
}

export interface LinkOptions {
  fetch: HttpFetch;
  log: ObservationLog;
}

/** One plane-typed input, bindings already resolved by the runner. */
export interface ResolvedInput {
  plane: Plane;
  shape?: string | undefined;
  value?: Json | undefined;
}

export interface InvokeRequest {
  /** The step id, so every observation is attributable. */
  step: string;
  capability: string;
  inputs: ResolvedInput[];
  options: JsonObject;
  budgetUnits?: number | undefined;
  signal?: AbortSignal | undefined;
}

/** Retrieve asset bytes by id — a CAS GET (KCB §4 delta G, KMI §7). */
export interface FetchRequest {
  step: string;
  asset: string;
  signal?: AbortSignal | undefined;
}

/** Register for a world or capability and collect what streams back (KCB §4, KGP §6). */
export interface SubscribeRequest {
  step: string;
  world?: string | undefined;
  capability?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** What a subscription delivered, by reference — frames are logged, never accumulated. */
export interface Subscription {
  /** The registration handle the producer returned, when it named one. */
  subscription?: string | undefined;
  frames: number;
  claims: string[];
  assets: string[];
  worlds: string[];
}

/** Write a GroundingPack / assertion into the fabric (KGP §2, §6). */
export interface EmitRequest {
  step: string;
  pack?: Json | undefined;
  claim?: Json | undefined;
  signal?: AbortSignal | undefined;
}

export interface EmitReceipt {
  /** The content-addressed pack id the producer minted (KGP §2.1). */
  pack_id?: string | undefined;
  claims: string[];
}

/**
 * One participant, as the runner talks to it.
 *
 * The verbs are KCB §4's, minus `discover`/`describe` (the registry's job, already done by
 * the time a peer exists). A {@link Link} is the live implementation; a stand-in
 * (delta N) is the other, and the runner cannot tell them apart — which is the point:
 * a scenario is written once and a peer's adoption of the bus changes nothing but the
 * `stubbed` flag on the report.
 */
export interface Peer {
  readonly identity: string;
  /** True when this is a fixture standing in for a peer that has not adopted the bus. */
  readonly stubbed: boolean;
  /** How the report describes the connection. */
  readonly note: string;
  invoke(request: InvokeRequest): Promise<InvocationResult>;
  fetchAsset(request: FetchRequest): Promise<ObservedAsset>;
  subscribe(request: SubscribeRequest): Promise<Subscription>;
  emit(request: EmitRequest): Promise<EmitReceipt>;
}

/** Where the console looks for each verb in a provider's published endpoints (KCB §2). */
export const VERB_ENDPOINTS: Record<'fetch' | 'subscribe' | 'emit', readonly string[]> = {
  fetch: ['cas', 'fetch'],
  subscribe: ['subscribe', 'stream'],
  emit: ['emit', 'kgp'],
};

export class Link implements Peer {
  readonly identity: string;
  readonly address: ProviderAddress;
  readonly stubbed = false;

  constructor(
    private readonly registration: Registration,
    private readonly options: LinkOptions,
  ) {
    this.identity = registration.identity;
    this.address = registration.address;
  }

  /**
   * The wire this peer's `invoke` speaks, or `undefined` when this build speaks none of
   * the transports it advertises.
   *
   * Lazy, because a peer may serve the data-plane verbs and no invocable capability at
   * all — a CAS is a legitimate participant. Resolving the wire eagerly would refuse to
   * open a link to one, which would make `fetch` unreachable for exactly the providers
   * that exist to serve it.
   */
  get wire(): Wire | undefined {
    try {
      return wireFor(this.registration.manifest);
    } catch {
      return undefined;
    }
  }

  get note(): string {
    const wire = this.wire;
    return wire === undefined
      ? `dialed directly at ${Object.keys(this.address.endpoints).join(', ')}`
      : `dialed directly over the ${wire.name} wire`;
  }

  /** The capability as its provider declares it — the manifest is authoritative (KCB §3). */
  capability(name: string): Capability {
    const declared = this.registration.manifest.capabilities ?? [];
    const found = declared.find((entry) => entry.name === name);
    if (found === undefined) throw new UnknownCapabilityError(this.identity, name);
    return found;
  }

  async invoke(request: InvokeRequest): Promise<InvocationResult> {
    const capability = this.capability(request.capability);
    const endpoint = endpointFor(this.address, capability);
    if (endpoint === undefined) {
      throw new NoAddressError(this.identity, 'invoke', request.capability);
    }
    // Refused rather than absent when the transport is unknown (US-AG5): the day a peer
    // advertises `mcp`, the report says which wire to write instead of mis-dialing it.
    const wire = wireFor(this.registration.manifest);
    const call = wire.request({
      manifest: this.registration.manifest,
      capability,
      endpoint,
      inputs: request.inputs,
      options: request.options,
      budgetUnits: request.budgetUnits,
    });
    const plane = request.inputs[0]?.plane;
    this.options.log.record({
      step: request.step,
      participant: this.identity,
      direction: 'request',
      plane,
      entities: [this.identity],
      detail: detail({
        wire: wire.name,
        capability: request.capability,
        endpoint: call.url,
        budget_units: request.budgetUnits ?? null,
      }),
    });

    const response = await this.options.fetch(call.url, {
      method: call.method,
      headers: call.headers,
      body: JSON.stringify(call.body),
      signal: request.signal,
    });
    const body = await response.json();
    if (!response.ok) {
      const reason = refusalReason(body);
      this.options.log.record({
        step: request.step,
        participant: this.identity,
        direction: 'response',
        plane,
        entities: [this.identity],
        detail: detail({ status: response.status, refused: true, reason }),
      });
      throw new RefusedError(response.status, reason);
    }
    if (!isJsonObject(body)) {
      throw new RefusedError(response.status, 'provider returned a non-object body');
    }
    const result = wire.read(body);
    this.options.log.record({
      step: request.step,
      participant: this.identity,
      direction: 'response',
      plane,
      entities: [this.identity],
      detail: detail({
        status: response.status,
        tier: result.tier,
        provider: result.provider,
        model: result.model,
        actual_units: result.cost?.actual_units,
        projected_units: result.cost?.projected_units,
        // Ids and summaries only — bytes are fetched by id (KMI §7), never logged.
        assets: result.assets?.map((asset) => asset.media_type) ?? undefined,
      }),
      // A capability may answer on the knowledge or media plane (KCB §2.1 delta F), so an
      // invoke's response is read for claims and assets exactly like a subscription's.
      facts: readFacts(body),
    });
    return result;
  }

  /**
   * A CAS GET by asset id (KCB §4 delta G). The id *is* the hash (KMI §7), so integrity
   * is self-verifying: a store that answers with a different id than the one asked for has
   * not served this asset, and that is an error rather than a result.
   *
   * A missing asset is **not** an error of that kind. A reference can legitimately arrive
   * before its bytes propagate (KCB delta L), so 404/410 is recorded as a dangling
   * reference and refused — a scenario declares `expect: reject` and asserts
   * `dangling_ref_tolerated`, which is how tolerance becomes a tested property instead of
   * a hope.
   */
  async fetchAsset(request: FetchRequest): Promise<ObservedAsset> {
    const base = this.endpointNamed('fetch');
    const url = `${base.replace(/\/$/, '')}/${encodeURIComponent(request.asset)}`;
    this.options.log.record({
      step: request.step,
      participant: this.identity,
      direction: 'request',
      plane: 'media',
      entities: [this.identity, request.asset],
      detail: detail({ verb: 'fetch', asset: request.asset, endpoint: url }),
    });
    const response = await this.options.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: request.signal,
    });
    const body = await response.json();
    if (!response.ok) {
      const dangling = response.status === 404 || response.status === 410;
      const reason = refusalReason(body);
      this.options.log.record({
        step: request.step,
        participant: this.identity,
        direction: 'response',
        plane: 'media',
        entities: [this.identity, request.asset],
        detail: detail({ status: response.status, refused: true, dangling, reason }),
        facts: {
          ...noFacts(),
          assets: [{ id: request.asset, attaches_to: [], constituents: [], present: !dangling }],
        },
      });
      throw new RefusedError(response.status, reason);
    }
    const asset = assetFrom(readFacts(body as Json), request.asset, this.identity);
    this.options.log.record({
      step: request.step,
      participant: this.identity,
      direction: 'response',
      plane: 'media',
      entities: [this.identity, asset.id],
      detail: detail({
        status: response.status,
        asset: asset.id,
        media_type: asset.media_type,
        // The byte count, never the bytes: the log holds references (KMI §7).
        bytes: asset.bytes,
        source_world: asset.source_world === undefined ? undefined : asset.source_world,
      }),
      facts: readFacts(body as Json),
    });
    return asset;
  }

  /**
   * Register for a world or capability and record the deltas that come back (KCB §4).
   *
   * The console subscribes on its **own** behalf — it is a consumer like any other, not a
   * tap on somebody else's stream (ADR-0001 decision 7). Frames are recorded as they are
   * read and summarised by id; the console never becomes the place the data lives.
   */
  async subscribe(request: SubscribeRequest): Promise<Subscription> {
    const url = this.endpointNamed('subscribe');
    const body: JsonObject = {};
    if (request.world !== undefined) body.world = request.world;
    if (request.capability !== undefined) body.capability = request.capability;
    this.options.log.record({
      step: request.step,
      participant: this.identity,
      direction: 'request',
      plane: 'knowledge',
      entities: [this.identity, ...(request.world === undefined ? [] : [request.world])],
      detail: detail({ verb: 'subscribe', endpoint: url, ...body }),
    });
    const response = await this.options.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) {
      const reason = refusalReason(await response.json());
      this.options.log.record({
        step: request.step,
        participant: this.identity,
        direction: 'response',
        plane: 'knowledge',
        entities: [this.identity],
        detail: detail({ status: response.status, refused: true, reason }),
      });
      throw new RefusedError(response.status, reason);
    }
    const stream = await readStream(response);
    return this.recordFrames(request, stream);
  }

  /** Write a pack or a claim into the fabric and record what the producer minted (KGP). */
  async emit(request: EmitRequest): Promise<EmitReceipt> {
    const url = this.endpointNamed('emit');
    const payload: JsonObject = {};
    if (request.pack !== undefined) payload.pack = request.pack;
    if (request.claim !== undefined) payload.claim = request.claim;
    const outgoing = readFacts(payload as Json);
    this.options.log.record({
      step: request.step,
      participant: this.identity,
      direction: 'request',
      plane: 'knowledge',
      entities: [this.identity],
      detail: detail({ verb: 'emit', endpoint: url, claims: outgoing.claims.length }),
      // The emitted claims are facts the run observed too — a scenario that emits into a
      // world and asserts `claim_in_world` is asserting about this entry.
      facts: outgoing,
    });
    const response = await this.options.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: request.signal,
    });
    const body = await response.json();
    if (!response.ok) {
      const reason = refusalReason(body);
      this.options.log.record({
        step: request.step,
        participant: this.identity,
        direction: 'response',
        plane: 'knowledge',
        entities: [this.identity],
        detail: detail({ status: response.status, refused: true, reason }),
      });
      throw new RefusedError(response.status, reason);
    }
    const facts = readFacts(body as Json);
    const receipt = receiptFrom(facts);
    this.options.log.record({
      step: request.step,
      participant: this.identity,
      direction: 'response',
      plane: 'knowledge',
      entities: [this.identity],
      detail: detail({ status: response.status, pack_id: receipt.pack_id ?? null }),
      facts,
    });
    return receipt;
  }

  /** Record each frame as it arrives, and summarise the stream by reference. */
  private recordFrames(
    request: SubscribeRequest,
    stream: { subscription?: string | undefined; frames: Json[] },
  ): Subscription {
    const summary: Subscription = {
      subscription: stream.subscription,
      frames: stream.frames.length,
      claims: [],
      assets: [],
      worlds: [],
    };
    for (const frame of stream.frames) {
      const facts = readFacts(frame);
      this.options.log.record({
        step: request.step,
        participant: this.identity,
        direction: 'frame',
        plane: facts.assets.length > 0 && facts.claims.length === 0 ? 'media' : 'knowledge',
        entities: [this.identity],
        detail: detail({
          claims: facts.claims.length,
          assets: facts.assets.length,
          packs: facts.packs.length,
        }),
        facts,
      });
      collect(summary, facts);
    }
    return summary;
  }

  /** The address a verb is served at, or a clear failure — never an invented one. */
  private endpointNamed(verb: 'fetch' | 'subscribe' | 'emit'): string {
    for (const name of VERB_ENDPOINTS[verb]) {
      const endpoint = this.address.endpoints[name];
      if (typeof endpoint === 'string' && endpoint !== '') return endpoint;
    }
    throw new NoAddressError(this.identity, verb, VERB_ENDPOINTS[verb][0] as string);
  }
}

export function openLink(registration: Registration, options: LinkOptions): Link {
  return new Link(registration, options);
}

/**
 * The asset a CAS answered with, checked against the one that was asked for.
 *
 * The id is the hash of the bytes, so "the store returned a different id" is the only
 * integrity check a reference-by-id protocol needs — and the only one available to a
 * console that deliberately never holds the bytes.
 */
export function assetFrom(facts: Facts, requested: string, identity: string): ObservedAsset {
  const [envelope] = facts.assets;
  if (envelope === undefined) {
    // No envelope: the store served the bytes and said nothing about them. The reference
    // is what was asked for, so that is what is recorded — nothing is inferred.
    return { id: requested, attaches_to: [], constituents: [], present: true };
  }
  if (envelope.id !== requested) {
    throw new Error(`${identity} answered a fetch of ${requested} with ${envelope.id}`);
  }
  return envelope;
}

/** What an emit receipt says was minted (KGP §2.1) — ids, never the pack itself. */
export function receiptFrom(facts: Facts): EmitReceipt {
  const receipt: EmitReceipt = {
    claims: facts.claims.map((claim) => claim.id).filter((id): id is string => id !== undefined),
  };
  const [pack] = facts.packs;
  if (pack !== undefined) receipt.pack_id = pack;
  return receipt;
}

/** Fold one frame's facts into a subscription summary, by id. */
export function collect(summary: Subscription, facts: Facts): void {
  for (const claim of facts.claims) {
    if (claim.id !== undefined && !summary.claims.includes(claim.id)) summary.claims.push(claim.id);
    if (claim.world !== undefined && !summary.worlds.includes(claim.world)) {
      summary.worlds.push(claim.world);
    }
  }
  for (const asset of facts.assets) {
    if (!summary.assets.includes(asset.id)) summary.assets.push(asset.id);
  }
}

/**
 * A delta stream, read whichever way the producer serves it.
 *
 * NDJSON and SSE are sequences of JSON documents, so `json()` cannot read them; a producer
 * that answers one JSON body with a `frames`/`deltas` array is equally conformant (KCB §4
 * fixes the verb, not the framing). Both are read here so a scenario does not have to
 * know which its peer chose.
 */
export async function readStream(
  response: HttpResponse,
): Promise<{ subscription?: string | undefined; frames: Json[] }> {
  const contentType = response.headers.get('content-type') ?? '';
  if (/ndjson|event-stream/.test(contentType) && response.text !== undefined) {
    return { frames: parseFrames(await response.text()) };
  }
  const body = await response.json();
  if (!isJsonObject(body)) return { frames: Array.isArray(body) ? (body as Json[]) : [] };
  const framing = ['frames', 'deltas', 'events'].map((key) => body[key]).find(Array.isArray);
  const subscription = typeof body.subscription === 'string' ? body.subscription : undefined;
  return { subscription, frames: framing ?? [body] };
}

/** NDJSON, or SSE `data:` lines. A frame that does not parse is dropped, not thrown on. */
function parseFrames(text: string): Json[] {
  const frames: Json[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim();
    if (line === '' || line.startsWith(':')) continue;
    try {
      frames.push(JSON.parse(line) as Json);
    } catch {
      continue;
    }
  }
  return frames;
}

/** The provider's own words for why it refused, when it gave any. */
function refusalReason(body: unknown): string {
  if (isJsonObject(body)) {
    if (typeof body.detail === 'string') return body.detail;
    if (isJsonObject(body.error) && typeof body.error.message === 'string') return body.error.message;
  }
  return 'no reason given';
}
