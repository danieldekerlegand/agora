/**
 * Port matching — the arithmetic underneath every registry query (KCB §3).
 *
 * Two questions, deliberately kept apart:
 *
 * * {@link matchesPort} — "does this port answer what the caller asked for?" A query is a
 *   conjunction of the constraints it states; an empty query matches every port.
 * * {@link satisfies} — "can this produced port feed that consumed port?" This is the
 *   edge test for capability-path search (§3 composition), and it is *asymmetric*: the
 *   consumer states requirements, the producer must meet the ones it states.
 *
 * Because ports are plane-typed (§2.1 delta F), both work across planes — a knowledge
 * port can be the input of a capability whose output is media.
 */
import type { MediaPort, Plane, Port } from '@agora/schemas';

/** What a caller is looking for. Every stated field must hold; an empty query matches all. */
export interface PortQuery {
  plane?: Plane;
  /** Knowledge/media payload shape. */
  shape?: string;
  /** KGP dialect (knowledge ports). */
  dialect?: string;
  /** KMI media type; `audio/*` is allowed on either side. */
  mediaType?: string;
  /** A concrete world, matched against a media port's `world_pattern` (delta J). */
  world?: string;
  /** KINP entity type. */
  entityType?: string;
}

/** True when `port` answers `query`. */
export function matchesPort(port: Port, query: PortQuery): boolean {
  if (query.plane !== undefined && port.plane !== query.plane) return false;
  if (query.shape !== undefined && shapeOf(port) !== query.shape) return false;
  if (query.dialect !== undefined && (port.plane !== 'knowledge' || port.dialect !== query.dialect))
    return false;
  const { mediaType, entityType } = query;
  if (mediaType !== undefined) {
    if (port.plane !== 'media') return false;
    if (!port.media_types.some((declared) => mediaTypesOverlap(declared, mediaType))) return false;
  }
  if (query.world !== undefined && !servesWorld(port, query.world)) return false;
  if (entityType !== undefined) {
    if (port.plane !== 'entity' || !port.types.includes(entityType)) return false;
  }
  return true;
}

/**
 * True when a port serves a concrete world.
 *
 * A media port with no `world_pattern` makes no claim about worlds, so it does *not*
 * answer a world-scoped query — delta J exists precisely because world-scoped discovery
 * is impossible without the declaration, and guessing "probably all worlds" would hand
 * the caller a provider that may not have the world's material at all.
 */
export function servesWorld(port: Port, world: string): boolean {
  if (port.plane === 'media') return worldMatches(port.world_pattern, world);
  if (port.plane === 'knowledge') return port.worlds?.includes(world) ?? false;
  return false;
}

/** Glob match with `*` as the only wildcard, as used by `world_pattern`. */
export function worldMatches(pattern: string | undefined, world: string): boolean {
  if (pattern === undefined) return false;
  return globToRegExp(pattern).test(world);
}

/** True when `produced` can feed `consumed` — the path-search edge test (§3). */
export function satisfies(produced: Port, consumed: Port): boolean {
  if (produced.plane !== consumed.plane) return false;
  if (consumed.plane === 'knowledge' && produced.plane === 'knowledge') {
    if (consumed.shape !== undefined && consumed.shape !== produced.shape) return false;
    if (consumed.dialect !== undefined && consumed.dialect !== produced.dialect) return false;
    return true;
  }
  if (consumed.plane === 'media' && produced.plane === 'media') {
    const overlap = consumed.media_types.some((wanted) =>
      produced.media_types.some((declared) => mediaTypesOverlap(declared, wanted)),
    );
    return overlap && worldsOverlap(produced, consumed);
  }
  if (consumed.plane === 'entity' && produced.plane === 'entity') {
    return consumed.types.some((type) => produced.types.includes(type));
  }
  return false;
}

/** The payload shape a port names, if its plane has one. */
function shapeOf(port: Port): string | undefined {
  return port.plane === 'entity' ? undefined : port.shape;
}

/** Media types overlap if either side's glob covers the other (`audio/*` vs `audio/wav`). */
function mediaTypesOverlap(a: string, b: string): boolean {
  return globToRegExp(a).test(b) || globToRegExp(b).test(a);
}

/**
 * World scoping only constrains a hop when *both* ends declare it: a producer that says
 * nothing about worlds is unscoped material, not material from the wrong world.
 */
function worldsOverlap(produced: MediaPort, consumed: MediaPort): boolean {
  const from = produced.world_pattern;
  const to = consumed.world_pattern;
  if (from === undefined || to === undefined) return true;
  return globToRegExp(from).test(to) || globToRegExp(to).test(from);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === '*' ? '.*' : `\\${char}`,
  );
  return new RegExp(`^${escaped}$`);
}
