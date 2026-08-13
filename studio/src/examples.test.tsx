/**
 * The example setups, loaded the way a user's config is loaded — and the line that keeps them
 * examples.
 *
 * `examples/local-inference/configs/*.studio.json` describe a small sample fabric of thin
 * local-inference participants, so somebody who has wired nothing yet can see a populated Studio
 * in one command. They are **data, and somebody else's data**: they live in `examples/`, nothing
 * under `studio/src` imports them, they arrive here as file text the way a host hands in the
 * block its page carries, and this build reads them with the same `readStudioConfig` it reads
 * any config with. That is the whole claim being tested — that an example setup is a config and
 * not a bundled roster — so the last test is the one that matters most: with no config, Studio
 * is still empty.
 *
 * The configs' *truth* is the examples' own gate (`examples/local-inference/src/topologies.test.ts`
 * starts the cast and checks every document against what the processes serve). What is checked
 * here is only what Studio makes of them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.tsx';
import { isEmpty } from './backbone.ts';
import { readStudioConfig, STUDIO_CONFIG_FORMAT } from './config.ts';
import { specViewOf, advertisementOf } from './specs.ts';
import { topologyOf } from './topology.ts';

/** Where the example setups live: `examples/`, two directories out — never in this area. */
// Paths, not URLs: jsdom replaces the global `URL`, and `node:fs` refuses the impostor.
const AREA = dirname(dirname(fileURLToPath(import.meta.url)));
const SETUPS = join(dirname(AREA), 'examples', 'local-inference', 'configs');

/** Every example setup, as text — read off disk, exactly as a host would read a user's file. */
function setups(): { name: string; text: string }[] {
  return readdirSync(SETUPS)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(SETUPS, name), 'utf8') }));
}

const SETUP_FILES = setups();

afterEach(() => {
  document.body.innerHTML = '';
});

describe('an example setup is read by the same config path a user config is', () => {
  it('ships several of them, and every one declares the format this build reads', () => {
    expect(SETUP_FILES.length).toBeGreaterThan(1);
    for (const { name, text } of SETUP_FILES) {
      const reading = readStudioConfig(text);
      expect(reading.format, name).toBe(STUDIO_CONFIG_FORMAT);
      expect(reading.problems, name).toEqual([]);
    }
  });

  it('draws exactly the participants and connections each file describes', () => {
    for (const { name, text } of SETUP_FILES) {
      const described = JSON.parse(text) as {
        participants: { identity: string; label: string }[];
        connections: { from: string; to: string }[];
      };
      const { backbone } = readStudioConfig(text);

      expect(backbone.participants.map((one) => one.identity), name).toEqual(
        described.participants.map((one) => one.identity),
      );
      expect(backbone.connections.length, name).toBe(described.connections.length);

      const { nodes, edges } = topologyOf({ observed: backbone });
      expect(nodes.map((node) => node.identity), name).toEqual(
        described.participants.map((one) => one.identity),
      );
      expect(edges.map((edge) => `${edge.from} → ${edge.to}`), name).toEqual(
        described.connections.map((link) => `${link.from} → ${link.to}`),
      );
      // Nobody indexed these: they were described, which is what an observed node means.
      for (const node of nodes) expect(node.discovered, `${name} ${node.identity}`).toBe(false);
    }
  });

  it('keeps the address each described peer publishes, so its links can be watched', () => {
    for (const { name, text } of SETUP_FILES) {
      const { nodes } = topologyOf({ observed: readStudioConfig(text).backbone });
      const addressed = nodes.filter((node) => node.reachable);

      expect(addressed.length, name).toBeGreaterThan(0);
      for (const node of addressed) {
        const dialable = Object.values(node.address.endpoints).filter(Boolean);
        expect(dialable.length, `${name} ${node.identity}`).toBeGreaterThan(0);
        for (const endpoint of dialable) expect(endpoint).toMatch(/^https?:\/\//);
      }
    }
  });

  it('carries each peer into the spec viewer with the documents the file wrote down', () => {
    for (const { name, text } of SETUP_FILES) {
      const { backbone, cards } = readStudioConfig(text);
      const { nodes } = topologyOf({ observed: backbone });

      const read = nodes
        .map((node) => specViewOf(advertisementOf(node, cards[node.identity])))
        .filter((view) => view.contracts.length > 0);
      expect(read.length, name).toBeGreaterThan(0);

      for (const view of read) {
        // Every one of these is a KCB participant, and it is the document that says so.
        expect(view.contracts.map((contract) => contract.spec), `${name} ${view.identity}`).toContain(
          'kcb',
        );
        expect(view.artifacts.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('loading one populates the stage', () => {
  it('shows the graph, the health of every link, and what a participant advertises', () => {
    const setup = SETUP_FILES[0];
    expect(setup).toBeDefined();
    const { backbone, cards, problems } = readStudioConfig(setup?.text);
    render(<App backbone={backbone} cards={cards} problems={problems} />);

    const stage = screen.getByRole('main', { name: 'studio stage' });
    // The counts are the graph's own line, and they are the config's own numbers.
    expect(stage.textContent).toContain(
      `${String(backbone.participants.length)} participants · ${String(
        backbone.connections.length,
      )} connections`,
    );
    expect(
      within(stage).getAllByRole('listitem').length,
    ).toBeGreaterThanOrEqual(backbone.participants.length + backbone.connections.length);

    // Every described link is on the health panel — unwatched until a host hands in a probe,
    // which is the honest reading and not a green one.
    const health = within(stage).getByRole('list', { name: 'connection health' });
    expect(within(health).getAllByRole('listitem')).toHaveLength(backbone.connections.length);

    const specs = within(stage).getByRole('region', { name: 'spec viewer' });
    expect(specs.textContent).toContain('kcb');
    expect(within(stage).queryByRole('region', { name: 'config problems' })).toBeNull();
  });
});

describe('the examples are sample data, and Studio still ships empty', () => {
  it('names nobody real: every peer in every setup is `example:` scoped', () => {
    // `../../CLAUDE.md`: no project name belongs in this tree except as sample data, marked as
    // such. These files are marked in three ways — the directory, the scope, and their own note.
    for (const { name, text } of SETUP_FILES) {
      const { backbone } = readStudioConfig(text);
      for (const participant of backbone.participants) {
        expect(participant.identity.startsWith('example:'), `${name} ${participant.identity}`).toBe(
          true,
        );
      }
      expect(JSON.parse(text)).toHaveProperty('note');
    }
  });

  it('is not shipped by this area: no setup lives here, and the served page carries none', () => {
    const page = readFileSync(join(AREA, 'index.html'), 'utf8');
    expect(page).not.toContain(STUDIO_CONFIG_FORMAT);
    expect(readdirSync(join(AREA, 'src')).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('draws nothing at all until one is loaded — an example is a config, not a default', () => {
    expect(isEmpty(readStudioConfig(undefined).backbone)).toBe(true);
    expect(readStudioConfig(undefined).cards).toEqual({});

    render(<App />);
    const stage = screen.getByRole('main', { name: 'studio stage' });
    expect(within(stage).getByRole('status').textContent).toContain(
      '0 participants · 0 connections',
    );
  });
});
