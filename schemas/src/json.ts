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
