/**
 * Wires — how a plane-typed KCS `invoke` becomes a real request on a provider's own
 * protocol.
 *
 * A scenario says *what* (a capability, ports, a ceiling); a wire says *how* on this
 * peer's transport. The console must speak the protocol the provider actually serves —
 * that is the whole point of ADR-0001 decision 7: a green scenario proves the real
 * protocol, so there is no console-flavoured envelope in between.
 *
 * Three wires are implemented — the provider-router's OpenAI-compatible surface, an MCP
 * client (Analyzer `/mcp`) and an A2A client (a Orchestrator/Analyzer agent card). {@link wireFor}
 * picks between them from what a provider *serves*; a transport this build cannot speak is
 * still named and *refused* rather than mis-dialed, so the day a peer advertises a fourth
 * the failure says which wire to write.
 */
import type { Capability, CapabilityManifest, Json, JsonObject } from '@agora/schemas';
import { isJsonObject } from '@agora/schemas';

import { a2aWire } from './a2a-wire.ts';
import { mcpWire } from './mcp-wire.ts';

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

/** The summary a wire wants recorded for one leg of its exchange (undefined fields dropped). */
export interface ExchangeDetail {
  /** Merged into the request leg — the protocol step, the ceiling, the tool being called. */
  request?: Record<string, Json | undefined>;
  /**
   * Given the parsed answer, the detail merged into the response leg. A wire reads its own
   * body to summarise it (tier/provider/cost) because only it knows where those live.
   */
  response?: (body: JsonObject) => Record<string, Json | undefined>;
  /**
   * A hook onto a successful answer's *headers*, so a multi-step wire can pick up a transport
   * token it must echo on a later leg — MCP's `Mcp-Session-Id`, which lives in the header, not
   * the JSON-RPC body. The seam still owns the socket; this only reads what came back.
   */
  captureHeaders?: (headers: { get(name: string): string | null }) => void;
}

/**
 * The I/O-and-observation seam a wire drives its protocol through.
 *
 * A wire never holds a socket. It asks the seam to make each round-trip; the seam — the
 * console's {@link Link} — runs it over the injected {@link HttpFetch} and records both legs
 * to the ObservationLog. That is ADR-0001 decision 7 for a handshake: every leg of an MCP
 * `initialize` → `tools/call` or an A2A `message/send` is an observed, direct connection, and
 * a delta-N stand-in substitutes for the peer without the wire noticing. A non-ok answer or a
 * non-object body is surfaced as a {@link RefusedError} by the seam, not returned.
 */
export interface WireIO {
  exchange(call: WireCall, detail?: ExchangeDetail): Promise<JsonObject>;
}

/**
 * How a plane-typed KCS `invoke` becomes a real invocation on a provider's own protocol.
 *
 * `invoke` drives the whole exchange through the {@link WireIO} seam — a single round-trip for
 * openai, a multi-round-trip handshake for MCP/A2A — and normalises whatever comes back to one
 * {@link InvocationResult}.
 */
export interface Wire {
  name: string;
  invoke(context: WireContext, io: WireIO): Promise<InvocationResult>;
}

/**
 * A wire whose invocation is a single request → response, exposed as two pure steps so a
 * fixture can drive `request`/`read` directly. The openai wire is the archetype.
 */
export interface SingleShotWire extends Wire {
  request(context: WireContext): WireCall;
  read(body: JsonObject): InvocationResult;
}

/** Thrown when a provider's advertised transport has no wire in this build. */
export class UnsupportedWireError extends Error {
  constructor(identity: string, transports: string[]) {
    super(
      `no wire for ${identity}: it advertises ${transports.join(', ') || 'nothing'}, none of ` +
        'which this build can dial (it speaks openai, mcp and a2a)',
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

export const openaiWire: SingleShotWire = {
  name: 'openai',

  /** One round-trip through the seam — the single-shot case of the generalised contract. */
  async invoke(context: WireContext, io: WireIO): Promise<InvocationResult> {
    const call = openaiWire.request(context);
    const body = await io.exchange(call, {
      request: {
        wire: openaiWire.name,
        capability: context.capability.name,
        endpoint: call.url,
        budget_units: context.budgetUnits ?? null,
      },
      response: (answer) => {
        const result = openaiWire.read(answer);
        return {
          tier: result.tier,
          provider: result.provider,
          model: result.model,
          actual_units: result.cost?.actual_units,
          projected_units: result.cost?.projected_units,
          assets: result.assets?.map((asset) => asset.media_type),
        };
      },
    });
    return openaiWire.read(body);
  },

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
 *
 * The precedence is openai → mcp → a2a: the console prefers the provider-router's own
 * surface when a peer offers one, else its MCP tool surface, else its A2A agent. A manifest
 * that advertises none of the three has no wire in this build and is refused *by name*
 * ({@link UnsupportedWireError}) rather than mis-dialed. (Which endpoint each wire dials is
 * `endpointFor`'s job in @agora/kcb-client; this only names the protocol.)
 */
export function wireFor(manifest: CapabilityManifest): Wire {
  if (typeof manifest.endpoints.openai === 'string') return openaiWire;
  if (typeof manifest.endpoints.mcp === 'string') return mcpWire;
  if (typeof manifest.endpoints.a2a === 'string') return a2aWire;
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
