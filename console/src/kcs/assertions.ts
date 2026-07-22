/**
 * The cross-plane assertion vocabulary — KCS §5.
 *
 * "Assertions are what make a scenario a *conformance test* rather than a demo." Every
 * predicate §5 names is declared here, including the ones this build cannot evaluate yet:
 * a predicate with no evaluator returns **pending**, which counts as *not passing*.
 *
 * That is the load-bearing decision in this file. If an unknown predicate were skipped, a
 * scenario asserting `firewall_holds` would go green on a console that has never checked a
 * firewall — the same failure mode as the registry reading an unpriced route as free. So
 * the vocabulary is a closed list, `PENDING` names what is not implemented yet, and the
 * report shows it.
 *
 * Evaluators read the **observation log** (§4.3), not the runner's internals, so every
 * verdict can carry the slice of traffic that supports it.
 */
import type { CapabilityRegistry, PortQuery } from '@agora/registry';
import { isJsonObject, type Json, type ScenarioDocument } from '@agora/schemas';

import type { Observation, ObservationLog } from './log.ts';
import type { StepOutcome } from './outcome.ts';

export interface AssertionContext {
  scenario: ScenarioDocument;
  outcomes: ReadonlyMap<string, StepOutcome>;
  log: ObservationLog;
  registry: CapabilityRegistry;
}

export interface AssertionVerdict {
  ok: boolean;
  /** True when the predicate is spec'd but not implemented here — never a pass. */
  pending?: boolean;
  detail: string;
  /** The log slice that supports the verdict (§4.4). */
  support: Observation[];
}

export type Evaluator = (args: Json[], context: AssertionContext) => AssertionVerdict;

/**
 * The §5 vocabulary, by plane. A name present with `undefined` is declared-but-pending;
 * the test suite asserts this list still matches the spec's, so a KCS revision that adds a
 * predicate shows up as a failing gate rather than as a silently-ignored assertion.
 */
export const ASSERTION_PLANES: Record<string, readonly string[]> = {
  identity: ['no_sameas_across_worlds', 'based_on_exists', 'resolves_to', 'firewall_holds'],
  knowledge: ['claim_in_world', 'claims_converge', 'provenance_present'],
  media: ['asset_attaches_to', 'source_world_is', 'analysis_attributed_to_constituent'],
  control: [
    'capability_path_exists',
    'cost_within_ceiling',
    'tier_resolved',
    'dangling_ref_tolerated',
    'refused',
  ],
  liveness: ['completes', 'always_completes'],
};

/** Every predicate §5 names, in declaration order. */
export const ASSERTION_NAMES: readonly string[] = Object.values(ASSERTION_PLANES).flat();

const EVALUATORS: Record<string, Evaluator> = {
  completes(args, context) {
    const [id, outcome] = step(args, context);
    if (outcome === undefined) return miss(id, context);
    return {
      ok: outcome.status === 'passed' && outcome.refused === undefined,
      detail: `${id} ${outcome.status}${outcome.error === undefined ? '' : `: ${outcome.error}`}`,
      support: context.log.forStep(id),
    };
  },

  /**
   * The zero-spend property, scenario-wide: every step that was meant to succeed did.
   * Takes no argument — `always_completes(scenario)` is about the run, not a step.
   */
  always_completes(_args, context) {
    const failed = [...context.outcomes.values()].filter(
      (outcome) => outcome.kind !== 'assert' && outcome.status !== 'passed',
    );
    return {
      ok: failed.length === 0,
      detail:
        failed.length === 0
          ? `all ${context.outcomes.size} steps completed`
          : `${failed.map((outcome) => outcome.id).join(', ')} did not complete`,
      support: context.log.entries().slice(),
    };
  },

  tier_resolved(args, context) {
    const [id, outcome] = step(args, context);
    if (outcome === undefined) return miss(id, context);
    const expected = args[1];
    const actual = outcome.result?.tier;
    return {
      ok: actual !== undefined && actual === expected,
      detail: `${id} resolved to tier ${String(actual)}, expected ${String(expected)}`,
      support: context.log.forStep(id),
    };
  },

  /**
   * A ceiling is a promise about spend, so this reads the **actual** units the provider
   * reported, and the projection too: a route that projected over the ceiling and got
   * lucky is still a broken gate. An unreported cost fails — silence is not zero (US-AG3).
   */
  cost_within_ceiling(args, context) {
    const [id, outcome] = step(args, context);
    if (outcome === undefined) return miss(id, context);
    const ceiling = args[1];
    const cost = outcome.result?.cost;
    if (typeof ceiling !== 'number') {
      return { ok: false, detail: `cost_within_ceiling needs a numeric ceiling`, support: [] };
    }
    if (cost === undefined) {
      return {
        ok: false,
        detail: `${id} reported no cost — an unreported cost is not a zero cost`,
        support: context.log.forStep(id),
      };
    }
    return {
      ok: cost.actual_units <= ceiling && cost.projected_units <= ceiling,
      detail: `${id} projected ${cost.projected_units} / spent ${cost.actual_units} ${cost.currency} against a ceiling of ${ceiling}`,
      support: context.log.forStep(id),
    };
  },

  /** Delta O: the step declared `expect: reject` and the provider did refuse it. */
  refused(args, context) {
    const [id, outcome] = step(args, context);
    if (outcome === undefined) return miss(id, context);
    return {
      ok: outcome.expected === 'reject' && outcome.refused !== undefined,
      detail:
        outcome.refused === undefined
          ? `${id} was not refused`
          : `${id} refused with ${outcome.refused.status}: ${outcome.refused.reason}`,
      support: context.log.forStep(id),
    };
  },

  /**
   * KCB §3 composition: the registry can *describe* a route from one port to another.
   * Args are port queries, e.g. `[{"plane":"knowledge","shape":"chat-messages"},
   * {"plane":"knowledge","shape":"completion-text"}]`.
   */
  capability_path_exists(args, context) {
    const [from, to] = args;
    if (!isJsonObject(from) || !isJsonObject(to)) {
      return { ok: false, detail: 'capability_path_exists needs two port queries', support: [] };
    }
    const path = context.registry.path({ from: from as PortQuery, to: to as PortQuery });
    return {
      ok: path !== undefined,
      detail:
        path === undefined
          ? `no path from ${JSON.stringify(from)} to ${JSON.stringify(to)}`
          : `${path.steps.map((s) => `${s.identity}/${s.capability}`).join(' → ')} (${path.projectedUnits} units)`,
      support: [],
    };
  },

  /** KINP §8: a `resolve` step turned `local` into `canonical`. Read off the log. */
  resolves_to(args, context) {
    const [local, canonical] = args;
    const support = context.log
      .entries()
      .filter(
        (entry) =>
          entry.direction === 'response' &&
          entry.detail.resolved === local &&
          entry.detail.id === canonical,
      );
    return {
      ok: support.length > 0,
      detail:
        support.length > 0
          ? `${String(local)} resolved to ${String(canonical)}`
          : `no observation resolves ${String(local)} to ${String(canonical)}`,
      support,
    };
  },
};

/** Evaluate one §5 predicate. An unknown or unimplemented name never passes. */
export function evaluateAssertion(
  predicate: string,
  args: Json[],
  context: AssertionContext,
): AssertionVerdict {
  const evaluator = EVALUATORS[predicate];
  if (evaluator !== undefined) return evaluator(args, context);
  if (ASSERTION_NAMES.includes(predicate)) {
    return {
      ok: false,
      pending: true,
      detail: `${predicate} is KCS §5 vocabulary this build cannot evaluate yet`,
      support: [],
    };
  }
  return { ok: false, detail: `${predicate} is not a KCS §5 predicate`, support: [] };
}

/** True when this build can actually evaluate `predicate` (the console's own doctor). */
export function isImplemented(predicate: string): boolean {
  return EVALUATORS[predicate] !== undefined;
}

function step(args: Json[], context: AssertionContext): [string, StepOutcome | undefined] {
  const id = String(args[0]);
  return [id, context.outcomes.get(id)];
}

function miss(id: string, context: AssertionContext): AssertionVerdict {
  return { ok: false, detail: `no step ${id} ran`, support: context.log.forStep(id) };
}
