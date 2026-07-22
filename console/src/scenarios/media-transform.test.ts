/**
 * `kcs:media-transform`, run.
 *
 * Same method as `worlds-to-fabric.test.ts`: the first tests are the story — four projects,
 * every step green — and the ones that matter more come after. Each of those damages exactly
 * one of the deltas the hand-written pressure test discovered and shows the run going *red*
 * on the assertion that names it:
 *
 * * type Composer's `compose` back to media-only (undo delta F) → the score leg is unroutable;
 * * drop `world_pattern` from a media port (undo delta J) → "video from world X" matches
 *   nothing;
 * * drop a generated asset's `source_world: null` (undo delta H) → an unstated field is not
 *   a stated null;
 * * report spend over the ceiling (undo delta K) → the grant's bound bites;
 * * cut one lineage link → analysis of the composite can no longer be attributed to the
 *   clip's world, which is the firewall failing open across an edit.
 *
 * Nothing is mocked but the peers themselves (KCS delta N): the runner, the registry index,
 * the observation log, the fact extraction and the assertions are the production ones.
 */
import { createRegistry } from '@agora/registry';
import type { Json } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import {
  bundledFixtures,
  MEDIA_TRANSFORM_ARGOS,
  MEDIA_TRANSFORM_FORMANT,
} from '../fixtures/standins.ts';
import type { ConformanceReport } from '../kcs/outcome.ts';
import { runScenario } from '../kcs/runner.ts';
import { LATE_CLIP, MEDIA_TRANSFORM, SAVE_FORK } from './media-transform.ts';

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

/** Reach into a loaded fixture by path; `undefined` fails loudly if one is renamed. */
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
  return await runScenario(MEDIA_TRANSFORM, {
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

describe('kcs:media-transform', () => {
  it('runs the whole four-project chain green', async () => {
    const report = await run();
    expect(failed(report)).toEqual([]);
    expect(report.steps.filter((step) => step.status !== 'passed')).toEqual([]);
    expect(report.green).toBe(true);
  });

  it('says out loud that no participant was live', async () => {
    const report = await run();
    expect(report.stubbed).toBe(true);
    expect(report.participants.map((participant) => participant.identity)).toEqual([
      'insimul:agent:world-server',
      'analyzer:agent:pipeline',
      'composer:agent:composer',
      'pinakes:agent:resolver',
    ]);
    for (const participant of report.participants) {
      expect(participant.stubbed).toBe(true);
      expect(participant.discovered).toBe(false);
      expect(participant.note).toMatch(/not a live connection/);
    }
  });

  it('plans the chain across planes and providers before dialing anybody (delta F)', async () => {
    const report = await run();
    // The score leg: knowledge in, media out — the route media-profile-only typing could
    // not describe, named with the provider that carries it.
    expect(verdict(report, 'route-for-the-score')).toMatch(
      /composer:agent:composer\/compose \(24 units\)/,
    );
    // And the whole way to the NLE, over two providers' capabilities.
    expect(verdict(report, 'route-to-the-nle')).toMatch(
      /analyzer:agent:pipeline\/conform → analyzer:agent:pipeline\/export\.cmx3600/,
    );
  });

  it('surfaces the one paid hop, under the ceiling the invoke declared (delta K)', async () => {
    const report = await run();
    const score = report.steps.find((step) => step.id === 'score');
    expect(score?.result?.tier).toBe('paid-model');
    expect(score?.result?.cost).toMatchObject({
      budget_units: 40,
      projected_units: 24,
      actual_units: 24,
    });
    // Everything else in the chain is a zero-spend rung — the ladder, as a report reads it.
    const narrate = report.steps.find((step) => step.id === 'narrate');
    expect(narrate?.result?.cost?.actual_units).toBe(0);
  });

  it('carries the observation slice that supports the attribution verdict (§4.4)', async () => {
    const report = await run();
    const attribution = report.assertions.find(
      (assertion) => assertion.id === 'analysis-lands-in-the-constituents-world',
    );
    expect(attribution?.detail).toMatch(new RegExp(`land in its constituents' world\\(s\\) ${SAVE_FORK}`));
    expect(attribution?.support.map((entry) => entry.step)).toContain('analysis');
  });

  it('met a dangling reference and kept going (delta L)', async () => {
    const report = await run();
    const late = report.steps.find((step) => step.id === 'late-bytes');
    expect(late?.status).toBe('passed');
    expect(late?.refused?.status).toBe(404);
    expect(verdict(report, 'the-late-clip-was-tolerated')).toMatch(
      new RegExp(`${LATE_CLIP} was dangling and the run carried on`),
    );
  });
});

describe('the injuries it is supposed to catch', () => {
  it('goes red when the score leg is typed media-only again (delta F)', async () => {
    const report = await run({
      [MEDIA_TRANSFORM_FORMANT]: (document) => {
        at(document, 'manifest', 'capabilities', '0').inputs = [
          { plane: 'media', media_types: ['text/plain'] },
        ];
      },
    });
    // Nothing else moves: the chain still runs, and the only thing the fabric lost is the
    // ability to *find* the route — which is exactly what delta F was about.
    expect(failed(report)).toEqual(['route-for-the-score']);
    expect(verdict(report, 'route-for-the-score')).toMatch(/no path from .*mood-descriptor/);
    expect(report.green).toBe(false);
  });

  it('goes red when media ports stop declaring their world (delta J)', async () => {
    const report = await run({
      [MEDIA_TRANSFORM_ARGOS]: (document) => {
        // KCB 0.1.x typing: media ports carried a media_type and nothing about worlds.
        for (const capability of at(document, 'manifest').capabilities as Record<string, Json>[]) {
          for (const port of (capability.inputs ?? []) as Record<string, Json>[]) {
            delete port.world_pattern;
          }
        }
      },
    });
    // A media port with no world_pattern makes no claim about worlds, so it must not answer
    // a world-scoped query — guessing "probably all of them" is how a caller ends up dialing
    // a provider that has none of the world's material. Both routes that start at "video
    // from world X" lose their entry point, and only those.
    expect(failed(report)).toEqual(['route-from-the-world', 'route-to-the-nle']);
    expect(verdict(report, 'route-from-the-world')).toMatch(new RegExp(SAVE_FORK));
    expect(report.green).toBe(false);
  });

  it('goes red when a generated asset merely omits its source_world (delta H)', async () => {
    const report = await run({
      [MEDIA_TRANSFORM_ARGOS]: (document) => {
        delete at(document, 'invoke', 'narrate', 'body', 'assets', '0').source_world;
      },
    });
    // The whole point of delta H: `null` is a claim ("this depicts no world"), silence is
    // not. Collapsing the two is how extracted knowledge lands in consensus reality.
    expect(failed(report)).toEqual(['the-narration-depicts-no-world']);
    expect(verdict(report, 'the-narration-depicts-no-world')).toMatch(
      /stated no source_world — KMI delta H requires one at ingest/,
    );
    expect(report.green).toBe(false);
  });

  it('goes red when the paid hop spends past its ceiling (delta K)', async () => {
    const report = await run({
      [MEDIA_TRANSFORM_FORMANT]: (document) => {
        at(document, 'invoke', 'compose', 'body', 'agora', 'cost').actual_units = 61;
      },
    });
    expect(failed(report)).toEqual(['the-score-stayed-under-its-ceiling']);
    expect(verdict(report, 'the-score-stayed-under-its-ceiling')).toMatch(
      /spent 61 budget_units against a ceiling of 40/,
    );
    expect(report.green).toBe(false);
  });

  it('goes red when one lineage link is cut between the render and its footage', async () => {
    const report = await run({
      [MEDIA_TRANSFORM_ARGOS]: (document) => {
        const links = at(document, 'invoke', 'conform', 'body') as { links: Json[] };
        // The EDL no longer says it was made from the clip. The render → EDL → score,
        // narration path survives, and every one of those is generated — so the walk finds
        // no world at all and the composite's analysis is attributable to nothing.
        links.links = links.links.slice(1);
      },
    });
    expect(failed(report)).toEqual(['analysis-lands-in-the-constituents-world']);
    expect(verdict(report, 'analysis-lands-in-the-constituents-world')).toMatch(
      /states a source_world — its analysis is attributable to no world/,
    );
    expect(report.green).toBe(false);
  });
});

describe('the manifest a stand-in publishes for its peer', () => {
  it('may not speak for another provider', async () => {
    const report = await run({
      [MEDIA_TRANSFORM_FORMANT]: (document) => {
        at(document, 'manifest').identity = 'analyzer:agent:pipeline';
      },
    });
    const composer = report.participants.find(
      (participant) => participant.identity === 'composer:agent:composer',
    );
    expect(composer?.note).toMatch(/publishes a manifest for analyzer:agent:pipeline/);
    // And the route it should have carried is gone, rather than quietly answered by the
    // provider whose identity the fixture claimed.
    expect(failed(report)).toEqual(['route-for-the-score']);
  });
});
