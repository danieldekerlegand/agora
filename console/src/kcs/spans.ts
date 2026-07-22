/**
 * Reading the **control** plane off a stream — emitted exchange telemetry.
 *
 * `facts.ts` reads the data planes: what a frame *said* in KGP/KMI/KINP shapes. This module
 * reads the other thing a producer may put on its own stream — a record that an exchange
 * happened: somebody invoked something on it, the ladder resolved a tier, it cost this much,
 * it was granted or refused.
 *
 * Why this is a separate, deliberately narrow reader, and why it is provisional:
 *
 * * ADR-0001 decision 7 lets a passive observer *subscribe*; it does not let it tap the wire
 *   between two other peers. So the only way the console can see an invoke it did not make is
 *   if the provider that served it **emits** a record of it. Nothing is inferred here from
 *   traffic the console was not a party to.
 * * koine has **no emitted-telemetry contract yet** (KCB §4 fixes discover/describe/invoke/
 *   subscribe/fetch and nothing about observability). The shape below is therefore agora's
 *   provisional reading, pending the KCB observability extension named in the 30-* tasklist.
 *   A provider that emits nothing is simply absent at the invoke level — that is the
 *   documented limitation, not a bug in the monitor.
 *
 * The recognition rule is strict on purpose: a frame is telemetry only when it **says** it is
 * (`kind: exchange`, or a `span`/`exchange` envelope). A KGP delta must never be re-read as an
 * invocation, or the monitor would start inventing control-plane events out of knowledge ones.
 */
import { isJsonObject, type Json, type JsonObject } from '@agora/schemas';

/** One exchange as its server reported it — ids and scalars, never payloads. */
export interface ObservedSpan {
  /** The emitter's own id for the exchange, when it minted one. */
  id?: string | undefined;
  /** The provider that served the exchange and emitted this record. */
  provider?: string | undefined;
  /** Who asked — the far side of an exchange the console was not a party to. */
  caller?: string | undefined;
  /** The KCB §4 verb: invoke / fetch / subscribe / emit. */
  verb?: string | undefined;
  capability?: string | undefined;
  world?: string | undefined;
  /** The rung of the provider's ladder that served it, when it reports one. */
  tier?: string | undefined;
  /** `ok`, `refused`, `error` — whatever the emitter called it, not normalised. */
  status?: string | undefined;
  /** The ceiling the caller carried (KCB §5 delta K); `null` = stated as none. */
  budget_units?: number | null | undefined;
  actual_units?: number | undefined;
  started_at?: string | undefined;
  duration_ms?: number | undefined;
  /** KINP ids the exchange touched, as the emitter listed them. */
  entities: string[];
}

/** What a frame calls itself when it is telemetry rather than a delta. */
export const SPAN_KINDS: readonly string[] = ['exchange', 'span', 'telemetry'];

/** The envelopes a span may arrive wrapped in. */
const SPAN_CONTAINERS: readonly string[] = ['span', 'exchange', 'telemetry'];

/**
 * The span a frame carries, or `undefined` when it carries none.
 *
 * Requires the frame to name a `verb` or a `capability`: a record of an exchange that says
 * neither what was done nor to what is not an observation of anything, and admitting it would
 * put empty rows in the feed for every frame that happened to use the word "span".
 */
export function readSpan(value: Json | undefined): ObservedSpan | undefined {
  if (!isJsonObject(value)) return undefined;
  const body = spanBody(value);
  if (body === undefined) return undefined;
  const verb = text(body.verb);
  const capability = text(body.capability);
  if (verb === undefined && capability === undefined) return undefined;
  const span: ObservedSpan = { entities: strings(body.entities) };
  if (verb !== undefined) span.verb = verb;
  if (capability !== undefined) span.capability = capability;
  assign(span, 'id', text(body.id ?? body.span_id));
  assign(span, 'provider', text(body.provider ?? body.server ?? body.participant));
  assign(span, 'caller', text(body.caller ?? body.client ?? body.consumer));
  assign(span, 'world', text(body.world));
  assign(span, 'tier', text(body.tier));
  assign(span, 'status', text(body.status ?? body.outcome));
  assign(span, 'started_at', text(body.started_at ?? body.at));
  assign(span, 'actual_units', number(body.actual_units));
  assign(span, 'duration_ms', number(body.duration_ms));
  // `null` is the emitter's positive "the caller carried no ceiling" — kept apart from an
  // emitter that said nothing about ceilings at all, exactly as `source_world` is (facts.ts).
  if (typeof body.budget_units === 'number') span.budget_units = body.budget_units;
  else if (body.budget_units === null) span.budget_units = null;
  return span;
}

/** Every KINP id a span touched, in first-seen order — what the log stamps its entry with. */
export function idsInSpan(span: ObservedSpan): string[] {
  const seen = new Set<string>();
  for (const id of [span.provider, span.caller, span.world, ...span.entities]) {
    if (id !== undefined) seen.add(id);
  }
  return [...seen];
}

/** The span in one line — the feed's row, and the timeline's detail. */
export function summariseSpan(span: ObservedSpan): string {
  const what = [span.verb, span.capability].filter((part) => part !== undefined).join(' ');
  const between = [span.caller, span.provider].filter((part) => part !== undefined).join(' → ');
  const cost = span.actual_units === undefined ? '' : ` · ${span.actual_units} units`;
  const tier = span.tier === undefined ? '' : ` · tier ${span.tier}`;
  const status = span.status === undefined ? '' : ` · ${span.status}`;
  return `${what || 'exchange'}${between === '' ? '' : ` (${between})`}${tier}${cost}${status}`;
}

/** The object the span's fields live on, whether wrapped in an envelope or flat. */
function spanBody(value: JsonObject): JsonObject | undefined {
  for (const key of SPAN_CONTAINERS) {
    const nested = value[key];
    if (isJsonObject(nested)) return nested;
  }
  const kind = value.kind ?? value.type;
  return typeof kind === 'string' && SPAN_KINDS.includes(kind) ? value : undefined;
}

/** Set an optional field only when it was stated — an absent field is absent, not null. */
function assign<K extends keyof ObservedSpan>(
  span: ObservedSpan,
  key: K,
  value: ObservedSpan[K] | undefined,
): void {
  if (value !== undefined) span[key] = value;
}

function text(value: Json | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function number(value: Json | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function strings(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
