/**
 * How the registry ranks (KCB §3 delta K): "path search **prefers zero-`cost` routes** and
 * returns the path's projected cost so the caller can gate spend before invoking".
 *
 * The one subtlety is `unpriced`. A provider that could not price a capability publishes
 * `est_units: 0, unpriced: true` (the provider-router does exactly this for a vendor it has
 * no rate for), and a capability with no `cost` block at all is likewise unknown. Reading
 * either as "free" would make the *unknown* route the registry's favourite — so unpriced
 * ranks after everything priced, however expensive.
 */
import type { Capability } from '@agora/schemas';

/** What a capability costs to invoke, read defensively: absent price ≠ free. */
export function costOf(capability: Capability): { units: number; unpriced: boolean } {
  const cost = capability.cost;
  if (cost === undefined) return { units: 0, unpriced: true };
  return { units: cost.est_units, unpriced: cost.unpriced ?? false };
}

/** Cheapest first, priced before unpriced, then registration order. */
export function compareByCost(
  a: { estUnits: number; unpriced: boolean; sequence: number },
  b: { estUnits: number; unpriced: boolean; sequence: number },
): number {
  if (a.unpriced !== b.unpriced) return a.unpriced ? 1 : -1;
  if (a.estUnits !== b.estUnits) return a.estUnits - b.estUnits;
  return a.sequence - b.sequence;
}
