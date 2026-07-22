/**
 * `kcs:worlds-to-fabric`, run.
 *
 * The first test is the story: the whole pressure test executes and every §5 assertion
 * holds. The rest are the ones that matter more — each breaks exactly one of the deltas the
 * hand-written scenario discovered and shows the run going *red* for it. A conformance
 * scenario that cannot fail is a demo, so every load-bearing assertion here is paired with
 * the injury it is supposed to catch:
 *
 * * strip the asset's `source_world` (undo delta A) → the extraction has nothing to scope
 *   itself by, and the run cannot even continue;
 * * reconcile into `same_as` instead of `based_on` (undo delta C) → the firewall breaks;
 * * let the consensus-reality query return one fiction claim → `firewall_holds` catches it.
 *
 * Nothing is mocked but the peers themselves (KCS delta N): the runner, the observation
 * log, the fact extraction and the assertions are the production ones.
 */
import { createRegistry } from '@agora/registry';
import type { Json } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import {
  bundledFixtures,
  WORLDS_TO_FABRIC_ARGOS,
  WORLDS_TO_FABRIC_PINAKES,
} from '../fixtures/standins.ts';
import type { ConformanceReport } from '../kcs/outcome.ts';
import { runScenario } from '../kcs/runner.ts';
import { ALDERFOREST, CONSENSUS, WORLDS_TO_FABRIC } from './worlds-to-fabric.ts';

type Injury = (document: Json) => void;

/** The bundled fixtures, optionally with one of them damaged on the way through. */
function fixtures(injuries: Record<string, Injury> = {}): (path: string) => Promise<Json> {
  const bundled = bundledFixtures();
  return async (path: string): Promise<Json> => {
    const document = JSON.parse(JSON.stringify(await bundled(path))) as Json;
    injuries[path]?.(document);
    return document;
  };
}

/**
 * Reach into a loaded fixture by path. The injuries below are surgical — one field each —
 * so this is cheaper than restating every fixture's shape as a type, and it fails loudly
 * (on `undefined`) if a fixture is renamed out from under a test.
 */
function at(document: Json, ...path: string[]): Record<string, Json> {
  let current: unknown = document;
  for (const key of path) {
    current = (current as Record<string, unknown>)[key];
    if (current === undefined) throw new Error(`no ${key} in the fixture at ${path.join('.')}`);
  }
  return current as Record<string, Json>;
}

async function run(injuries: Record<string, Injury> = {}): Promise<ConformanceReport> {
  let tick = 0;
  return await runScenario(WORLDS_TO_FABRIC, {
    registry: createRegistry(),
    fixtures: fixtures(injuries),
    now: () => '2026-07-22T00:00:00.000Z',
    clock: () => (tick += 1),
  });
}

function failed(report: ConformanceReport): string[] {
  return report.assertions.filter((assertion) => !assertion.ok).map((assertion) => assertion.id);
}

function verdict(report: ConformanceReport, id: string): string {
  return report.assertions.find((assertion) => assertion.id === id)?.detail ?? 'not evaluated';
}

describe('kcs:worlds-to-fabric', () => {
  it('runs the whole pressure test green', async () => {
    const report = await run();
    expect(failed(report)).toEqual([]);
    expect(report.steps.filter((step) => step.status !== 'passed')).toEqual([]);
    expect(report.green).toBe(true);
  });

  it('says out loud that no participant was live', async () => {
    // Three projects, none of which has published a KCB manifest. A green run that did not
    // announce this would be the most misleading artifact in the commons.
    const report = await run();
    expect(report.stubbed).toBe(true);
    expect(report.participants.map((participant) => participant.identity)).toEqual([
      'insimul:agent:world-server',
      'analyzer:agent:pipeline',
      'pinakes:agent:resolver',
    ]);
    for (const participant of report.participants) {
      expect(participant.stubbed).toBe(true);
      expect(participant.discovered).toBe(false);
      expect(participant.note).toMatch(/not a live connection/);
    }
  });

  it('threads the ids each step minted into the next (§2.1)', async () => {
    const report = await run();
    const output = (id: string): unknown => report.steps.find((step) => step.id === id)?.output;
    expect(output('footage')).toMatchObject({
      asset: 'analyzer:asset:blake3-a1b2c3',
      source_world: ALDERFOREST,
      attaches_to: ['insimul:world:alderforest:ent:npc-renaud'],
    });
    // Delta B, as the report shows it: the re-emitted extraction came back under the id
    // Insimul's canon claim already has, not a second hash for the same fact.
    expect(output('dedup')).toMatchObject({ claims: ['insimul:claim:sha256-9f3c1a'] });
    expect(output('retraction')).toMatchObject({ claims: ['analyzer:claim:sha256-b0f7d1'] });
  });

  it('carries the observation slice that supports each verdict (§4.4)', async () => {
    const report = await run();
    const firewall = report.assertions.find((a) => a.id === 'no-fiction-in-the-real-answer');
    expect(firewall?.support.map((entry) => entry.step)).toEqual([
      'about-the-real-one',
      'about-the-real-one',
    ]);
    expect(firewall?.support.some((entry) => entry.direction === 'response')).toBe(true);
  });
});

describe('the injuries it is supposed to catch', () => {
  it('goes red when the consensus query leaks one fiction claim (Q2)', async () => {
    const report = await run({
      [WORLDS_TO_FABRIC_PINAKES]: (document) => {
        const answer = at(document, 'invoke', 'query.facts', 'body');
        (answer.assertions as Json[]).push({
          id: 'insimul:claim:sha256-9f3c1a',
          world: ALDERFOREST,
          subject: 'insimul:world:alderforest:ent:npc-renaud',
          relation: 'commands',
          object: 'insimul:world:alderforest:ent:army-of-ash',
          confidence: 0.9,
          prov: { agent: 'pinakes:agent:resolver', asserted: '2026-07-20T09:00:00Z' },
        });
      },
    });
    // Exactly one property broke, and it is the one the whole scenario exists for.
    expect(failed(report)).toEqual(['no-fiction-in-the-real-answer']);
    expect(verdict(report, 'no-fiction-in-the-real-answer')).toMatch(
      new RegExp(`returned 1 claim\\(s\\) from ${ALDERFOREST} — ${CONSENSUS} was asked`),
    );
    expect(report.green).toBe(false);
  });

  it('goes red when the reconciler equates the fiction to the real figure (delta C)', async () => {
    const report = await run({
      [WORLDS_TO_FABRIC_PINAKES]: (document) => {
        at(document, 'invoke', 'resolve.reconcile', 'body', 'links', '0').relation = 'same_as';
      },
    });
    expect(failed(report)).toEqual([
      'extraction-modeled-on-napoleon',
      'firewall-holds-one-hop',
      'firewall-holds-through-the-anchor',
    ]);
    // The closure runs npc-renaud → e-8842 → Napoleon → Wikidata: one wrong link two hops
    // away is still a same_as path out of the fiction and into consensus reality.
    expect(verdict(report, 'firewall-holds-through-the-anchor')).toMatch(
      /same_as links .* — cross-world equivalence must be based_on/,
    );
    expect(report.green).toBe(false);
  });

  it('goes red — and cannot continue — when the asset forgets its world (delta A)', async () => {
    const report = await run({
      [WORLDS_TO_FABRIC_ARGOS]: (document) => {
        delete at(document, 'fetch', 'analyzer:asset:blake3-a1b2c3', 'body').source_world;
      },
    });
    expect(verdict(report, 'footage-declares-its-world')).toMatch(
      /stated no source_world — KMI delta H requires one at ingest/,
    );
    // Delta A is load-bearing rather than decorative: with no source world on the envelope
    // there is nothing to scope the extraction by, so the step that would have produced the
    // fiction-world claim fails instead of quietly defaulting to consensus reality.
    const extract = report.steps.find((step) => step.id === 'extract');
    expect(extract?.status).toBe('failed');
    expect(extract?.error).toMatch(/no source_world in footage/);
    expect(report.green).toBe(false);
  });
});
