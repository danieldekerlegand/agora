/**
 * `kcs:sample-pipeline`, run.
 *
 * The first test is the story: the whole sample executes and every §5 assertion holds. The
 * rest are the ones that matter more — each breaks exactly one of the properties the
 * scenario encodes and shows the run going *red* for it. A conformance scenario that cannot
 * fail is a demo, so every load-bearing assertion here is paired with the injury it is
 * supposed to catch:
 *
 * * strip the asset's `source_world` (undo delta A) → the extraction has nothing to scope
 *   itself by, and the run cannot even continue;
 * * reconcile into `same_as` instead of `based_on` (undo delta C) → the firewall breaks;
 * * let the baseline query return one scoped-world claim → `firewall_holds` catches it.
 *
 * Nothing is mocked but the peers themselves (KCS delta N): the runner, the observation
 * log, the fact extraction and the assertions are the production ones. That is what makes a
 * *neutral* sample worth shipping — a deployment's own scenarios (private `legacy` repo)
 * exercise exactly this machinery.
 */
import { createRegistry } from '@agora/registry';
import type { Json } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import {
  bundledFixtures,
  SAMPLE_PIPELINE_PROCESSOR,
  SAMPLE_PIPELINE_CURATOR,
} from '../fixtures/standins.ts';
import type { ConformanceReport } from '../kcs/outcome.ts';
import { runScenario } from '../kcs/runner.ts';
import { SAMPLE_WORLD, BASELINE, SAMPLE_PIPELINE } from './sample-pipeline.ts';

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
  return await runScenario(SAMPLE_PIPELINE, {
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

describe('kcs:sample-pipeline', () => {
  it('runs the whole sample green', async () => {
    const report = await run();
    expect(failed(report)).toEqual([]);
    expect(report.steps.filter((step) => step.status !== 'passed')).toEqual([]);
    expect(report.green).toBe(true);
  });

  it('says out loud that no participant was live', async () => {
    // Three peers, none of which has published a KCB manifest. A green run that did not
    // announce this would be the most misleading artifact in the commons.
    const report = await run();
    expect(report.stubbed).toBe(true);
    expect(report.participants.map((participant) => participant.identity)).toEqual([
      'producer:agent:publisher',
      'processor:agent:pipeline',
      'curator:agent:resolver',
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
    expect(output('recording')).toMatchObject({
      asset: 'processor:asset:blake3-a1b2c3',
      source_world: SAMPLE_WORLD,
      attaches_to: ['producer:world:sample:ent:item-alpha'],
    });
    // Delta B, as the report shows it: the re-emitted extraction came back under the id the
    // producer's published claim already has, not a second hash for the same fact.
    expect(output('dedup')).toMatchObject({ claims: ['producer:claim:sha256-9f3c1a'] });
    expect(output('retraction')).toMatchObject({ claims: ['processor:claim:sha256-b0f7d1'] });
  });

  it('carries the observation slice that supports each verdict (§4.4)', async () => {
    const report = await run();
    const firewall = report.assertions.find(
      (a) => a.id === 'no-scoped-claims-in-the-baseline-answer',
    );
    expect(firewall?.support.map((entry) => entry.step)).toEqual([
      'about-the-baseline-entity',
      'about-the-baseline-entity',
    ]);
    expect(firewall?.support.some((entry) => entry.direction === 'response')).toBe(true);
  });
});

describe('the injuries it is supposed to catch', () => {
  it('goes red when the baseline query leaks one scoped-world claim (Q2)', async () => {
    const report = await run({
      [SAMPLE_PIPELINE_CURATOR]: (document) => {
        const answer = at(document, 'invoke', 'query.facts', 'body');
        (answer.assertions as Json[]).push({
          id: 'producer:claim:sha256-9f3c1a',
          world: SAMPLE_WORLD,
          subject: 'producer:world:sample:ent:item-alpha',
          relation: 'contains',
          object: 'producer:world:sample:ent:assembly-alpha',
          confidence: 0.9,
          prov: { agent: 'curator:agent:resolver', asserted: '2026-07-20T09:00:00Z' },
        });
      },
    });
    // Exactly one property broke, and it is the one the whole scenario exists for.
    expect(failed(report)).toEqual(['no-scoped-claims-in-the-baseline-answer']);
    expect(verdict(report, 'no-scoped-claims-in-the-baseline-answer')).toMatch(
      new RegExp(`returned 1 claim\\(s\\) from ${SAMPLE_WORLD} — ${BASELINE} was asked`),
    );
    expect(report.green).toBe(false);
  });

  it('goes red when the reconciler equates the two worlds’ entities (delta C)', async () => {
    const report = await run({
      [SAMPLE_PIPELINE_CURATOR]: (document) => {
        at(document, 'invoke', 'resolve.reconcile', 'body', 'links', '0').relation = 'same_as';
      },
    });
    expect(failed(report)).toEqual([
      'extraction-modeled-on-reference',
      'firewall-holds-one-hop',
      'firewall-holds-through-the-anchor',
    ]);
    // The closure runs item-alpha → c-4410 → reference-alpha → the external anchor: one
    // wrong link two hops away is still a same_as path out of the sample world and into the
    // baseline.
    expect(verdict(report, 'firewall-holds-through-the-anchor')).toMatch(
      /same_as links .* — cross-world equivalence must be based_on/,
    );
    expect(report.green).toBe(false);
  });

  it('goes red — and cannot continue — when the asset forgets its world (delta A)', async () => {
    const report = await run({
      [SAMPLE_PIPELINE_PROCESSOR]: (document) => {
        delete at(document, 'fetch', 'processor:asset:blake3-a1b2c3', 'body').source_world;
      },
    });
    expect(verdict(report, 'recording-declares-its-world')).toMatch(
      /stated no source_world — KMI delta H requires one at ingest/,
    );
    // Delta A is load-bearing rather than decorative: with no source world on the envelope
    // there is nothing to scope the extraction by, so the step that would have produced the
    // scoped-world claim fails instead of quietly defaulting to the baseline.
    const extract = report.steps.find((step) => step.id === 'extract');
    expect(extract?.status).toBe('failed');
    expect(extract?.error).toMatch(/no source_world in recording/);
    expect(report.green).toBe(false);
  });
});
