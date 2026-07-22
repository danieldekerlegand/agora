import { createRegistry } from '@agora/registry';
import type { ScenarioDocument } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import {
  ASSERTION_NAMES,
  ASSERTION_PLANES,
  evaluateAssertion,
  isImplemented,
  type AssertionContext,
} from './assertions.ts';
import { ObservationLog } from './log.ts';
import type { StepOutcome } from './outcome.ts';

const SCENARIO: ScenarioDocument = {
  kcs_version: '0.2.0',
  id: 'kcs:test',
  title: 'test',
  participants: [{ identity: 'agora:agent:provider-router' }],
  steps: [],
};

function context(outcomes: StepOutcome[] = []): AssertionContext {
  return {
    scenario: SCENARIO,
    outcomes: new Map(outcomes.map((outcome) => [outcome.id, outcome])),
    log: new ObservationLog(() => '2026-07-22T00:00:00.000Z'),
    registry: createRegistry(),
  };
}

function completion(overrides: Partial<StepOutcome> = {}): StepOutcome {
  return {
    id: 'completion',
    kind: 'invoke',
    status: 'passed',
    expected: 'ok',
    durationMs: 1,
    result: {
      tier: 'placeholder',
      cost: { currency: 'budget_units', budget_units: 0, projected_units: 0, actual_units: 0 },
      raw: {},
    },
    ...overrides,
  };
}

describe('the KCS §5 vocabulary', () => {
  it('declares every predicate the spec names, grouped by plane', () => {
    expect(ASSERTION_PLANES.identity).toContain('firewall_holds');
    expect(ASSERTION_PLANES.knowledge).toContain('claims_converge');
    expect(ASSERTION_PLANES.media).toContain('source_world_is');
    expect(ASSERTION_PLANES.control).toContain('dangling_ref_tolerated');
    expect(ASSERTION_NAMES).toHaveLength(17);
  });

  it('never passes a predicate it cannot evaluate', () => {
    // The whole point: a scenario asserting `firewall_holds` must not go green on a
    // console that has never checked a firewall. Declared-but-pending is not a pass.
    for (const name of ASSERTION_NAMES.filter((predicate) => !isImplemented(predicate))) {
      const verdict = evaluateAssertion(name, [], context());
      expect(verdict.ok).toBe(false);
      expect(verdict.pending).toBe(true);
    }
  });

  it('never passes a predicate that is not in the vocabulary at all', () => {
    const verdict = evaluateAssertion('looks_fine_to_me', [], context());
    expect(verdict.ok).toBe(false);
    expect(verdict.pending).toBeUndefined();
    expect(verdict.detail).toMatch(/not a KCS §5 predicate/);
  });
});

describe('tier_resolved', () => {
  it('passes on the tier the provider reported, and fails on any other', () => {
    const ctx = context([completion()]);
    expect(evaluateAssertion('tier_resolved', ['completion', 'placeholder'], ctx).ok).toBe(true);
    expect(evaluateAssertion('tier_resolved', ['completion', 'paid'], ctx).ok).toBe(false);
  });

  it('fails when the step never ran', () => {
    expect(evaluateAssertion('tier_resolved', ['completion', 'placeholder'], context()).ok).toBe(false);
  });
});

describe('cost_within_ceiling', () => {
  it('honors a zero ceiling', () => {
    expect(evaluateAssertion('cost_within_ceiling', ['completion', 0], context([completion()])).ok).toBe(
      true,
    );
  });

  it('fails a route that projected over the ceiling even if it spent nothing', () => {
    // A gate that only checks the bill passes a request that was one retry from a charge.
    const lucky = completion({
      result: {
        tier: 'paid',
        cost: { currency: 'budget_units', budget_units: 0, projected_units: 1200, actual_units: 0 },
        raw: {},
      },
    });
    expect(evaluateAssertion('cost_within_ceiling', ['completion', 0], context([lucky])).ok).toBe(false);
  });

  it('fails when no cost was reported — silence is not zero', () => {
    const silent = completion({ result: { tier: 'placeholder', raw: {} } });
    const verdict = evaluateAssertion('cost_within_ceiling', ['completion', 0], context([silent]));
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/not a zero cost/);
  });
});

describe('refused', () => {
  it('passes only when the step meant to be refused was', () => {
    const rejected = completion({ expected: 'reject', refused: { status: 409, reason: 'nope' } });
    expect(evaluateAssertion('refused', ['completion'], context([rejected])).ok).toBe(true);
    expect(evaluateAssertion('refused', ['completion'], context([completion()])).ok).toBe(false);
  });
});

describe('always_completes', () => {
  it('is about every step of the run, and ignores the assertions themselves', () => {
    const ctx = context([
      completion(),
      { id: 'check', kind: 'assert', status: 'failed', expected: 'ok', durationMs: 0 },
    ]);
    expect(evaluateAssertion('always_completes', [], ctx).ok).toBe(true);

    const broken = context([completion({ status: 'failed' })]);
    expect(evaluateAssertion('always_completes', [], broken).ok).toBe(false);
  });
});
