/**
 * What a run produces: one outcome per step, and the conformance report over them
 * (KCS §4.4 — "per-assertion pass/fail + the supporting log slice, plus overall
 * green/red").
 *
 * Kept in its own module because both the runner (which writes them) and the assertions
 * (which read them) depend on these shapes, and a cycle between those two would be a
 * design smell as much as a bundler problem.
 */
import type { Expectation, Json, ScenarioDocument, StepKind } from '@agora/schemas';

import type { Observation } from './log.ts';
import type { InvocationResult } from './wire.ts';

export type StepStatus = 'passed' | 'failed' | 'skipped';

export interface StepOutcome {
  id: string;
  kind: StepKind;
  title?: string | undefined;
  status: StepStatus;
  expected: Expectation;
  /** Set when the provider refused — a pass under `expect: reject`, a failure otherwise. */
  refused?: { status: number; reason: string } | undefined;
  /** The value bound as `${id.…}` for later steps. */
  output?: Json | undefined;
  /** Present on `invoke`: the normalised result, where tier and cost live. */
  result?: InvocationResult | undefined;
  error?: string | undefined;
  durationMs: number;
}

export interface AssertionOutcome {
  id: string;
  predicate: string;
  args: Json[];
  ok: boolean;
  pending: boolean;
  detail: string;
  support: Observation[];
}

/** How a participant was reached — or that it was stood in for (delta N). */
export interface ParticipantOutcome {
  identity: string;
  /** The address the registry returned. Absent when discovery failed. */
  endpoint?: string | undefined;
  /** True when a `standin` fixture was used instead of a live endpoint. */
  stubbed: boolean;
  discovered: boolean;
  note?: string | undefined;
}

export interface ConformanceReport {
  scenario: string;
  title: string;
  kcsVersion: string;
  /** Overall verdict: every step and every assertion, or red. */
  green: boolean;
  participants: ParticipantOutcome[];
  steps: StepOutcome[];
  assertions: AssertionOutcome[];
  observations: readonly Observation[];
  durationMs: number;
  /** True when any participant was stood in for — a green run that was not all real. */
  stubbed: boolean;
}

/** The verdict, computed once so the UI and the tests cannot disagree about it. */
export function isGreen(steps: StepOutcome[], assertions: AssertionOutcome[]): boolean {
  return steps.every((s) => s.status === 'passed') && assertions.every((a) => a.ok);
}

/** The scenario's identity line, for a report header. */
export function describeScenario(scenario: ScenarioDocument): string {
  return `${scenario.id} — ${scenario.title}`;
}

/** What a routed call resolved to. The console's headline: which tier served it, at what cost. */
export interface Routing {
  step: string;
  tier: string;
  provider?: string | undefined;
  model?: string | undefined;
  currency: string;
  projectedUnits: number;
  actualUnits: number;
  /** The ceiling the step declared, when it declared one. */
  budgetUnits: number | null;
}

/**
 * Every routed call in a report, in step order. Derived from the outcomes rather than
 * hard-coded to one step id, so a scenario with three invokes shows three rows.
 */
export function routings(report: ConformanceReport): Routing[] {
  const found: Routing[] = [];
  for (const step of report.steps) {
    const { result } = step;
    if (result?.tier === undefined || result.cost === undefined) continue;
    found.push({
      step: step.id,
      tier: result.tier,
      provider: result.provider,
      model: result.model,
      currency: result.cost.currency,
      projectedUnits: result.cost.projected_units,
      actualUnits: result.cost.actual_units,
      budgetUnits: result.cost.budget_units,
    });
  }
  return found;
}
