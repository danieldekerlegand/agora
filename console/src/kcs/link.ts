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

import { detail, type ObservationLog } from './log.ts';
import type { HttpFetch } from './http.ts';
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

export class Link {
  readonly identity: string;
  readonly address: ProviderAddress;
  readonly wire: Wire;

  constructor(
    private readonly registration: Registration,
    private readonly options: LinkOptions,
  ) {
    this.identity = registration.identity;
    this.address = registration.address;
    this.wire = wireFor(registration.manifest);
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
      throw new RefusedError(0, `${this.identity} published no address for ${request.capability}`);
    }
    const call = this.wire.request({
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
        wire: this.wire.name,
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
    const result = this.wire.read(body);
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
    });
    return result;
  }
}

export function openLink(registration: Registration, options: LinkOptions): Link {
  return new Link(registration, options);
}

/** The provider's own words for why it refused, when it gave any. */
function refusalReason(body: unknown): string {
  if (isJsonObject(body)) {
    if (typeof body.detail === 'string') return body.detail;
    if (isJsonObject(body.error) && typeof body.error.message === 'string') return body.error.message;
  }
  return 'no reason given';
}
