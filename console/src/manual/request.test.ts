import { parseScenario, SPEC_VERSIONS } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { SAMPLE_PROVIDER } from '../fixtures/standins.ts';
import type { PortField } from './catalogue.ts';
import {
  MANUAL_SCENARIO_ID,
  MANUAL_STEP_ID,
  ManualRequestError,
  manualScenario,
  portValuesFrom,
} from './request.ts';

const KNOWLEDGE: PortField = {
  port: { plane: 'knowledge', shape: 'chat-messages' },
  label: 'knowledge · shape chat-messages',
  entry: 'value',
  placeholder: '',
};

const MEDIA: PortField = {
  port: { plane: 'media', media_types: ['video/mp4'] },
  label: 'media · video/mp4',
  entry: 'ref',
  placeholder: '',
};

describe('composing port values', () => {
  it('parses a value field as JSON and carries a ref field as an id', () => {
    expect(
      portValuesFrom([KNOWLEDGE, MEDIA], ['[{"role":"user","content":"hi"}]', 'processor:asset:b3-1']),
    ).toEqual([
      { port: KNOWLEDGE.port, value: [{ role: 'user', content: 'hi' }] },
      { port: MEDIA.port, ref: 'processor:asset:b3-1' },
    ]);
  });

  it('sends nothing for a port left blank — absent is not empty', () => {
    expect(portValuesFrom([KNOWLEDGE, MEDIA], ['', '  '])).toEqual([]);
  });

  it('names the field when what was typed is not JSON', () => {
    expect(() => portValuesFrom([KNOWLEDGE], ['{oops'])).toThrow(ManualRequestError);
    expect(() => portValuesFrom([KNOWLEDGE], ['{oops'])).toThrow(/shape chat-messages is not JSON/);
  });
});

describe('compiling a manual request into a scenario', () => {
  it('compiles an invoke into a one-step scenario the runner accepts unchanged', () => {
    const scenario = manualScenario({
      verb: 'invoke',
      participant: 'agora:agent:provider-router',
      capability: 'generate.text',
      inputs: [{ port: KNOWLEDGE.port, value: 'hello' }],
      budgetUnits: 5,
    });
    // The point of the whole module: what manual mode produces is a scenario document, so
    // the runner, the log and the report are the ones the library already exercises.
    expect(() => parseScenario(scenario)).not.toThrow();
    expect(scenario.id).toBe(MANUAL_SCENARIO_ID);
    expect(scenario.kcs_version).toBe(SPEC_VERSIONS.kcs);
    expect(scenario.steps).toHaveLength(1);
    const [step] = scenario.steps;
    expect(step?.id).toBe(MANUAL_STEP_ID);
    expect(step?.kind).toBe('invoke');
    expect(step).toMatchObject({ capability: 'generate.text', budget_units: 5 });
  });

  it('declares no assertions — a manual call proves the call, not a property', () => {
    const scenario = manualScenario({
      verb: 'fetch',
      participant: 'processor:agent:ingest',
      asset: 'processor:asset:b3-1',
    });
    expect(scenario.steps.filter((step) => step.kind === 'assert')).toEqual([]);
  });

  it('carries a stand-in through, so an unadopted peer is composable and stamped', () => {
    const scenario = manualScenario({
      verb: 'invoke',
      participant: 'consumer:agent:composer',
      standin: SAMPLE_PROVIDER,
      capability: 'compose',
      inputs: [],
    });
    expect(scenario.participants).toEqual([
      { identity: 'consumer:agent:composer', standin: { fixtures: SAMPLE_PROVIDER } },
    ]);
  });

  it('names the resolver, not a provider, for a resolve — nobody is dialed', () => {
    const scenario = manualScenario({ verb: 'resolve', ref: { id: 'curator:ent:q517' } });
    expect(scenario.participants).toEqual([{ identity: 'agora:agent:resolver' }]);
    expect(scenario.steps[0]).toMatchObject({ kind: 'resolve', ref: { id: 'curator:ent:q517' } });
  });

  it('fails with the spec’s own message before anybody is dialed', () => {
    // `participant` is not a KINP id, so `parseScenario` refuses it at compile time rather
    // than the runner discovering it mid-run against a live peer.
    expect(() =>
      manualScenario({
        verb: 'invoke',
        participant: 'not-an-id',
        capability: 'generate.text',
        inputs: [],
      }),
    ).toThrow(/must be a KINP id/);
  });
});
