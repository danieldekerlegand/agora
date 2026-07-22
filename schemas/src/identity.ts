/**
 * KINP identifiers — `koine/specs/identity.md` §3.2, the compact (CURIE) form.
 *
 * ```
 * <namespace>:<kind>:<local-id>      e.g. orchestrator:agent:composer
 * ```
 *
 * Only the compact form is modelled here: it is what every manifest, port and registry
 * key uses on the wire. The canonical IRI form (§3.1) is an expansion of the same triple
 * through a prefix registry, which the commons does not host.
 */

/** The `<kind>` segment (identity.md §3.1). */
export const KINP_KINDS = ['ent', 'claim', 'asset', 'world', 'agent', 'src'] as const;

export type KinpKind = (typeof KINP_KINDS)[number];

export interface KinpId {
  /** The minting authority (identity.md §3.4). */
  namespace: string;
  kind: KinpKind;
  /** Opaque within the namespace. */
  localId: string;
}

/** `[a-z0-9][a-z0-9._-]*` — lowercase, anything else is percent-encoded (§3.1). */
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

/** Parse a compact KINP id, or `undefined` if it is not one. */
export function parseKinpId(value: unknown): KinpId | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split(':');
  if (parts.length !== 3) return undefined;
  const [namespace, kind, localId] = parts as [string, string, string];
  if (!SEGMENT.test(namespace) || !SEGMENT.test(localId)) return undefined;
  if (!(KINP_KINDS as readonly string[]).includes(kind)) return undefined;
  return { namespace, kind: kind as KinpKind, localId };
}

/** Narrowing guard for identifiers arriving off the wire. */
export function isKinpId(value: unknown): value is string {
  return parseKinpId(value) !== undefined;
}
