/**
 * What the examples are, as distinct from what they serve: the local inference itself, the shape
 * of the sample cast, and the two promises this directory makes to the rest of the tree.
 *
 * The promises are the interesting part. **One dependency**: an example consumes the *published*
 * `@agora/sdk` and nothing else in this repo, so it is compilable proof that the published
 * surface is sufficient — and the dependency points one way, since nothing in agora imports an
 * example. **Runnable as written**: `node src/notes.ts` starts a participant with no build step,
 * which holds only while the source stays inside what Node's strip-only loader accepts (no
 * parameter properties, no enums — `../../CLAUDE.md`). Both are asserted, not assumed.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EXAMPLE_APPS, exampleApp } from './apps.ts';
import { embedText, DIMENSIONS } from './embeddings.ts';
import { extractKeywords } from './keywords.ts';
import { composeNotes } from './notes.ts';
import { classifySentiment } from './sentiment.ts';
import { MANIFEST_PATH } from './wire.ts';

const PACKAGE = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { private?: boolean; dependencies: Record<string, string>; devDependencies: Record<string, string> };

describe('the local inference each example wraps', () => {
  it('composes one note per sentence, and says so when there is nothing to note', () => {
    expect(composeNotes('We shipped the gate. Ana owns the rollout.')).toBe(
      '- We shipped the gate.\n- Ana owns the rollout.',
    );
    expect(composeNotes('   ')).toBe('nothing to note');
  });

  it('ranks keywords by frequency, ignoring words nothing is about', () => {
    expect(extractKeywords('The router walks the ladder. The ladder is the router.')).toBe(
      'ladder, router, walks',
    );
    expect(extractKeywords('the and of')).toBe('no keywords');
  });

  it('classifies sentiment by sign, and calls an unopinionated sentence neutral', () => {
    expect(classifySentiment('The gate is green and fast')).toBe('positive (score 2)');
    expect(classifySentiment('a slow, broken regression')).toBe('negative (score -3)');
    expect(classifySentiment('the meeting is on tuesday')).toBe('neutral (score 0)');
  });

  it('embeds text as a deterministic unit vector of the width it advertises', () => {
    const vector = JSON.parse(embedText('a commons is a shared runtime')) as number[];

    expect(vector).toHaveLength(DIMENSIONS);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 3);
    // Deterministic: the same text embeds to the same vector, a different one does not.
    expect(embedText('a commons is a shared runtime')).toBe(JSON.stringify(vector));
    expect(embedText('something else entirely')).not.toBe(JSON.stringify(vector));
    expect(embedText('')).toBe(JSON.stringify(new Array<number>(DIMENSIONS).fill(0)));
  });
});

describe('the example cast', () => {
  it('is sample data: made-up peers, every one of them `example:` scoped', () => {
    // `../../CLAUDE.md`: no project name belongs in this tree except as sample data, marked as
    // such. A cast that stopped being obviously fictional would be a roster.
    for (const app of EXAMPLE_APPS) expect(app.identity.startsWith('example:')).toBe(true);
  });

  it('gives each example its own identity, capability and port, so the cast runs side by side', () => {
    const field = (pick: (app: (typeof EXAMPLE_APPS)[number]) => string | number): unknown[] =>
      EXAMPLE_APPS.map(pick);

    for (const values of [field((a) => a.identity), field((a) => a.capability), field((a) => a.port)]) {
      expect(new Set(values).size).toBe(values.length);
    }
    // The starter binds 8790; the cast starts above it so both can run at once.
    expect(Math.min(...EXAMPLE_APPS.map((app) => app.port))).toBeGreaterThan(8790);
  });

  it('covers both transports the spec names, and an output shape that is not prose', () => {
    const transports = new Set(EXAMPLE_APPS.flatMap((app) => app.transports));
    expect([...transports].sort()).toEqual(['a2a', 'mcp']);
    expect(EXAMPLE_APPS.some((app) => app.shape !== undefined)).toBe(true);
  });

  it('is looked up by identity, and never invents one it does not have', () => {
    expect(exampleApp('example:agent:notes-app')?.capability).toBe('notes.compose');
    expect(exampleApp('example:agent:not-here')).toBeUndefined();
  });
});

describe('what this directory promises the rest of the tree', () => {
  it('depends on the published SDK, and on no other package in this repo', () => {
    expect(PACKAGE.private).toBe(true);
    expect(Object.keys(PACKAGE.dependencies)).toEqual(['@agora/sdk']);
    // The schemas package is the SDK's own one dependency, used here only as the test's judge.
    expect(Object.keys(PACKAGE.devDependencies)).toEqual(['@agora/schemas']);
  });

  it('starts as written — `node src/notes.ts`, no build step, no loader flag', async () => {
    const entry = fileURLToPath(new URL('./notes.ts', import.meta.url));
    // PORT=0 binds ephemerally and the app announces the URL it got, which is how this test
    // finds a process it did not choose the port for.
    const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: '0' } });

    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        let errors = '';
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
          const [, announced] = /listening on (http:\/\/\S+)/.exec(out) ?? [];
          if (announced !== undefined) resolve(announced);
        });
        // Whatever Node says about the source is the diagnosis when it never starts — an
        // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX here means an example outgrew the strip-only loader.
        child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString('utf8')));
        child.on('error', reject);
        child.on('exit', (code) => reject(new Error(`exited with ${String(code)}: ${errors}`)));
      });

      const manifest = (await (await fetch(`${url}${MANIFEST_PATH}`)).json()) as {
        identity: string;
      };
      expect(manifest.identity).toBe('example:agent:notes-app');
    } finally {
      child.kill();
    }
  });
});
