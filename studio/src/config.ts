/**
 * Config ingestion — how a user's own description of their fabric becomes the cast on screen.
 *
 * Studio ships no config and holds no cast. The description lives with the user, in the project
 * whose fabric it describes, and arrives here as text or as already-parsed JSON: nothing in this
 * module goes looking for it, because a shell that fetches its own roster is a shell with a
 * roster. The host reads the file (or the script block, or the env var) it owns and hands the
 * contents in, the same way every other seam in this area takes its data as an argument.
 *
 * The format is self-describing — it names and versions itself in a `format` field, so a config
 * outlives the reader that first understood it and an unrecognized one is refused rather than
 * guessed at:
 *
 * ```json
 * {
 *   "format": "agora.studio.config/v1",
 *   "participants": [
 *     {
 *       "identity": "<kinp identity>",
 *       "label": "<what to show>",
 *       "capabilities": ["<name>"],
 *       "endpoints": { "a2a": "<url>", "mcp": "<url>" },
 *       "manifest": { "<the KCB manifest body you read for it>": "…" },
 *       "card": { "<the AgentCard you read at its own address>": "…" }
 *     }
 *   ],
 *   "connections": [{ "from": "<identity>", "to": "<identity>", "transport": "a2a" }]
 * }
 * ```
 *
 * Everything is optional but the format tag and each participant's identity. A config that
 * describes nobody is not an error — it yields the same empty backbone a fresh install draws.
 * Nothing is ever thrown: whatever could not be understood comes back as a `problems` line, so
 * a typo costs the user that one entry and an explanation rather than a blank screen.
 *
 * The last three fields are what make a described fabric *watchable* rather than merely drawn:
 * `endpoints` is where a peer dials, so the health panel can observe the real link; `manifest`
 * and `card` are the participant's own documents, so the spec viewer has something to read. All
 * three arrive the way everything here does — the host read them and wrote them down, and Studio
 * fetched none of them (ADR-0001 decisions 3 and 7). They are the user's copies of somebody
 * else's documents and are carried unvalidated: the viewer's checker says what they are.
 */
import { isJsonObject, type Json } from '@agora/schemas';

import {
  backboneOf,
  EMPTY_BACKBONE,
  type Backbone,
  type Connection,
  type Participant,
} from './backbone.ts';

/**
 * The one config shape this build reads, named and versioned so the next one can differ without
 * this one becoming ambiguous. Reachable to callers as `describeStudio().configFormat`.
 */
export const STUDIO_CONFIG_FORMAT = 'agora.studio.config/v1';

/** What reading a config produced: the cast, the format it declared, and what was ignored. */
export interface StudioConfigReading {
  /** The cast to draw. {@link EMPTY_BACKBONE} when there was no config, or none this build reads. */
  backbone: Backbone;
  /**
   * The AgentCards the config carried, by identity — the `cards` prop, ready to hand to `<App>`.
   * Empty when the config carried none, which is the ordinary case: a card is a document the
   * host read at the participant's own address, and a config that names nobody's card leaves
   * the spec viewer showing whatever else it was handed.
   */
  cards: Readonly<Record<string, unknown>>;
  /** The format the config declared, when this build recognized it. `null` when it did not. */
  format: string | null;
  /** Every part that was not understood, in the order it was found. Never an exception. */
  problems: readonly string[];
}

/** No cards at all — shared, and frozen, because a reading never mutates its own answer. */
const NO_CARDS: Readonly<Record<string, unknown>> = Object.freeze({});

/** No config at all — the fresh-install case, which is a state and not a failure. */
const NOTHING: StudioConfigReading = Object.freeze({
  backbone: EMPTY_BACKBONE,
  cards: NO_CARDS,
  format: null,
  problems: Object.freeze([]),
});

/** A config this build cannot read at all: nothing to draw, and the reason why. */
function refuse(problem: string): StudioConfigReading {
  return { backbone: EMPTY_BACKBONE, cards: NO_CARDS, format: null, problems: [problem] };
}

/** One field that should have been an array of entries, or `[]` plus a line saying it was not. */
function entriesAt(config: Record<string, Json>, field: string, problems: string[]): Json[] {
  const value = config[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(`${field} is not a list`);
    return [];
  }
  return value;
}

/** A trimmed non-empty string, or `undefined` — the only thing this reader accepts as a name. */
function text(value: Json | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * One participant's endpoint map: the URLs it publishes, keyed by transport (KCB §2).
 *
 * Open-ended on purpose, because a provider publishes the endpoints it actually serves and only
 * those — the map's keys are the provider's, not this reader's. An entry that is not a URL-ish
 * string costs the user that entry and a line saying so; the rest of the address survives.
 */
function endpointsAt(
  entry: Record<string, Json>,
  where: string,
  problems: string[],
): Record<string, string> | undefined {
  const value = entry.endpoints;
  if (value === undefined || value === null) return undefined;
  if (!isJsonObject(value)) {
    problems.push(`${where}.endpoints is not an object`);
    return undefined;
  }

  const endpoints: Record<string, string> = {};
  for (const [transport, url] of Object.entries(value)) {
    const address = text(url);
    if (address === undefined) {
      problems.push(`${where}.endpoints.${transport} is not an address`);
      continue;
    }
    endpoints[transport] = address;
  }
  return Object.keys(endpoints).length ? endpoints : undefined;
}

/**
 * Turn a user's config into a backbone.
 *
 * Accepts the raw text of the config, the object it parses to, or nothing at all. The result is
 * always drawable: participants without an identity, repeats of one identity, and links naming
 * somebody the config never described are each dropped with a line explaining it — Studio draws
 * what it was told about and declines to invent the rest.
 */
export function readStudioConfig(source?: unknown): StudioConfigReading {
  if (source === undefined || source === null || source === '') return NOTHING;

  let value: unknown = source;
  if (typeof source === 'string') {
    try {
      value = JSON.parse(source);
    } catch (err) {
      return refuse(`config is not JSON: ${(err as Error).message}`);
    }
  }
  if (!isJsonObject(value)) return refuse('config is not a JSON object');

  const format = text(value.format);
  if (format !== STUDIO_CONFIG_FORMAT) {
    return refuse(
      `config format ${format ?? '(none declared)'} is not ${STUDIO_CONFIG_FORMAT} — refusing to guess at it`,
    );
  }

  const problems: string[] = [];
  const participants: Participant[] = [];
  const cards: Record<string, unknown> = {};
  const known = new Set<string>();

  entriesAt(value, 'participants', problems).forEach((entry, index) => {
    const where = `participants[${index}]`;
    if (!isJsonObject(entry)) {
      problems.push(`${where} is not an object`);
      return;
    }
    const identity = text(entry.identity);
    if (!identity) {
      problems.push(`${where} declares no identity`);
      return;
    }
    if (known.has(identity)) {
      problems.push(`${where} repeats an identity the config already describes`);
      return;
    }
    known.add(identity);

    const participant: Participant = { identity };
    const label = text(entry.label);
    if (label) participant.label = label;

    const advertised = entry.capabilities;
    if (advertised !== undefined && advertised !== null) {
      if (!Array.isArray(advertised)) {
        problems.push(`${where}.capabilities is not a list`);
      } else {
        const capabilities = advertised
          .map(text)
          .filter((name): name is string => name !== undefined);
        if (capabilities.length !== advertised.length) {
          problems.push(`${where}.capabilities lists something that is not a capability name`);
        }
        if (capabilities.length) participant.capabilities = capabilities;
      }
    }

    const endpoints = endpointsAt(entry, where, problems);
    if (endpoints) participant.endpoints = endpoints;
    // The two documents ride through untouched: they are the participant's bytes as the host
    // copied them down, and reading them here would be this module ruling on a document it is
    // only carrying. `null` is a document as much as an object is — the checker says so.
    if (entry.manifest !== undefined) participant.manifest = entry.manifest;
    if (entry.card !== undefined) cards[identity] = entry.card;

    participants.push(participant);
  });

  const connections: Connection[] = [];
  entriesAt(value, 'connections', problems).forEach((entry, index) => {
    const where = `connections[${index}]`;
    if (!isJsonObject(entry)) {
      problems.push(`${where} is not an object`);
      return;
    }
    const from = text(entry.from);
    const to = text(entry.to);
    if (!from || !to) {
      problems.push(`${where} does not name both ends`);
      return;
    }
    for (const end of [from, to]) {
      if (!known.has(end)) problems.push(`${where} names ${end}, which the config does not describe`);
    }
    if (!known.has(from) || !known.has(to)) return;

    const connection: Connection = { from, to };
    const transport = text(entry.transport);
    if (transport) connection.transport = transport;
    connections.push(connection);
  });

  return {
    backbone: backboneOf({ participants, connections }),
    cards: Object.keys(cards).length ? cards : NO_CARDS,
    format,
    problems,
  };
}

/** The id of the `<script type="application/json">` block a host page embeds its config in. */
export const STUDIO_CONFIG_ELEMENT_ID = 'studio-config';

/**
 * The config the page was served with, if the host embedded one.
 *
 * A read of the block the *user's* page carries — their file, inlined by whatever serves Studio.
 * It is a DOM lookup and not a transport: Studio never goes and gets a config, it only notices
 * the one it was handed. A page without the block (this area's own `index.html` among them)
 * reads as no config, which is the empty backbone.
 */
export function embeddedConfigText(doc: Document): string | null {
  const block = doc.getElementById(STUDIO_CONFIG_ELEMENT_ID);
  return block?.textContent?.trim() || null;
}
