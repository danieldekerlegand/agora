import { describe, expect, it } from 'vitest';

import { isCompatibleKcsVersion, parseScenario, ScenarioError, STEP_KINDS } from './scenario.ts';
import { SPEC_VERSIONS } from './versions.ts';

function scenario(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kcs_version: SPEC_VERSIONS.kcs,
    id: 'kcs:example',
    title: 'An example scenario',
    participants: [{ identity: 'agora:agent:provider-router', planes: ['knowledge'] }],
    steps: [{ id: 'call', kind: 'invoke', participant: 'agora:agent:provider-router', capability: 'generate.text' }],
    ...overrides,
  };
}

describe('the KCS step vocabulary', () => {
  it('is exactly what the spec §3 table lists', () => {
    expect([...STEP_KINDS]).toEqual(['invoke', 'fetch', 'subscribe', 'resolve', 'emit', 'assert']);
  });
});

describe('isCompatibleKcsVersion', () => {
  it('accepts its own version and rejects a different pre-1.0 minor', () => {
    expect(isCompatibleKcsVersion(SPEC_VERSIONS.kcs)).toBe(true);
    expect(isCompatibleKcsVersion('0.1.0')).toBe(false);
    expect(isCompatibleKcsVersion('1.0.0')).toBe(false);
  });
});

describe('parseScenario', () => {
  it('reads a well-formed document verbatim', () => {
    const doc = scenario();
    expect(parseScenario(doc)).toBe(doc);
  });

  it('refuses a scenario this build cannot run', () => {
    expect(() => parseScenario(scenario({ kcs_version: '9.0.0' }))).toThrow(/not runnable/);
  });

  it('requires participants to be KINP identities — an address is never hard-coded', () => {
    expect(() => parseScenario(scenario({ participants: [{ identity: 'https://router.example' }] }))).toThrow(
      ScenarioError,
    );
    expect(() => parseScenario(scenario({ participants: [] }))).toThrow(/must not be empty/);
  });

  it('rejects a duplicate step id — ${id.path} bindings need it unique', () => {
    const steps = [
      { id: 'call', kind: 'invoke', participant: 'agora:agent:provider-router', capability: 'generate.text' },
      { id: 'call', kind: 'assert', predicate: 'completes' },
    ];
    expect(() => parseScenario(scenario({ steps }))).toThrow(/declared twice/);
  });

  it('rejects an `after` naming a step that does not exist — that schedule can never run', () => {
    const steps = [{ id: 'call', kind: 'assert', predicate: 'completes', after: ['ghost'] }];
    expect(() => parseScenario(scenario({ steps }))).toThrow(/waits on unknown step ghost/);
  });

  it('lets `after` point at a step declared later, and at a setup step', () => {
    const doc = scenario({
      setup: [{ id: 'seed', kind: 'emit' }],
      steps: [
        { id: 'first', kind: 'assert', predicate: 'completes', after: ['later', 'seed'] },
        { id: 'later', kind: 'invoke', participant: 'agora:agent:provider-router', capability: 'generate.text' },
      ],
    });
    expect(() => parseScenario(doc)).not.toThrow();
  });

  it('rejects an unknown step kind and an unknown expectation', () => {
    expect(() => parseScenario(scenario({ steps: [{ id: 'x', kind: 'teleport' }] }))).toThrow(/kind must be one of/);
    expect(() =>
      parseScenario(scenario({ steps: [{ id: 'x', kind: 'assert', predicate: 'completes', expect: 'maybe' }] })),
    ).toThrow(/must be "ok" or "reject"/);
  });
});
