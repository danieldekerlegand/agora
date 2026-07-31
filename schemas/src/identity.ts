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

/** A world name, which may carry a playthrough fork suffix — `alderforest#save-7f` (§5). */
const WORLD_SEGMENT = /^[a-z0-9][a-z0-9._-]*(#[a-z0-9][a-z0-9._-]*)?$/;

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

/** True for a world id itself — `worldsim:world:alderforest` (identity.md §5). */
export function isWorldId(value: unknown): boolean {
  return parseKinpId(value)?.kind === 'world';
}

/**
 * The world an id is *named* into, when it is named into one.
 *
 * §5: "entities within a world use that world as their namespace", so
 * `worldsim:world:alderforest:ent:npc-renaud` is scoped to `worldsim:world:alderforest`
 * and a playthrough fork (`…alderforest#save-7f:ent:…`) to that fork. An id whose
 * namespace is a plain authority (`refkb:ent:napoleon-i`) is scoped by nothing but its
 * assertion envelope's own `world` — hence `undefined` rather than a guess, because the
 * firewall (§4.3) turns on knowing which world a claim is in.
 */
export function worldOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return parseWorldScoped(value)?.world;
}

/**
 * The kind an id declares, in **either** form — compact (§3.2) or world-scoped (§5).
 *
 * {@link parseKinpId} only reads the three-segment compact form, so it answers `undefined`
 * for `worldsim:world:alderforest:ent:npc-renaud` — which is a perfectly well-formed entity
 * id. Anything that needs "what kind of thing is this" (the resolver deciding whether an
 * id round-trips to the authority at all, §6) needs both, from one grammar.
 */
export function kindOf(value: unknown): KinpKind | undefined {
  if (typeof value !== 'string') return undefined;
  return parseKinpId(value)?.kind ?? parseWorldScoped(value)?.kind;
}

/** `<namespace>:world:<name>:<kind>:<local-id>` — an id named into a world (§5). */
function parseWorldScoped(value: string): { world: string; kind: KinpKind } | undefined {
  const parts = value.split(':');
  if (parts.length !== 5) return undefined;
  const [namespace, world, name, kind, localId] = parts as [string, string, string, string, string];
  if (world !== 'world' || !SEGMENT.test(namespace) || !SEGMENT.test(localId)) return undefined;
  if (!WORLD_SEGMENT.test(name)) return undefined;
  if (!(KINP_KINDS as readonly string[]).includes(kind)) return undefined;
  return { world: `${namespace}:world:${name}`, kind: kind as KinpKind };
}
