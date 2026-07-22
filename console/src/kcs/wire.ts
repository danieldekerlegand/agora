/**
 * Wires — how a plane-typed KCS `invoke` becomes a real request on a provider's own
 * protocol.
 *
 * A scenario says *what* (a capability, ports, a ceiling); a wire says *how* on this
 * peer's transport. The console must speak the protocol the provider actually serves —
 * that is the whole point of ADR-0001 decision 7: a green scenario proves the real
 * protocol, so there is no console-flavoured envelope in between.
 *
 * One wire is implemented today, because one provider has adopted the bus: the
 * provider-router's OpenAI-compatible surface. MCP and A2A are named and *refused* rather
 * than absent — {@link wireFor} throws with the transport it found, so the day a peer
 * advertises `mcp` the failure says which wire to write instead of silently mis-dialing.
 */
import type { Capability, CapabilityManifest, Json, JsonObject } from '@agora/schemas';
import { isJsonObject } from '@agora/schemas';

/** A direct call the console will make: a URL on the *provider's* address, nothing relayed. */
export interface WireCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: JsonObject;
}

/** What a provider spent, as it reported it (KCB §2.1 delta K, in budget units). */
export interface ReportedCost {
  currency: string;
  budget_units: number | null;
  projected_units: number;
  actual_units: number;
}

/** An invocation, normalised across wires — what bindings and assertions read. */
export interface InvocationResult {
  /** The rung of the provider's ladder that served it, when it reports one. */
  tier?: string;
  provider?: string;
  model?: string;
  cost?: ReportedCost;
  /** Knowledge-plane output, when the capability produced text. */
  text?: string;
  /** Media-plane outputs, by reference — the log never carries bytes (KMI §7). */
  assets?: { media_type: string; digest?: string }[];
  /** The provider's response verbatim, for the report's detail view. */
  raw: JsonObject;
}

export interface WireContext {
  manifest: CapabilityManifest;
  capability: Capability;
  /** The address to dial, already resolved by the registry (never invented here). */
  endpoint: string;
  /** Plane-typed inputs, bindings already resolved. */
  inputs: { shape?: string | undefined; value?: Json | undefined }[];
  options: JsonObject;
  budgetUnits?: number | undefined;
}

export interface Wire {
  name: string;
  request(context: WireContext): WireCall;
  read(body: JsonObject): InvocationResult;
}

/** Thrown when a provider's advertised transport has no wire in this build. */
export class UnsupportedWireError extends Error {
  constructor(identity: string, transports: string[]) {
    super(
      `no wire for ${identity}: it advertises ${transports.join(', ') || 'nothing'} and this ` +
        'build speaks openai only',
    );
    this.name = 'UnsupportedWireError';
  }
}

/**
 * Which knowledge-plane `shape` lands in which OpenAI field. The port carries the meaning;
 * this table is the one place the meaning meets a vendor's field name.
 */
const SHAPE_FIELDS: Record<string, string> = {
  'chat-messages': 'messages',
  'prompt-text': 'prompt',
  'completion-text': 'prompt',
};

export const openaiWire: Wire = {
  name: 'openai',

  request(context: WireContext): WireCall {
    const body: JsonObject = {
      // The provider advertises the model its currently resolved tier will serve; echoing
      // it back is how the console stays out of the ladder's business (US-AG2).
      model: context.capability.model ?? 'agora-router',
      ...context.options,
    };
    for (const input of context.inputs) {
      if (input.value === undefined) continue;
      if (isJsonObject(input.value)) {
        Object.assign(body, input.value);
        continue;
      }
      const field = SHAPE_FIELDS[input.shape ?? ''];
      if (field === undefined) {
        throw new Error(`openai wire: no field for knowledge shape ${String(input.shape)}`);
      }
      body[field] = input.value;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const budgetHeader = budgetHeaderName(context.manifest);
    if (context.budgetUnits !== undefined && budgetHeader !== undefined) {
      // The ceiling rides in the header the manifest advertises (KCB §5), not the body:
      // the body is the request the provider hashes, and a ceiling is not part of it.
      headers[budgetHeader] = String(context.budgetUnits);
    }
    return { url: context.endpoint, method: 'POST', headers, body };
  },

  read(body: JsonObject): InvocationResult {
    const routing = isJsonObject(body.agora) ? body.agora : {};
    const result: InvocationResult = { raw: body };
    if (typeof routing.tier === 'string') result.tier = routing.tier;
    if (typeof routing.provider === 'string') result.provider = routing.provider;
    if (typeof routing.model === 'string') result.model = routing.model;
    const cost = readCost(routing.cost);
    if (cost !== undefined) result.cost = cost;
    const text = readText(body);
    if (text !== undefined) result.text = text;
    const assets = readAssets(body);
    if (assets.length > 0) result.assets = assets;
    return result;
  },
};

/**
 * The wire for a provider, chosen from what its manifest says it *serves*. A manifest
 * address is a promise (US-AG3); this is the console keeping its half of it.
 */
export function wireFor(manifest: CapabilityManifest): Wire {
  if (typeof manifest.endpoints.openai === 'string') return openaiWire;
  throw new UnsupportedWireError(manifest.identity, Object.keys(manifest.endpoints));
}

/** Where this provider wants a spend ceiling, per its manifest's `auth` block (KCB §5). */
export function budgetHeaderName(manifest: CapabilityManifest): string | undefined {
  const budget = manifest.auth?.budget_units;
  if (!isJsonObject(budget) || typeof budget.header !== 'string') return undefined;
  return budget.header;
}

function readCost(value: Json | undefined): ReportedCost | undefined {
  if (!isJsonObject(value)) return undefined;
  const cost = value;
  if (typeof cost.actual_units !== 'number' || typeof cost.projected_units !== 'number') {
    return undefined;
  }
  return {
    currency: typeof cost.currency === 'string' ? cost.currency : 'budget_units',
    budget_units: typeof cost.budget_units === 'number' ? cost.budget_units : null,
    projected_units: cost.projected_units,
    actual_units: cost.actual_units,
  };
}

function readText(body: JsonObject): string | undefined {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0];
  if (!isJsonObject(first)) return undefined;
  const message = first.message;
  if (!isJsonObject(message)) return undefined;
  const content = message.content;
  return typeof content === 'string' ? content : undefined;
}

function readAssets(body: JsonObject): { media_type: string; digest?: string }[] {
  const data = Array.isArray(body.data) ? body.data : [];
  const assets: { media_type: string; digest?: string }[] = [];
  for (const entry of data) {
    if (!isJsonObject(entry)) continue;
    if (typeof entry.media_type !== 'string') continue;
    assets.push(
      typeof entry.digest === 'string'
        ? { media_type: entry.media_type, digest: entry.digest }
        : { media_type: entry.media_type },
    );
  }
  return assets;
}
