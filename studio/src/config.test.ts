/**
 * Ingestion: a user's config in, the cast out — and nothing at all when there is no config.
 *
 * Every config here is synthetic and named after nobody: the point of the exercise is that the
 * backbone is exactly what the file said, whatever the file says. The config itself lives with
 * the user, so the last test checks the one thing that would quietly betray that — a config
 * shipped inside this area.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { describeStudio } from './index.ts';
import { isEmpty } from './backbone.ts';
import {
  embeddedConfigText,
  readStudioConfig,
  STUDIO_CONFIG_ELEMENT_ID,
  STUDIO_CONFIG_FORMAT,
} from './config.ts';

/** A config the way a user writes one: their own file, their own cast, nothing from here. */
function config(body: Record<string, unknown>): string {
  return JSON.stringify({ format: STUDIO_CONFIG_FORMAT, ...body });
}

const ALPHA = { identity: 'example:agent:alpha', label: 'Alpha', capabilities: ['summarize.text'] };
const BETA = { identity: 'example:service:beta' };
const LINK = { from: 'example:agent:alpha', to: 'example:service:beta', transport: 'a2a' };

describe('no config is a state, not a failure', () => {
  it('reads nothing at all as the empty backbone', () => {
    for (const nothing of [undefined, null, '']) {
      const reading = readStudioConfig(nothing);
      expect(isEmpty(reading.backbone)).toBe(true);
      expect(reading.problems).toEqual([]);
      expect(reading.format).toBeNull();
    }
  });

  it('reads a config that describes nobody as the empty backbone', () => {
    const reading = readStudioConfig(config({ participants: [], connections: [] }));
    expect(isEmpty(reading.backbone)).toBe(true);
    expect(reading.problems).toEqual([]);
    expect(reading.format).toBe(STUDIO_CONFIG_FORMAT);
  });
});

describe('the cast is exactly the config, and moves with it', () => {
  it('derives participants and connections from what the user wrote', () => {
    const { backbone, problems } = readStudioConfig(
      config({ participants: [ALPHA, BETA], connections: [LINK] }),
    );
    expect(problems).toEqual([]);
    expect(backbone.participants).toEqual([
      { identity: 'example:agent:alpha', label: 'Alpha', capabilities: ['summarize.text'] },
      { identity: 'example:service:beta' },
    ]);
    expect(backbone.connections).toEqual([
      { from: 'example:agent:alpha', to: 'example:service:beta', transport: 'a2a' },
    ]);
  });

  it('gains a participant when the config gains one, and loses it when the config does', () => {
    const two = readStudioConfig(config({ participants: [ALPHA, BETA] })).backbone;
    expect(two.participants.map((p) => p.identity)).toEqual([
      'example:agent:alpha',
      'example:service:beta',
    ]);

    const three = readStudioConfig(
      config({ participants: [ALPHA, BETA, { identity: 'example:agent:gamma' }] }),
    ).backbone;
    expect(three.participants.map((p) => p.identity)).toEqual([
      'example:agent:alpha',
      'example:service:beta',
      'example:agent:gamma',
    ]);

    const one = readStudioConfig(config({ participants: [BETA] })).backbone;
    expect(one.participants.map((p) => p.identity)).toEqual(['example:service:beta']);
  });

  it('takes the config as text or as the object it parses to', () => {
    const asText = readStudioConfig(config({ participants: [ALPHA] }));
    const asObject = readStudioConfig({
      format: STUDIO_CONFIG_FORMAT,
      participants: [ALPHA],
    });
    expect(asObject.backbone).toEqual(asText.backbone);
  });
});

describe('an unreadable config costs the user an entry and an explanation, never a crash', () => {
  it('refuses a format it does not know rather than guessing at it', () => {
    for (const unknown of [
      JSON.stringify({ participants: [ALPHA] }),
      JSON.stringify({ format: 'something.else/v9', participants: [ALPHA] }),
    ]) {
      const reading = readStudioConfig(unknown);
      expect(isEmpty(reading.backbone)).toBe(true);
      expect(reading.format).toBeNull();
      expect(reading.problems).toHaveLength(1);
      expect(reading.problems[0]).toContain(STUDIO_CONFIG_FORMAT);
    }
  });

  it('says so when the config is not JSON, or not a JSON object', () => {
    expect(readStudioConfig('{ not json').problems[0]).toContain('not JSON');
    expect(readStudioConfig('[]').problems[0]).toContain('not a JSON object');
    expect(readStudioConfig(42).problems[0]).toContain('not a JSON object');
  });

  it('drops what it cannot place and reports each one', () => {
    const { backbone, problems } = readStudioConfig(
      config({
        participants: [
          ALPHA,
          { identity: '  ' },
          { identity: 'example:agent:alpha', label: 'a second sighting' },
          { identity: 'example:agent:gamma', capabilities: 'summarize.text' },
          'not an object',
        ],
        connections: [
          { from: 'example:agent:alpha', to: 'example:service:absent' },
          { from: 'example:agent:alpha' },
        ],
      }),
    );

    expect(backbone.participants.map((p) => p.identity)).toEqual([
      'example:agent:alpha',
      'example:agent:gamma',
    ]);
    expect(backbone.connections).toEqual([]);
    expect(problems).toEqual([
      'participants[1] declares no identity',
      'participants[2] repeats an identity the config already describes',
      'participants[3].capabilities is not a list',
      'participants[4] is not an object',
      'connections[0] names example:service:absent, which the config does not describe',
      'connections[1] does not name both ends',
    ]);
  });

  it('says so when a list is not a list', () => {
    const { problems } = readStudioConfig(config({ participants: {}, connections: 'none' }));
    expect(problems).toEqual(['participants is not a list', 'connections is not a list']);
  });
});

describe('the config lives with the user, not in this package', () => {
  it('reads the block a host page embeds, and nothing when there is none', () => {
    document.body.innerHTML = `<script type="application/json" id="${STUDIO_CONFIG_ELEMENT_ID}">${config(
      { participants: [ALPHA] },
    )}</script>`;
    const embedded = embeddedConfigText(document);
    expect(embedded).not.toBeNull();
    expect(readStudioConfig(embedded).backbone.participants).toHaveLength(1);

    document.body.innerHTML = '';
    expect(embeddedConfigText(document)).toBeNull();
    expect(isEmpty(readStudioConfig(embeddedConfigText(document)).backbone)).toBe(true);
  });

  it('ships no config of its own — the page this area serves carries none', () => {
    // Paths, not URLs: jsdom replaces the global `URL` and `node:fs` refuses the impostor.
    const area = dirname(dirname(fileURLToPath(import.meta.url)));
    const page = readFileSync(join(area, 'index.html'), 'utf8');
    expect(page).not.toContain(STUDIO_CONFIG_ELEMENT_ID);
    expect(page).not.toContain(STUDIO_CONFIG_FORMAT);
  });

  it('names the format it reads, so a user can write one without reading this source', () => {
    expect(describeStudio().configFormat).toBe(STUDIO_CONFIG_FORMAT);
  });
});
