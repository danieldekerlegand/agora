/**
 * The end-to-end proof (US-AG5): the shipped scenario, run through the whole console —
 * crawl the manifest, index it, resolve the participant, dial the capability's own
 * address, read the routing report, evaluate the assertions.
 *
 * Only the socket is replaced, by a replay of a captured session that
 * `provider-router/tests/test_conformance_fixture.py` keeps honest. Nothing else here is
 * a stub: the registry, the wire, the log and the assertions are the production ones.
 */
import { describeRegistry } from '@agora/registry';
import type { ScenarioDocument, Step } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { runConformance, type ConformanceRun } from '../commons.ts';
import { CAPTURED_EXCHANGE, CAPTURED_FROM, replaySession } from '../fixtures/session.ts';
import { PROVIDER_ROUTER_ROUNDTRIP } from '../scenarios/provider-router-roundtrip.ts';
import type { HttpFetch } from './http.ts';
import { routings } from './outcome.ts';

const AT = (): string => '2026-07-22T00:00:00.000Z';

function ticking(): () => number {
  let tick = 0;
  return () => (tick += 1);
}

const ENDPOINT = `${CAPTURED_FROM}${CAPTURED_EXCHANGE.path}`;
const MANIFEST = `${CAPTURED_FROM}/.well-known/kcb-manifest.json`;

async function replay(
  scenario: ScenarioDocument = PROVIDER_ROUTER_ROUNDTRIP,
  fetch?: HttpFetch,
): Promise<ConformanceRun & { dialed: string[] }> {
  const dialed: string[] = [];
  const run = await runConformance(scenario, {
    fetch: fetch ?? replaySession(dialed),
    routerBaseUrl: CAPTURED_FROM,
    now: AT,
    clock: ticking(),
  });
  return { ...run, dialed };
}

/** The shipped scenario with its steps swapped — same participant, same discovery. */
function variant(steps: Step[], overrides: Partial<ScenarioDocument> = {}): ScenarioDocument {
  return { ...PROVIDER_ROUTER_ROUNDTRIP, ...overrides, steps };
}

describe('kcs:provider-router-roundtrip', () => {
  it('runs green against the captured provider-router', async () => {
    const { report } = await replay();
    expect(report.assertions.filter((assertion) => !assertion.ok)).toEqual([]);
    expect(report.steps.filter((step) => step.status !== 'passed')).toEqual([]);
    expect(report.green).toBe(true);
    expect(report.stubbed).toBe(false);
  });

  it('surfaces the resolved tier and the cost — the point of the scenario', async () => {
    const { report } = await replay();
    expect(routings(report)).toEqual([
      {
        step: 'completion',
        tier: 'placeholder',
        provider: 'placeholder',
        model: 'placeholder-text',
        currency: 'budget_units',
        projectedUnits: 0,
        actualUnits: 0,
        budgetUnits: 0,
      },
    ]);
  });

  it('discovers through the registry, then dials the provider directly', async () => {
    const { dialed, discovery } = await replay();
    // Exactly two connections: one crawl of the manifest, one call at the address the
    // capability advertised. No third party in the path (ADR-0001 decisions 3 and 7).
    expect(dialed).toEqual([MANIFEST, ENDPOINT]);
    expect(discovery.providers).toEqual(['agora:agent:provider-router']);
    expect(discovery.problems).toEqual([]);
    expect(describeRegistry().proxiesTraffic).toBe(false);
  });

  it('builds the request the router was actually asked — the replay refuses any other', async () => {
    // The capture answers one exact body; a console that drifted would get a 409 here
    // rather than a canned success, which is what makes this a round-trip and not a mock.
    const { report } = await replay();
    const completion = report.steps.find((step) => step.id === 'completion');
    expect(completion?.result?.text).toContain('[agora placeholder]');
  });

  it('records both directions of the traffic it observed', async () => {
    const { report } = await replay();
    const observed = report.observations.filter((entry) => entry.step === 'completion');
    expect(observed.map((entry) => entry.direction)).toEqual(['request', 'response']);
    expect(observed.every((entry) => entry.participant === 'agora:agent:provider-router')).toBe(true);
    expect(observed[0]?.detail).toMatchObject({
      wire: 'openai',
      capability: 'generate.text',
      endpoint: ENDPOINT,
      budget_units: 0,
    });
    expect(observed[1]?.detail).toMatchObject({ tier: 'placeholder', actual_units: 0 });
    // Summaries and ids only — no payload bytes in the log (KMI §7).
    expect(JSON.stringify(observed)).not.toContain('b64_json');
  });
});

describe('when the commons is not there', () => {
  const nothing: HttpFetch = (url) =>
    Promise.resolve({
      ok: false,
      status: 404,
      headers: { get: () => null },
      json: () => Promise.resolve({ detail: `nothing at ${url}` }),
    });

  it('reports red with the reason, instead of throwing', async () => {
    const { report, discovery } = await replay(PROVIDER_ROUTER_ROUNDTRIP, nothing);
    expect(report.green).toBe(false);
    expect(discovery.problems[0]).toMatch(/provider-router at/);
    expect(report.participants[0]).toMatchObject({ discovered: false, stubbed: false });
    expect(report.steps.find((step) => step.id === 'completion')?.error).toMatch(/no address to dial/);
  });

  it('still evaluates the assertions, so the report says which property broke', async () => {
    const { report } = await replay(PROVIDER_ROUTER_ROUNDTRIP, nothing);
    // A skipped assertion cannot be red; every one must have run and failed.
    expect(report.assertions.map((assertion) => assertion.predicate)).toEqual([
      'tier_resolved',
      'cost_within_ceiling',
      'capability_path_exists',
      'always_completes',
    ]);
    expect(report.assertions.every((assertion) => !assertion.ok)).toBe(true);
  });
});

describe('the execution model', () => {
  it('passes a step that was correctly refused (delta O)', async () => {
    const scenario = variant([
      {
        id: 'unknown-request',
        kind: 'invoke',
        expect: 'reject',
        participant: 'agora:agent:provider-router',
        capability: 'generate.text',
        inputs: [
          {
            port: { plane: 'knowledge', shape: 'chat-messages' },
            value: { messages: [{ role: 'user', content: 'something else entirely' }] },
          },
        ],
      },
      { id: 'was-refused', kind: 'assert', predicate: 'refused', args: ['unknown-request'] },
    ]);
    const { report } = await replay(scenario);
    expect(report.steps[0]).toMatchObject({ status: 'passed', refused: { status: 409 } });
    expect(report.green).toBe(true);
  });

  it('fails a step that was supposed to be refused and was not', async () => {
    const steps = PROVIDER_ROUTER_ROUNDTRIP.steps.slice(0, 2).map((step) =>
      step.id === 'completion' ? { ...step, expect: 'reject' as const } : step,
    );
    const { report } = await replay(variant(steps));
    expect(report.steps[1]).toMatchObject({ status: 'failed' });
    expect(report.steps[1]?.error).toMatch(/expected a refusal/);
  });

  it('skips a step whose dependency failed, but never skips an assertion', async () => {
    // The router serves completions and no CAS, so a `fetch` at it has no address to go
    // to. That is a failure, not a skip: the console must never invent an endpoint.
    const scenario = variant([
      { id: 'no-cas', kind: 'fetch', participant: 'agora:agent:provider-router', asset: 'agora:asset:x' },
      {
        id: 'downstream',
        kind: 'invoke',
        participant: 'agora:agent:provider-router',
        capability: 'generate.text',
      },
      { id: 'liveness', kind: 'assert', predicate: 'always_completes' },
    ]);
    const { report } = await replay(scenario);
    expect(report.steps[0]).toMatchObject({ status: 'failed' });
    expect(report.steps[0]?.error).toMatch(/publishes no `cas` address/);
    expect(report.steps[1]).toMatchObject({ status: 'skipped', error: 'blocked by no-cas' });
    expect(report.assertions).toHaveLength(1);
    expect(report.assertions[0]?.ok).toBe(false);
  });

  it('fails a step that blows its liveness bound rather than hanging (delta P)', async () => {
    const hang: HttpFetch = (url) =>
      url === MANIFEST ? replaySession()(url) : new Promise(() => undefined);
    const scenario = variant([
      {
        id: 'completion',
        kind: 'invoke',
        timeout_ms: 10,
        participant: 'agora:agent:provider-router',
        capability: 'generate.text',
      },
    ]);
    const { report } = await replay(scenario, hang);
    expect(report.steps[0]).toMatchObject({ status: 'failed' });
    expect(report.steps[0]?.error).toMatch(/exceeded its 10ms liveness bound/);
  });

  it('honors `after` for a step declared out of order', async () => {
    // `after: []` on the later step is what breaks the declared-order default — without
    // it the two would wait on each other.
    const scenario = variant([
      { id: 'second', kind: 'assert', predicate: 'completes', args: ['first'], after: ['first'] },
      { id: 'first', kind: 'resolve', ref: { id: 'agora:agent:provider-router' }, after: [] },
    ]);
    const { report } = await replay(scenario);
    expect(report.green).toBe(true);
  });

  it('reports a deadlocked schedule instead of hanging on it', async () => {
    const scenario = variant([
      { id: 'second', kind: 'resolve', ref: { id: 'agora:agent:provider-router' }, after: ['first'] },
      { id: 'first', kind: 'resolve', ref: { id: 'agora:agent:provider-router' } },
    ]);
    const { report } = await replay(scenario);
    expect(report.steps.map((step) => step.status)).toEqual(['failed', 'failed']);
    expect(report.steps[0]?.error).toMatch(/circular dependency/);
  });

  it('binds a value produced at run time (delta M)', async () => {
    const scenario = variant([
      ...PROVIDER_ROUTER_ROUNDTRIP.steps.slice(0, 2),
      {
        id: 'ceiling-from-the-run',
        kind: 'assert',
        predicate: 'cost_within_ceiling',
        args: ['completion', '${completion.cost.budget_units}'],
      },
    ]);
    const { report } = await replay(scenario);
    expect(report.assertions[0]).toMatchObject({ ok: true, args: ['completion', 0] });
  });

  it('resolves the participant identity through the resolver stub (KINP §8)', async () => {
    const { report } = await replay();
    expect(report.steps[0]).toMatchObject({ id: 'router', kind: 'resolve', status: 'passed' });
    expect(report.steps[0]?.output).toMatchObject({
      id: 'agora:agent:provider-router',
      kind: 'agent',
      authority: 'local',
    });
  });
});
