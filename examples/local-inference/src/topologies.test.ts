/**
 * The example topologies, held to the two things a sample fabric owes anybody who loads one.
 *
 * **It is true of what runs.** A config that described a cast nobody serves would be a picture
 * of nothing — so each topology is started on ephemeral ports and every claim in its config is
 * checked against what the processes actually answer with: the endpoint map, the manifest at
 * the manifest route, the card at the card route. The documents are validated by
 * `@agora/schemas`, the judge, not by this test.
 *
 * **It is obviously sample data.** Every peer is `example:` scoped and every file says so in its
 * own `note` — agora ships no roster (`../../../CLAUDE.md`), and a demonstration cast that
 * stopped reading as a demonstration would be one.
 *
 * The checked-in `../configs/*.studio.json` are the copy-and-load artifacts, so they are held to
 * `studioConfigOf` byte for byte; Studio's own reader is what checks them against the format
 * (`studio/src/examples.test.ts`), which is the only place the two ends of this meet.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseManifest, parseManifestBody } from '@agora/schemas';
import { afterEach, describe, expect, it } from 'vitest';

import { closeApps, startApps } from './apps.ts';
import {
  EXAMPLE_TOPOLOGIES,
  exampleTopology,
  SAMPLE_NOTE,
  STUDIO_CONFIG_FORMAT,
  studioConfigOf,
  urlsOf,
  type ExampleTopology,
  type StudioConfig,
} from './topologies.ts';
import { CARD_PATH, MANIFEST_PATH, type StartedApp } from './wire.ts';

const CONFIGS = new URL('../configs/', import.meta.url);

/** One checked-in config, as a file on disk is read — the way a host reads a user's own. */
function configFile(name: string): { path: string; text: string } {
  const path = fileURLToPath(new URL(`${name}.studio.json`, CONFIGS));
  return { path, text: readFileSync(path, 'utf8') };
}

let running: StartedApp[] = [];

afterEach(async () => {
  await closeApps(running);
  running = [];
});

describe('the example topologies are sample data, arranged out of the sample cast', () => {
  it('names each one once, and every peer on every one of them is `example:` scoped', () => {
    const names = EXAMPLE_TOPOLOGIES.map((topology) => topology.name);
    expect(new Set(names).size).toBe(names.length);

    for (const topology of EXAMPLE_TOPOLOGIES) {
      const identities = studioConfigOf(topology).participants.map((one) => one.identity);
      for (const identity of identities) expect(identity.startsWith('example:')).toBe(true);
      expect(new Set(identities).size).toBe(identities.length);
    }
  });

  it('links only peers the same config describes, so nothing draws to somebody unnamed', () => {
    for (const topology of EXAMPLE_TOPOLOGIES) {
      const config = studioConfigOf(topology);
      const described = new Set(config.participants.map((one) => one.identity));
      expect(config.connections.length).toBeGreaterThan(0);
      for (const link of config.connections) {
        expect(described.has(link.from), `${config.name}: ${link.from}`).toBe(true);
        expect(described.has(link.to), `${config.name}: ${link.to}`).toBe(true);
      }
    }
  });

  it('says in the document itself that it is a demonstration and not a roster', () => {
    for (const topology of EXAMPLE_TOPOLOGIES) {
      const config = studioConfigOf(topology);
      expect(config.format).toBe(STUDIO_CONFIG_FORMAT);
      expect(config.note).toBe(SAMPLE_NOTE);
      expect(config.note).toContain('not a roster');
    }
  });

  it('describes a peer nothing here runs by name alone — no address invented for it', () => {
    const outside = EXAMPLE_TOPOLOGIES.flatMap((topology) => topology.outsiders ?? []);
    expect(outside.length).toBeGreaterThan(0);

    for (const topology of EXAMPLE_TOPOLOGIES) {
      const described = new Map(
        studioConfigOf(topology).participants.map((one) => [one.identity, one]),
      );
      for (const peer of topology.outsiders ?? []) {
        const entry = described.get(peer.identity);
        expect(entry?.endpoints).toBeUndefined();
        expect(entry?.manifest).toBeUndefined();
        expect(entry?.card).toBeUndefined();
      }
    }
  });

  it('is looked up by name, and never invents one it does not have', () => {
    expect(exampleTopology('notes-desk')?.apps.length).toBeGreaterThan(1);
    expect(exampleTopology('no-such-topology')).toBeUndefined();
  });
});

describe('what the config claims, `@agora/schemas` reads back', () => {
  it.each(EXAMPLE_TOPOLOGIES.map((topology) => [topology.name, topology] as const))(
    '%s — every described document is a valid KCB manifest or AgentCard',
    (_name, topology: ExampleTopology) => {
      const config = studioConfigOf(topology);
      const served = new Set(topology.apps.map((app) => app.identity));

      for (const participant of config.participants) {
        if (!served.has(participant.identity)) continue;

        const manifest = parseManifestBody(participant.manifest);
        expect(manifest.identity).toBe(participant.identity);
        expect(manifest.endpoints).toEqual(participant.endpoints);
        expect(manifest.capabilities?.map((capability) => capability.name)).toEqual(
          participant.capabilities,
        );

        // A card is present exactly for the peers that serve A2A, and the manifest riding
        // inside it is the same document (KCB §2/§6).
        const servesA2a = participant.endpoints?.a2a !== undefined;
        expect(participant.card !== undefined).toBe(servesA2a);
        if (servesA2a) expect(parseManifest(participant.card)).toEqual(manifest);
      }
    },
  );
});

describe('the config is true of the cast it describes', () => {
  it.each(EXAMPLE_TOPOLOGIES.map((topology) => [topology.name, topology] as const))(
    '%s — every participant serves what the config says it serves',
    async (_name, topology: ExampleTopology) => {
      // Port 0 for all of them, so the gate never fights whatever is bound — and the config is
      // written for the URLs they actually got, which is what the runner does for a user.
      running = await startApps(topology.apps, 0);
      const config = studioConfigOf(topology, urlsOf(running));
      const started = new Map(running.map((one) => [one.app.identity, one]));

      for (const participant of config.participants) {
        const one = started.get(participant.identity);
        if (!one) continue;

        expect(participant.endpoints?.manifest).toBe(`${one.url}${MANIFEST_PATH}`);
        const body: unknown = await (await fetch(`${one.url}${MANIFEST_PATH}`)).json();
        expect(body).toEqual(participant.manifest);

        const card = participant.endpoints?.a2a;
        if (card === undefined) {
          // An MCP-only peer publishes no card and answers none — describing one would be
          // describing a route nobody serves.
          expect((await fetch(`${one.url}${CARD_PATH}`)).status).toBe(404);
          continue;
        }
        expect(card).toBe(`${one.url}${CARD_PATH}`);
        expect(await (await fetch(card)).json()).toEqual(participant.card);
      }
    },
  );
});

describe('the checked-in configs are the ones this file generates', () => {
  it('has one file per topology, and no file for a topology that is gone', () => {
    const files = readdirSync(fileURLToPath(CONFIGS)).filter((name) => name.endsWith('.json'));
    expect(files.sort()).toEqual(
      EXAMPLE_TOPOLOGIES.map((topology) => `${topology.name}.studio.json`).sort(),
    );
  });

  it.each(EXAMPLE_TOPOLOGIES.map((topology) => [topology.name, topology] as const))(
    '%s.studio.json is exactly what `node src/topologies.ts %s --print` writes',
    (name, topology: ExampleTopology) => {
      const { text } = configFile(name);
      const written = JSON.parse(text) as StudioConfig;
      expect(
        written,
        `configs/${name}.studio.json has drifted — regenerate it with ` +
          `\`node src/topologies.ts ${name} --print > configs/${name}.studio.json\``,
      ).toEqual(studioConfigOf(topology));
      // Two-space JSON with a trailing newline: the file is meant to be read and edited.
      expect(text).toBe(`${JSON.stringify(studioConfigOf(topology), null, 2)}\n`);
    },
  );

  it('describes the cast at the ports it binds by default, so the files run as written', () => {
    for (const topology of EXAMPLE_TOPOLOGIES) {
      const described = new Map(
        (JSON.parse(configFile(topology.name).text) as StudioConfig).participants.map((one) => [
          one.identity,
          one,
        ]),
      );
      for (const app of topology.apps) {
        expect(described.get(app.identity)?.endpoints?.manifest).toBe(
          `http://127.0.0.1:${String(app.port)}${MANIFEST_PATH}`,
        );
      }
    }
  });
});
