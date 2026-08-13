/**
 * The backbone — Studio's picture of a fabric, and the one seam every view reads from.
 *
 * It holds **no cast of its own**. A `Backbone` is whatever was handed to it at runtime, and
 * the default is empty: zero participants, zero connections. Nothing in this module (or
 * anywhere else under `studio/src`) names a participant, imports a roster, or reaches out to
 * find one — capability, never caller (`../../CLAUDE.md`). A fresh install draws an empty
 * stage and stays that way until the user's own configuration supplies a cast.
 *
 * It is also, deliberately, only a shape and a normalizer. Studio is an **observer, not a
 * hub** (ADR-0001 decision 7): a participant here is a thing that was *seen*, and an edge is
 * a link two participants hold with each other. There is no verb in this file that could
 * carry a payload from one to the other, because there is nowhere for such a payload to go.
 */

/** One thing on the fabric — an app, a service, an agent. Whatever published a manifest. */
export interface Participant {
  /** KINP identity, the only required field: it is what makes two sightings the same thing. */
  identity: string;
  /** What to show a human. Falls back to the identity when the config gave no name. */
  label?: string;
  /** Capability names this participant advertises (KCB §3). Display only — never invoked. */
  capabilities?: readonly string[];
}

/** A link between two participants. Observed, not owned: the traffic is theirs, not Studio's. */
export interface Connection {
  /** Identity of the participant that dials. */
  from: string;
  /** Identity of the participant it dials. */
  to: string;
  /** How they speak, when known — `a2a`, `mcp`, whatever the pair advertised. */
  transport?: string;
}

/** The whole runtime picture. Everything a view draws comes from one of these. */
export interface Backbone {
  participants: readonly Participant[];
  connections: readonly Connection[];
}

/** What Studio has before anyone tells it anything. The default, not a placeholder. */
export const EMPTY_BACKBONE: Backbone = Object.freeze({
  participants: Object.freeze([]),
  connections: Object.freeze([]),
});

/** Nothing to draw. An expected, first-run state — never an error and never a spinner. */
export function isEmpty(backbone: Backbone): boolean {
  return backbone.participants.length === 0 && backbone.connections.length === 0;
}

/**
 * Normalize whatever was handed in into something a view can draw without second-guessing it.
 *
 * Absent, partial and empty input all collapse to {@link EMPTY_BACKBONE}. Participants without
 * an identity are dropped (an unnameable node cannot be the same node twice) and repeats of one
 * identity collapse to the first sighting. An edge is kept only when Studio has actually seen
 * both of its ends: drawing a line to something it cannot draw would be Studio asserting a
 * participant it never observed.
 */
export function backboneOf(input?: Partial<Backbone> | null): Backbone {
  if (!input) return EMPTY_BACKBONE;

  const participants: Participant[] = [];
  const seen = new Set<string>();
  for (const participant of input.participants ?? []) {
    const identity = participant?.identity?.trim();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    participants.push({ ...participant, identity });
  }

  const connections = (input.connections ?? []).filter(
    (connection) => seen.has(connection?.from) && seen.has(connection?.to),
  );

  if (participants.length === 0 && connections.length === 0) return EMPTY_BACKBONE;
  return { participants, connections };
}

/** What to show for a participant: the name the config gave, else the identity itself. */
export function labelOf(participant: Participant): string {
  return participant.label?.trim() || participant.identity;
}
