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

/**
 * Which koine contract's vocabulary types a port on each plane — the mapping the comment
 * above states, as data, so a reader can index it instead of restating it. §2.1 is the
 * authority; this is only the fact in a shape code can look up.
 */
export const PLANE_SPECS = {
  knowledge: 'kgp',
  media: 'kmi',
  entity: 'kinp',
} as const satisfies Record<Plane, string>;

/** The spec that types a plane, as {@link PLANE_SPECS} names it. */
export type PlaneSpec = (typeof PLANE_SPECS)[Plane];
