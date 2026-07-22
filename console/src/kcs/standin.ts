/**
 * A stand-in participant — KCS §2 delta N.
 *
 * "A participant a scenario needs **before it has adopted the bus** MAY declare a
 * `standin`; the console uses it in place of a live endpoint and records that the
 * participant was stubbed." Four of the five platforms have not adopted KCB yet, so
 * without this the two pressure-test scenarios (§6) could not be encoded at all — they
 * would be prose for as long as the last participant took to adopt.
 *
 * The honesty of a stand-in rests on three properties, all of them enforced here:
 *
 * 1. **It answers only what its fixture covers.** A call the fixture does not name is an
 *    error, never an empty success. A stand-in that improvised would let a scenario go
 *    green against a fabric nobody has built.
 * 2. **It records the same observations a live link does**, through the same log and the
 *    same fact extraction — so an assertion cannot tell the difference, and the day the
 *    peer adopts the bus the scenario is unchanged and the assertions are already right.
 * 3. **It is stamped.** Every observation carries `standin: true` and the fixture it came
 *    from, and the report's `stubbed` flag goes up, so a green run is never mistaken for
 *    a fully live one.
 */
import { isJsonObject, type Json, type JsonObject } from '@agora/schemas';

import { readFacts } from './facts.ts';
import type { ObservedAsset } from './facts.ts';
import { detail, type ObservationLog } from './log.ts';
import {
  assetFrom,
  collect,
  receiptFrom,
  RefusedError,
  type EmitReceipt,
  type EmitRequest,
  type FetchRequest,
  type InvokeRequest,
  type Peer,
  type Subscription,
  type SubscribeRequest,
} from './link.ts';
import type { InvocationResult } from './wire.ts';

/** Thrown when a stand-in is asked for something its fixture does not cover. */
export class UncoveredError extends Error {
  constructor(identity: string, what: string, fixtures: string) {
    super(`the stand-in for ${identity} (${fixtures}) covers no ${what}`);
    this.name = 'UncoveredError';
  }
}

/**
 * One canned exchange. `status` ≥ 400 stands in for a refusal — which is how a fixture
 * expresses an unauthorized fetch or a dangling reference (KCB delta L/G) without a live
 * peer to refuse it.
 */
export interface CannedResponse {
  status?: number;
  reason?: string;
  body?: Json;
}

/**
 * What a stand-in fixture declares, keyed the way a scenario names things: capabilities by
 * name, assets and worlds by KINP id.
 */
export interface StandinFixture {
  identity?: string;
  /**
   * The KCB manifest (§2) this peer has not published yet.
   *
   * A peer that has not adopted the bus has no entry in the registry either, so without
   * this the *control* plane is un-stubbed: `capability_path_exists` (KCS §5) would be
   * unanswerable for every scenario whose participants are stood in for — which is all of
   * them today — and the delta F path-planning step could not be encoded at all. The runner
   * indexes it into a scenario-local index, never into the console's own registry: it
   * describes routes, and nobody may dial them.
   */
  manifest?: Json;
  invoke?: Record<string, CannedResponse>;
  fetch?: Record<string, CannedResponse>;
  subscribe?: Record<string, CannedResponse & { frames?: Json[] }>;
  emit?: CannedResponse;
}

export interface StandinOptions {
  identity: string;
  /** The fixture path the scenario declared — recorded, so a report can be retraced. */
  fixtures: string;
  document: StandinFixture;
  log: ObservationLog;
}

export class Standin implements Peer {
  readonly identity: string;
  readonly stubbed = true;

  constructor(private readonly options: StandinOptions) {
    this.identity = options.identity;
  }

  get note(): string {
    return `stood in for from ${this.options.fixtures} — not a live connection`;
  }

  async invoke(request: InvokeRequest): Promise<InvocationResult> {
    const canned = this.covering(this.options.document.invoke?.[request.capability], {
      what: `invoke of ${request.capability}`,
    });
    this.request(request.step, {
      verb: 'invoke',
      capability: request.capability,
      budget_units: request.budgetUnits ?? null,
    });
    const body = this.answer(request.step, canned, 'knowledge');
    const result: InvocationResult = { raw: isJsonObject(body) ? body : {} };
    const routing = isJsonObject(body) && isJsonObject(body.agora) ? body.agora : {};
    if (typeof routing.tier === 'string') result.tier = routing.tier;
    if (typeof routing.provider === 'string') result.provider = routing.provider;
    if (isJsonObject(routing.cost)) {
      const cost = routing.cost;
      if (typeof cost.actual_units === 'number' && typeof cost.projected_units === 'number') {
        result.cost = {
          currency: typeof cost.currency === 'string' ? cost.currency : 'budget_units',
          budget_units: typeof cost.budget_units === 'number' ? cost.budget_units : null,
          projected_units: cost.projected_units,
          actual_units: cost.actual_units,
        };
      }
    }
    return await Promise.resolve(result);
  }

  async fetchAsset(request: FetchRequest): Promise<ObservedAsset> {
    const canned = this.covering(this.options.document.fetch?.[request.asset], {
      what: `fetch of ${request.asset}`,
    });
    this.request(request.step, { verb: 'fetch', asset: request.asset }, 'media', [request.asset]);
    const status = canned.status ?? 200;
    if (status >= 400) {
      const dangling = status === 404 || status === 410;
      this.options.log.record({
        step: request.step,
        participant: this.identity,
        direction: 'response',
        plane: 'media',
        entities: [this.identity, request.asset],
        detail: detail({
          standin: true,
          status,
          refused: true,
          dangling,
          reason: canned.reason ?? 'the stand-in declared a refusal',
        }),
        facts: {
          claims: [],
          links: [],
          packs: [],
          assets: [{ id: request.asset, attaches_to: [], constituents: [], present: !dangling }],
        },
      });
      throw new RefusedError(status, canned.reason ?? 'the stand-in declared a refusal');
    }
    const facts = readFacts(canned.body ?? null);
    const asset = assetFrom(facts, request.asset, this.identity);
    // The same summary a live CAS response records, so an assertion — and a reader of the
    // report — cannot tell a stand-in's media plane from a real one but for the stamp.
    this.options.log.record({
      step: request.step,
      participant: this.identity,
      direction: 'response',
      plane: 'media',
      entities: [this.identity, asset.id],
      detail: detail({
        standin: true,
        status,
        asset: asset.id,
        media_type: asset.media_type,
        bytes: asset.bytes,
        source_world: asset.source_world === undefined ? undefined : asset.source_world,
      }),
      facts,
    });
    return await Promise.resolve(asset);
  }

  async subscribe(request: SubscribeRequest): Promise<Subscription> {
    const key = request.world ?? request.capability ?? '';
    const canned = this.covering(this.options.document.subscribe?.[key], {
      what: `subscription to ${key}`,
    });
    this.request(request.step, { verb: 'subscribe', world: request.world ?? null }, 'knowledge');
    const summary: Subscription = { frames: 0, claims: [], assets: [], worlds: [] };
    for (const frame of canned.frames ?? []) {
      const facts = readFacts(frame);
      this.options.log.record({
        step: request.step,
        participant: this.identity,
        direction: 'frame',
        plane: facts.assets.length > 0 && facts.claims.length === 0 ? 'media' : 'knowledge',
        entities: [this.identity],
        detail: detail({
          standin: true,
          claims: facts.claims.length,
          assets: facts.assets.length,
        }),
        facts,
      });
      summary.frames += 1;
      collect(summary, facts);
    }
    return await Promise.resolve(summary);
  }

  async emit(request: EmitRequest): Promise<EmitReceipt> {
    const canned = this.covering(this.options.document.emit, { what: 'emit' });
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
      detail: detail({ standin: true, verb: 'emit', claims: outgoing.claims.length }),
      facts: outgoing,
    });
    const body = this.answer(request.step, canned, 'knowledge');
    return await Promise.resolve(receiptFrom(readFacts(body)));
  }

  /** A fixture entry, or a loud failure naming what was missing. */
  private covering<T>(entry: T | undefined, context: { what: string }): T {
    if (entry === undefined) {
      throw new UncoveredError(this.identity, context.what, this.options.fixtures);
    }
    return entry;
  }

  private request(
    step: string,
    fields: Record<string, Json | undefined>,
    plane: 'knowledge' | 'media' = 'knowledge',
    entities: string[] = [],
  ): void {
    this.options.log.record({
      step,
      participant: this.identity,
      direction: 'request',
      plane,
      entities: [this.identity, ...entities],
      detail: detail({ standin: true, fixtures: this.options.fixtures, ...fields }),
    });
  }

  /** Record the canned response as an observation and hand its body back. */
  private answer(
    step: string,
    canned: CannedResponse,
    plane: 'knowledge' | 'media',
    entities: string[] = [],
  ): Json {
    const status = canned.status ?? 200;
    const body = canned.body ?? null;
    if (status >= 400) {
      this.options.log.record({
        step,
        participant: this.identity,
        direction: 'response',
        plane,
        entities: [this.identity, ...entities],
        detail: detail({
          standin: true,
          status,
          refused: true,
          reason: canned.reason ?? 'the stand-in declared a refusal',
        }),
      });
      throw new RefusedError(status, canned.reason ?? 'the stand-in declared a refusal');
    }
    const facts = readFacts(body);
    this.options.log.record({
      step,
      participant: this.identity,
      direction: 'response',
      plane,
      entities: [this.identity, ...entities],
      detail: detail({ standin: true, status, claims: facts.claims.length }),
      facts,
    });
    return body;
  }
}

/** Thrown when a `standin` fixture cannot be loaded or is not a fixture document. */
export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureError';
  }
}

/** How the console gets at a fixture a scenario names. Injectable: the browser fetches
 * them over HTTP, a gate hands them over directly. */
export type FixtureLoader = (path: string) => Promise<Json>;

/** Validate a loaded fixture. Structural only — its contents are the scenario's business. */
export function parseFixture(value: Json, path: string): StandinFixture {
  if (!isJsonObject(value)) throw new FixtureError(`${path} is not a stand-in fixture document`);
  for (const key of ['invoke', 'fetch', 'subscribe'] as const) {
    const section = value[key];
    if (section !== undefined && !isJsonObject(section)) {
      throw new FixtureError(`${path}.${key} must be an object keyed by name`);
    }
  }
  return value as unknown as StandinFixture;
}
