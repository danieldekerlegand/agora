/**
 * The protocol planes. A KCB port is typed by its plane (capability-bus.md §2.1):
 * `knowledge` by KGP dialect, `media` by KMI media types, `entity` by KINP entity types.
 */
export const PLANES = ['knowledge', 'media', 'entity'] as const;

export type Plane = (typeof PLANES)[number];

/** Narrowing guard for values arriving off the wire. */
export function isPlane(value: unknown): value is Plane {
  return typeof value === 'string' && (PLANES as readonly string[]).includes(value);
}
