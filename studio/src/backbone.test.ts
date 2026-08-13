/**
 * The backbone's two jobs: normalize what it was handed, and hold nothing of its own.
 *
 * The second one is the invariant the whole area rests on, so it is not asserted by reading
 * the module's values alone — a roster can hide in a component as easily as in a constant.
 * The last two tests read `studio/src` off disk and fail on any authored source that names a
 * participant or grows a verb that would carry a payload.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as studio from './index.ts';
import { backboneOf, EMPTY_BACKBONE, isEmpty, labelOf } from './backbone.ts';

/** Every authored source file in the area — the shell itself, never its tests or fixtures. */
function authoredSources(): { path: string; text: string }[] {
  // Paths, not URLs: jsdom replaces the global `URL`, and `node:fs` refuses the impostor.
  const dir = dirname(fileURLToPath(import.meta.url));
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({ path: name, text: readFileSync(join(dir, name), 'utf8') }));
}

describe('the backbone starts, and stays, empty until it is told otherwise', () => {
  it('is empty when nothing was configured at all', () => {
    for (const nothing of [undefined, null, {}, { participants: [], connections: [] }]) {
      const backbone = backboneOf(nothing);
      expect(backbone.participants).toEqual([]);
      expect(backbone.connections).toEqual([]);
      expect(isEmpty(backbone)).toBe(true);
    }
  });

  it('ships an empty default that cannot be mutated into a roster', () => {
    expect(isEmpty(EMPTY_BACKBONE)).toBe(true);
    expect(Object.isFrozen(EMPTY_BACKBONE)).toBe(true);
    expect(Object.isFrozen(EMPTY_BACKBONE.participants)).toBe(true);
  });
});

describe('the backbone is exactly the data it was handed', () => {
  const observed = {
    participants: [
      { identity: 'example:agent:alpha', label: 'Alpha', capabilities: ['summarize.text'] },
      { identity: 'example:service:beta' },
    ],
    connections: [{ from: 'example:agent:alpha', to: 'example:service:beta', transport: 'a2a' }],
  };

  it('keeps what it was given, in the order it was given', () => {
    const backbone = backboneOf(observed);
    expect(backbone.participants.map((p) => p.identity)).toEqual([
      'example:agent:alpha',
      'example:service:beta',
    ]);
    expect(backbone.connections).toHaveLength(1);
    expect(isEmpty(backbone)).toBe(false);
  });

  it('drops the unnameable and collapses a repeated identity to one sighting', () => {
    const backbone = backboneOf({
      participants: [
        { identity: '  example:agent:alpha  ', label: 'first' },
        { identity: 'example:agent:alpha', label: 'second' },
        { identity: '   ' },
      ],
    });
    expect(backbone.participants).toEqual([{ identity: 'example:agent:alpha', label: 'first' }]);
  });

  it('draws no edge to an end it never saw', () => {
    // Studio observes; it does not infer. A link to an unobserved participant would be Studio
    // asserting a node nobody reported.
    const backbone = backboneOf({
      participants: [{ identity: 'example:agent:alpha' }],
      connections: [{ from: 'example:agent:alpha', to: 'example:service:absent' }],
    });
    expect(backbone.connections).toEqual([]);
  });

  it('labels a participant with its own name, else its identity', () => {
    expect(labelOf({ identity: 'example:agent:alpha', label: 'Alpha' })).toBe('Alpha');
    expect(labelOf({ identity: 'example:agent:alpha', label: '  ' })).toBe('example:agent:alpha');
    expect(labelOf({ identity: 'example:agent:alpha' })).toBe('example:agent:alpha');
  });
});

describe('the shell holds no cast of its own', () => {
  it('exports components and functions over caller data — never participant data', () => {
    expect(studio.describeStudio().bundledParticipants).toBe(0);
    const values = Object.entries(studio).filter(([, value]) => typeof value !== 'function');
    expect(values).toEqual([['EMPTY_BACKBONE', EMPTY_BACKBONE]]);
  });

  it('names no participant anywhere in its authored source', () => {
    // CLAUDE.md's capability-never-caller rule, checked the way a grep would: a KINP identity
    // literal in the shell's own source IS a hard-wired roster, whoever it points at. The
    // shape is the test, so this stays honest without this file naming a project either.
    const identityLiteral = /['"`][a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*['"`]/i;
    const offenders = authoredSources()
      .filter(({ text }) => identityLiteral.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('grows no verb that could carry a payload between two participants', () => {
    // ADR-0001 decisions 3 and 7, asserted the way `clients/sdk/src/index.test.ts` does:
    // "we only observe" is what every traffic hub said before it grew an invoke().
    expect(studio.describeStudio().relaysPayloads).toBe(false);
    const relaying = Object.keys(studio).filter((name) =>
      /relay|proxy|invoke|forward|dispatch|^call|^send|^dial|^request/i.test(name),
    );
    expect(relaying).toEqual([]);

    const transports = authoredSources().filter(({ text }) =>
      /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(text),
    );
    expect(transports.map(({ path }) => path)).toEqual([]);
  });
});
