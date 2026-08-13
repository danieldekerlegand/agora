/**
 * The example topologies — several **sample** fabrics arranged out of the cast next door, each
 * one written down as a config Agora Studio loads exactly the way it loads a user's own.
 *
 * A topology here is only three things: which of the thin participants are running, which of
 * them dial which, and — because a peer that cannot be dialed cannot be watched — where each
 * one publishes. That last part is what turns a picture into an observation: the config carries
 * every participant's endpoint map and the documents it serves (its KCB manifest, and its
 * AgentCard where it serves A2A), so Studio draws the graph, has a real address to observe each
 * link at, and has the participants' own words to render in the spec viewer. Nothing is relayed
 * and nothing is registered: the config is a description, and whoever reads it dials directly
 * (ADR-0001 decisions 2-4).
 *
 * Everything in here is **sample data**, and every config says so in its own `note`. agora ships
 * no roster (`../../../CLAUDE.md`: capability, never caller) — these exist so a newcomer sees a
 * populated Studio in one command instead of wiring a fabric first, and the config to describe
 * *your* fabric has the same shape with your own peers in it.
 *
 * Run one:
 *
 * ```sh
 * node src/topologies.ts                    # the topologies in this file
 * node src/topologies.ts notes-desk         # start that cast, print the config for what it bound
 * node src/topologies.ts notes-desk --print # just the config, for the ports the cast binds by default
 * ```
 *
 * The printed document goes on stdout and nothing else does, so it pipes straight into a file —
 * which is how `../configs/*.studio.json` are kept true (`topologies.test.ts` fails on drift).
 */
import { pathToFileURL } from 'node:url';

import { closeApps, EXAMPLE_APPS, startApps } from './apps.ts';
import { EMBEDDINGS_SERVICE } from './embeddings.ts';
import { KEYWORDS_SERVICE } from './keywords.ts';
import { NOTES_APP } from './notes.ts';
import { SENTIMENT_SERVICE } from './sentiment.ts';
import { appCard, appManifest, type LocalInferenceApp, type StartedApp } from './wire.ts';

/**
 * The config format Studio reads, by name and version.
 *
 * Restated here rather than imported: an example depends on the published `@agora/sdk` and
 * nothing else in this repo, and this is a *wire* format — the tag is what a document declares
 * itself to be, so a reader that does not recognize it refuses rather than guessing. Studio's
 * own reader is what checks these files against it (`studio/src/examples.test.ts`), so a drift
 * between the two fails a gate instead of a user's page.
 */
export const STUDIO_CONFIG_FORMAT = 'agora.studio.config/v1';

/** What every one of these configs says about itself, so nobody mistakes a demo for a roster. */
export const SAMPLE_NOTE =
  'Sample data: a made-up cast of thin local-inference examples, not a roster. ' +
  'agora ships with no participants — describe your own fabric in a config with this shape.';

/** One participant as a config describes it: who it is, where it publishes, what it published. */
export interface StudioConfigParticipant {
  identity: string;
  label: string;
  capabilities: string[];
  /** The KCB endpoint map it advertises — where a *peer* dials it (KCB §2). */
  endpoints?: Record<string, string>;
  /** Its KCB manifest body, as the manifest route serves it. */
  manifest?: unknown;
  /** Its A2A AgentCard, carrying that manifest — present for the peers that serve A2A. */
  card?: unknown;
}

/** One link between two of them, and the transport they hold it over. */
export interface StudioConfigConnection {
  from: string;
  to: string;
  transport?: string;
}

/** A whole fabric, written down — the document Studio's runtime config path reads. */
export interface StudioConfig {
  format: string;
  /** Which of the example topologies this is. Studio ignores it; a reader should not. */
  name: string;
  /** {@link SAMPLE_NOTE} — this is a demonstration, and it is marked as one in the file. */
  note: string;
  participants: StudioConfigParticipant[];
  connections: StudioConfigConnection[];
}

/** A peer the cast talks to that is not one of the examples — named, and nothing more. */
export interface ExampleOutsider {
  identity: string;
  label: string;
}

/** One arrangement of the sample cast: who is up, who is outside it, and who dials whom. */
export interface ExampleTopology {
  /** The file name and the argument — `node src/topologies.ts <name>`. */
  name: string;
  title: string;
  /** One line on what it is meant to show. */
  summary: string;
  /** The thin participants it starts, in the order a reader should meet them. */
  apps: readonly LocalInferenceApp[];
  /** Peers on the graph that nothing here runs — an outside end, with no address to dial. */
  outsiders?: readonly ExampleOutsider[];
  /** The connections between them. Studio draws these; it is on none of them. */
  links: readonly StudioConfigConnection[];
}

/**
 * The topologies, smallest first — an app and the services it uses, a chain across both
 * transports, and the whole cast with an outside peer beside it.
 */
export const EXAMPLE_TOPOLOGIES: readonly ExampleTopology[] = Object.freeze([
  Object.freeze({
    name: 'notes-desk',
    title: 'Notes desk',
    summary: 'One sample app and the two services it dials — one over A2A, one over MCP.',
    apps: [NOTES_APP, KEYWORDS_SERVICE, SENTIMENT_SERVICE],
    links: [
      { from: NOTES_APP.identity, to: KEYWORDS_SERVICE.identity, transport: 'a2a' },
      { from: NOTES_APP.identity, to: SENTIMENT_SERVICE.identity, transport: 'mcp' },
    ],
  }),
  Object.freeze({
    name: 'embedding-pipeline',
    title: 'Embedding pipeline',
    summary:
      'A chain: notes to keywords to embeddings, crossing from A2A to MCP and ending in a shape that is not prose.',
    apps: [NOTES_APP, KEYWORDS_SERVICE, EMBEDDINGS_SERVICE],
    links: [
      { from: NOTES_APP.identity, to: KEYWORDS_SERVICE.identity, transport: 'a2a' },
      { from: KEYWORDS_SERVICE.identity, to: EMBEDDINGS_SERVICE.identity, transport: 'mcp' },
    ],
  }),
  Object.freeze({
    name: 'whole-cast',
    title: 'The whole cast',
    summary:
      'Every example running at once, plus a peer nothing here runs — a participant Studio was told about and has no address for.',
    apps: EXAMPLE_APPS,
    outsiders: [{ identity: 'example:agent:outside-peer', label: 'An outside peer (sample)' }],
    links: [
      { from: NOTES_APP.identity, to: KEYWORDS_SERVICE.identity, transport: 'a2a' },
      { from: NOTES_APP.identity, to: SENTIMENT_SERVICE.identity, transport: 'mcp' },
      { from: NOTES_APP.identity, to: EMBEDDINGS_SERVICE.identity, transport: 'a2a' },
      { from: KEYWORDS_SERVICE.identity, to: EMBEDDINGS_SERVICE.identity, transport: 'mcp' },
      { from: NOTES_APP.identity, to: 'example:agent:outside-peer' },
    ],
  }),
]);

/** The one with this name, or `undefined` — a topology is looked up, never guessed. */
export function exampleTopology(name: string): ExampleTopology | undefined {
  return EXAMPLE_TOPOLOGIES.find((topology) => topology.name === name);
}

/** Where each participant is running, by identity — what {@link startApps} just bound. */
export function urlsOf(started: readonly StartedApp[]): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const one of started) urls[one.app.identity] = one.url;
  return urls;
}

/**
 * Write a topology down as a Studio config.
 *
 * Each participant carries what it publishes — its endpoint map, its manifest, and its card
 * where it serves one — read off the participant's own definition at the URL it is running on.
 * Pass the URLs {@link startApps} bound (via {@link urlsOf}) for a cast on ephemeral ports;
 * without them every peer is described at the port it binds by default, which is what the
 * checked-in `../configs/*.studio.json` say.
 *
 * An outsider is described by name alone. It has no address, because nothing here runs it —
 * Studio draws it as a participant it was told about and cannot reach, which is the honest
 * reading of a peer somebody mentioned.
 */
export function studioConfigOf(
  topology: ExampleTopology,
  urls: Readonly<Record<string, string>> = {},
): StudioConfig {
  const participants: StudioConfigParticipant[] = topology.apps.map((app) => {
    const baseUrl = urls[app.identity] ?? `http://127.0.0.1:${String(app.port)}`;
    const manifest = appManifest(app, baseUrl);
    const participant: StudioConfigParticipant = {
      identity: app.identity,
      label: app.label,
      capabilities: [app.capability],
      endpoints: { ...manifest.endpoints },
      manifest,
    };
    // Only the A2A peers publish a card; an MCP-only peer serves the bare manifest and says so
    // with a 404 at the card route, so writing one down for it would describe a route nobody
    // answers (`wire.ts`).
    if (app.transports.includes('a2a')) participant.card = appCard(app, baseUrl);
    return participant;
  });

  for (const outsider of topology.outsiders ?? []) {
    participants.push({ ...outsider, capabilities: [] });
  }

  return {
    format: STUDIO_CONFIG_FORMAT,
    name: topology.name,
    note: SAMPLE_NOTE,
    participants,
    connections: [...topology.links],
  };
}

// ─────────────────────────────── `node src/topologies.ts` ───────────────────────────────

/** The topologies, as the usage text lists them. */
function listing(): string {
  return EXAMPLE_TOPOLOGIES.map(
    (topology) => `  ${topology.name}\n      ${topology.title} — ${topology.summary}`,
  ).join('\n');
}

/**
 * Start a topology and print its config, or print the config on its own.
 *
 * The document goes to stdout and every word about it goes to stderr, so
 * `node src/topologies.ts notes-desk --print > my-fabric.json` yields a file Studio reads.
 */
async function run(argv: readonly string[]): Promise<void> {
  const name = argv.find((arg) => !arg.startsWith('-'));
  const printOnly = argv.includes('--print');

  if (name === undefined) {
    console.error(
      `usage: node src/topologies.ts <topology> [--print]\n\n${listing()}\n\n${SAMPLE_NOTE}`,
    );
    return;
  }

  const topology = exampleTopology(name);
  if (!topology) {
    console.error(`no example topology \`${name}\`. There is:\n${listing()}`);
    process.exitCode = 1;
    return;
  }

  if (printOnly) {
    console.log(JSON.stringify(studioConfigOf(topology), null, 2));
    return;
  }

  const started = await startApps(topology.apps);
  const stop = (): void => {
    void closeApps(started);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.error(`${topology.title} — ${topology.summary}`);
  for (const one of started) console.error(`  ${one.app.identity} listening on ${one.url}`);
  console.error('\nThe config below describes what is running. Load it into Studio.\n');
  console.log(JSON.stringify(studioConfigOf(topology, urlsOf(started)), null, 2));
}

const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  void run(process.argv.slice(2)).catch((err: unknown) => {
    console.error('failed to start the topology:', err);
    process.exitCode = 1;
  });
}
