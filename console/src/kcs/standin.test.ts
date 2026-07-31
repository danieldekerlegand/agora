/**
 * The data-plane verbs, end to end through the whole runner.
 *
 * `subscribe`, `fetch` and `emit` (KCB §4) exercised against stand-in participants
 * (KCS delta N), with every §5 assertion they make possible evaluated over the resulting
 * observation log. Nothing here is a mock of the console: the runner, the log, the fact
 * extraction and the assertions are the production ones — only the peers are fixtures,
 * because four of the five platforms have not published a manifest yet.
 *
 * The fixtures are fabric-shaped (KGP packs, KMI envelopes, KINP links as the specs write
 * them), so the day a peer adopts the bus its `standin` is deleted and nothing else in a
 * scenario changes.
 */
import { createRegistry } from '@agora/registry';
import { SPEC_VERSIONS, type ScenarioDocument, type Step } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { bundledFixtures, PRODUCER_STANDIN, CURATOR_STANDIN } from '../fixtures/standins.ts';
import { runScenario } from './runner.ts';
import type { ConformanceReport } from './outcome.ts';

const PRODUCER = 'producer:agent:publisher';
const CURATOR = 'curator:agent:resolver';
const SAMPLE_WORLD = 'producer:world:sample';
const BASELINE = 'curator:world:baseline';
const ITEM = `${SAMPLE_WORLD}:ent:item-alpha`;
const REFERENCE = 'curator:ent:reference-alpha';
const RECORDING = 'producer:asset:blake3-a1b2c3';
const CLIP = 'processor:asset:blake3-c0de99';
const NOT_YET = 'producer:asset:blake3-ffffff';
const COMMANDS = 'producer:claim:sha256-9f3c1a';

const AT = (): string => '2026-07-22T00:00:00.000Z';

/** The body: subscribe to the scoped world, fetch what it depicts, emit it upstream. */
const BODY: Step[] = [
  { id: 'stream', kind: 'subscribe', participant: PRODUCER, world: SAMPLE_WORLD },
  { id: 'recording', kind: 'fetch', participant: PRODUCER, asset: RECORDING },
  { id: 'clip', kind: 'fetch', participant: PRODUCER, asset: CLIP },
  // Delta L: the reference arrived before the bytes. Declared as a rejection, so the run
  // continues and tolerance becomes an assertable property rather than an outage.
  { id: 'not-propagated', kind: 'fetch', expect: 'reject', participant: PRODUCER, asset: NOT_YET },
  {
    id: 'upstream',
    kind: 'emit',
    participant: CURATOR,
    pack: {
      kgp_version: '0.4.0',
      kind: 'delta',
      dialect: 'grounding-only',
      worlds: [SAMPLE_WORLD],
      assertions: [
        {
          world: SAMPLE_WORLD,
          subject: ITEM,
          relation: 'contains',
          object: `${SAMPLE_WORLD}:ent:assembly-alpha`,
          prov: { agent: 'agora:agent:console' },
        },
      ],
    },
  },
  {
    id: 'about-the-baseline-entity',
    kind: 'invoke',
    participant: CURATOR,
    capability: 'query.facts',
    inputs: [{ port: { plane: 'entity', types: ['ent'] }, value: { subject: REFERENCE } }],
  },
];

function scenario(steps: Step[]): ScenarioDocument {
  return {
    kcs_version: SPEC_VERSIONS.kcs,
    id: 'kcs:standin-walk',
    title: 'Every data-plane verb, against peers that have not adopted the bus',
    timeout_ms: 30_000,
    participants: [
      { identity: PRODUCER, planes: ['knowledge', 'media'], standin: { fixtures: PRODUCER_STANDIN } },
      { identity: CURATOR, planes: ['knowledge'], standin: { fixtures: CURATOR_STANDIN } },
    ],
    steps,
  };
}

async function run(steps: Step[] = BODY): Promise<ConformanceReport> {
  return await runScenario(scenario(steps), {
    registry: createRegistry(),
    fixtures: bundledFixtures(),
    now: AT,
    clock: (() => {
      let tick = 0;
      return () => (tick += 1);
    })(),
  });
}

const ASSERTIONS: Step[] = [
  { id: 'streamed-in-world', kind: 'assert', predicate: 'claim_in_world', args: [COMMANDS, SAMPLE_WORLD] },
  { id: 'streamed-attributed', kind: 'assert', predicate: 'provenance_present', args: [COMMANDS] },
  { id: 'lineage-not-identity', kind: 'assert', predicate: 'no_sameas_across_worlds', args: [ITEM, REFERENCE] },
  { id: 'lineage-recorded', kind: 'assert', predicate: 'based_on_exists', args: [ITEM, REFERENCE] },
  { id: 'recording-depicts', kind: 'assert', predicate: 'asset_attaches_to', args: [RECORDING, ITEM] },
  { id: 'recording-scoped', kind: 'assert', predicate: 'source_world_is', args: [RECORDING, SAMPLE_WORLD] },
  { id: 'clip-generated', kind: 'assert', predicate: 'source_world_is', args: [CLIP, null] },
  {
    id: 'analysis-attributed',
    kind: 'assert',
    predicate: 'analysis_attributed_to_constituent',
    args: [CLIP],
  },
  { id: 'dangling-tolerated', kind: 'assert', predicate: 'dangling_ref_tolerated', args: [NOT_YET] },
  { id: 'converged', kind: 'assert', predicate: 'claims_converge', args: [COMMANDS, '${upstream.claims.0}'] },
  { id: 'firewall', kind: 'assert', predicate: 'firewall_holds', args: ['about-the-baseline-entity', BASELINE] },
  { id: 'liveness', kind: 'assert', predicate: 'always_completes' },
];

describe('the data-plane verbs against stand-ins', () => {
  it('runs green, and says out loud that it was not all live', async () => {
    const report = await run([...BODY, ...ASSERTIONS]);
    expect(report.assertions.filter((assertion) => !assertion.ok)).toEqual([]);
    expect(report.steps.filter((step) => step.status !== 'passed')).toEqual([]);
    expect(report.green).toBe(true);
    // Delta N's whole point: green, and never mistakable for a fully live run.
    expect(report.stubbed).toBe(true);
    expect(report.participants.every((participant) => participant.stubbed)).toBe(true);
    expect(report.participants[0]?.note).toMatch(/stood in for from fixtures\//);
  });

  it('binds what each verb produced, so later steps can name it (§2.1)', async () => {
    const report = await run([...BODY, ...ASSERTIONS]);
    const output = (id: string): unknown => report.steps.find((step) => step.id === id)?.output;
    expect(output('stream')).toMatchObject({ frames: 1, claims: [COMMANDS], worlds: [SAMPLE_WORLD] });
    expect(output('recording')).toMatchObject({
      asset: RECORDING,
      media_type: 'video/mp4',
      source_world: SAMPLE_WORLD,
      attaches_to: [ITEM],
      present: true,
    });
    expect(output('upstream')).toMatchObject({ pack_id: 'sha256-7b1e44', claims: [COMMANDS] });
  });

  it('records the stream frame by frame, with the ids each one touched', async () => {
    const report = await run();
    const frames = report.observations.filter((entry) => entry.direction === 'frame');
    const stream = frames.filter((entry) => entry.step === 'stream');
    expect(stream).toHaveLength(1);
    expect(stream[0]?.entities).toContain(ITEM);
    expect(stream[0]?.entities).toContain(COMMANDS);
    expect(stream[0]?.detail).toMatchObject({ standin: true, claims: 2 });
  });

  it('holds ids and counts, never bytes (KMI §7)', async () => {
    const report = await run();
    const fetched = report.observations.filter((entry) => entry.step === 'recording');
    expect(fetched.map((entry) => entry.direction)).toEqual(['request', 'response']);
    expect(fetched[1]?.detail).toMatchObject({ asset: RECORDING, bytes: 104857600 });
    expect(JSON.stringify(report.observations)).not.toContain('b64_json');
  });

  it('refuses what its fixture does not cover, instead of answering blank', async () => {
    // The property that makes a stand-in honest: a call nobody wrote a fixture for is a
    // red step, not an empty success that a later assertion reads as agreement.
    const report = await run([
      { id: 'unwritten', kind: 'subscribe', participant: PRODUCER, world: 'producer:world:elsewhere' },
    ]);
    expect(report.steps[0]).toMatchObject({ status: 'failed' });
    expect(report.steps[0]?.error).toMatch(/covers no subscription to producer:world:elsewhere/);
    expect(report.green).toBe(false);
  });

  it('reports a fixture it cannot load rather than running half-live', async () => {
    const report = await runScenario(scenario(BODY.slice(0, 1)), {
      registry: createRegistry(),
      fixtures: () => Promise.reject(new Error('no such file')),
      now: AT,
    });
    expect(report.participants[0]).toMatchObject({ discovered: false, stubbed: false });
    expect(report.participants[0]?.note).toMatch(/could not be loaded: no such file/);
    expect(report.steps[0]?.error).toMatch(/was not discovered/);
    expect(report.green).toBe(false);
  });
});

describe('determinism (§7 Q2)', () => {
  it('reaches the same verdicts however the prose comes out', async () => {
    // Assertions are evaluated over plane-typed observations, so two runs whose only
    // difference is generated text are indistinguishable to every predicate. This is the
    // property that makes a scenario repeatable rather than a snapshot of one sampling.
    const verdicts = async (): Promise<[string, boolean][]> => {
      const report = await run([...BODY, ...ASSERTIONS]);
      return report.assertions.map((assertion) => [assertion.id, assertion.ok]);
    };
    expect(await verdicts()).toEqual(await verdicts());

    const chatty = await runScenario(
      { ...scenario([...BODY, ...ASSERTIONS]) },
      {
        registry: createRegistry(),
        now: AT,
        fixtures: async (path: string) => {
          const document = (await bundledFixtures()(path)) as Record<string, unknown>;
          if (path !== CURATOR_STANDIN) return document as never;
          // Same facts, wildly different prose alongside them.
          const invoke = document.invoke as Record<string, { body: Record<string, unknown> }>;
          const query = invoke['query.facts'] as { body: Record<string, unknown> };
          return {
            ...document,
            invoke: {
              ...invoke,
              'query.facts': {
                body: {
                  ...query.body,
                  choices: [
                    {
                      message: {
                        role: 'assistant',
                        content: 'item-alpha is definitely the same entity as reference-alpha, trust me.',
                      },
                    },
                  ],
                },
              },
            },
          } as never;
        },
      },
    );
    expect(chatty.assertions.filter((assertion) => !assertion.ok)).toEqual([]);
    expect(chatty.green).toBe(true);
  });
});
