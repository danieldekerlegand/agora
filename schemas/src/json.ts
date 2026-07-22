/**
 * The JSON value type. Everything in this package arrived from another process over the
 * wire, so "some value the provider sent" is `Json`, never `any` — the difference is that
 * `Json` forces a caller to narrow before using it.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A JSON object, the shape of every payload and manifest on the bus. */
export type JsonObject = { [key: string]: Json };

/** Narrowing guard for a JSON object arriving off the wire. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One JSON value, one byte string — object keys sorted, no insignificant whitespace.
 *
 * This is the precondition for every content address in the commons: KGP §3 is normative
 * that "cross-producer dedup works only if every project reduces a claim to the identical
 * byte string before hashing", and the same discipline applies to anything else the fabric
 * addresses by its content (a pack id, KCS §4.4's conformance report). Key *order* is the
 * accident this removes; a producer that serialised `{"a":1,"b":2}` and one that serialised
 * `{"b":2,"a":1}` are saying the same thing and must hash alike.
 *
 * Array order is preserved — it is content, not an accident. A caller that wants a set
 * rather than a sequence sorts before calling (KGP §2.1 sorts pack members by element id).
 */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
