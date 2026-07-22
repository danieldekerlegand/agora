/**
 * Shared protocol types for the agora commons.
 *
 * These mirror the ratified koine specs — see `../../koine/specs/`. The specs are
 * authoritative; anything here that disagrees with them is a bug in this file. The full
 * KCB capability-manifest schema lands with the provider-router's manifest (US-AG3);
 * this module currently pins the spec versions the commons implements and the small
 * vocabulary shared across every area.
 */

/** Spec versions this build of the commons implements. */
export const SPEC_VERSIONS = {
  /** Capability bus — `koine/specs/capability-bus.md` */
  kcb: '0.2.0',
  /** Identity / naming — `koine/specs/identity.md` */
  kinp: '0.2.0',
} as const;

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
