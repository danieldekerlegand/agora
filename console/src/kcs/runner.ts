/**
 * The scenario runner — KCS §4's execution & observation model.
 *
 * 1. **Discover** participants via the registry; **open direct** links (no proxy).
 * 2. **Run** steps, honoring `after` and `timeout_ms`, recording every exchange.
 * 3. **Evaluate** `assert` steps against the observation log.
 * 4. **Report** per-assertion pass/fail with its supporting log slice, plus green/red.
 *
 * The console is a participant/observer (ADR-0001 decision 7): it injects requests over
 * the same connections production uses and reads what comes back. It is never in the path
 * between two other peers, which is why {@link Link} is the only module that dials and it
 * only ever dials on the console's own behalf.
 *
 * Three scheduling rules, all of them consequences of the spec rather than preferences:
 *
 * * A step with no `after` runs after the one declared before it (§3 "in declared order").
 * * A step whose dependency failed is **skipped**, so a broken run reports one failure
 *   instead of a cascade — except `assert` steps, which always run. An assertion that did
 *   not run cannot be red, and a red run has to be able to say *which* property broke.
 * * A step kind this build cannot execute **fails**; it is never skipped quietly. The
 *   pressure-test scenarios (§6) need `fetch`/`emit`/`subscribe`, and until those land a
 *   scenario using them must be honestly red.
 */
import type { CapabilityRegistry, Registration } from '@agora/registry';
import type { Resolver } from '@agora/resolver';
import { createLocalResolver } from '@agora/resolver';
import {
  parseScenario,
  SPEC_VERSIONS,
  type AssertStep,
  type Expectation,
  type InvokeStep,
  type Json,
  type JsonObject,
  type ResolveStep,
  type ScenarioDocument,
  type Step,
} from '@agora/schemas';

import { evaluateAssertion, type AssertionContext } from './assertions.ts';
import { bind, type Bindings } from './bindings.ts';
import { platformFetch, type HttpFetch } from './http.ts';
import { openLink, RefusedError, type Link } from './link.ts';
import { CONSOLE_IDENTITY, detail, ObservationLog } from './log.ts';
import {
  isGreen,
  type AssertionOutcome,
  type ConformanceReport,
  type ParticipantOutcome,
  type StepOutcome,
} from './outcome.ts';
import type { InvocationResult } from './wire.ts';

export interface RunOptions {
  /** The index the scenario's participants are resolved through (KCB §3). */
  registry: CapabilityRegistry;
  /** Defaults to the platform fetch — the live console passes nothing. */
  fetch?: HttpFetch | undefined;
  /** Defaults to the local stub (US-AG4); the full resolver is backlogged. */
  resolver?: Resolver | undefined;
  /** Injectable clock so a report is reproducible in a test. */
  now?: (() => string) | undefined;
  /** Injectable elapsed-time source, same reason. */
  clock?: (() => number) | undefined;
}

/** Run a scenario document end to end and report what was observed. */
export async function runScenario(
  document: unknown,
  options: RunOptions,
): Promise<ConformanceReport> {
  const scenario = parseScenario(document);
  const log = new ObservationLog(options.now ?? (() => new Date().toISOString()));
  const clock = options.clock ?? (() => performance.now());
  const fetch = options.fetch ?? platformFetch();
  const resolver = options.resolver ?? createLocalResolver();
  const startedAt = clock();

  const { links, participants } = discover(scenario, options.registry, { fetch, log });

  const steps = [...(scenario.setup ?? []), ...scenario.steps, ...(scenario.teardown ?? [])];
  const outcomes = new Map<string, StepOutcome>();
  const bindings = new Map<string, Json>();
  const assertions: AssertionOutcome[] = [];
  const context = (): AssertionContext => ({
    scenario,
    outcomes,
    log,
    registry: options.registry,
  });

  const run = execute(steps, {
    links,
    resolver,
    log,
    clock,
    outcomes,
    bindings,
    assertions,
    context,
  });
  try {
    await withTimeout(run, scenario.timeout_ms, `scenario ${scenario.id}`);
  } catch {
    // The scenario's own liveness bound blew. Steps that never ran are reported below as
    // failures rather than losing the whole report — a timed-out run is red, not absent.
  }

  const stepOutcomes = steps.map(
    (step) =>
      outcomes.get(step.id) ?? {
        id: step.id,
        kind: step.kind,
        title: step.title,
        status: 'failed' as const,
        expected: step.expect ?? 'ok',
        error: 'the scenario timed out before this step ran',
        durationMs: 0,
      },
  );
  return {
    scenario: scenario.id,
    title: scenario.title,
    kcsVersion: SPEC_VERSIONS.kcs,
    green: isGreen(stepOutcomes, assertions),
    participants,
    steps: stepOutcomes,
    assertions,
    observations: log.entries(),
    durationMs: clock() - startedAt,
    stubbed: participants.some((participant) => participant.stubbed),
  };
}

interface RunState {
  links: Map<string, Link>;
  resolver: Resolver;
  log: ObservationLog;
  clock: () => number;
  outcomes: Map<string, StepOutcome>;
  bindings: Map<string, Json>;
  assertions: AssertionOutcome[];
  context: () => AssertionContext;
}

/**
 * Resolve every participant to an address through the registry — never a hard-coded one
 * (§2). A participant the index does not know is *not* fatal on its own: the steps that
 * need it fail, and the report says which participant was missing.
 */
function discover(
  scenario: ScenarioDocument,
  registry: CapabilityRegistry,
  options: { fetch: HttpFetch; log: ObservationLog },
): { links: Map<string, Link>; participants: ParticipantOutcome[] } {
  const links = new Map<string, Link>();
  const participants: ParticipantOutcome[] = [];
  for (const participant of scenario.participants) {
    const registration: Registration | undefined = registry.get(participant.identity);
    const outcome: ParticipantOutcome = {
      identity: participant.identity,
      stubbed: false,
      discovered: registration !== undefined,
    };
    if (registration !== undefined) {
      const link = openLink(registration, { fetch: options.fetch, log: options.log });
      links.set(participant.identity, link);
      outcome.endpoint = Object.values(registration.address.endpoints).find(
        (endpoint) => endpoint !== undefined,
      );
      outcome.note = `dialed directly over the ${link.wire.name} wire`;
    } else if (participant.standin !== undefined) {
      // Delta N: a not-yet-adopted peer may be stood in for — and the report says so, so a
      // green run is never mistaken for a fully live one.
      outcome.stubbed = true;
      outcome.note = `stood in for from ${participant.standin.fixtures}`;
    } else {
      outcome.note = 'not in the registry — steps that need it will fail';
    }
    options.log.record({
      step: 'discovery',
      participant: CONSOLE_IDENTITY,
      direction: 'frame',
      entities: [participant.identity],
      detail: detail({
        discovered: outcome.discovered,
        stubbed: outcome.stubbed,
        endpoint: outcome.endpoint ?? null,
      }),
    });
    participants.push(outcome);
  }
  return { links, participants };
}

/**
 * What each step waits on: its `after` when it declares one, otherwise the step declared
 * before it (§3 "in declared order"). An explicit `after: []` is therefore how a scenario
 * says "this one does not wait for its predecessor" — that is what delta P's explicit
 * concurrency buys.
 */
function dependenciesOf(steps: Step[]): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  steps.forEach((step, index) => {
    const previous = index > 0 ? steps[index - 1] : undefined;
    deps.set(step.id, step.after ?? (previous === undefined ? [] : [previous.id]));
  });
  return deps;
}

/**
 * Steps that can never run because their dependencies form a cycle.
 *
 * Worth its own pass: mixing a forward `after` with the declared-order default is an easy
 * way to write one, and a scheduler that simply awaited would hang the run until the
 * scenario timeout with nothing in the report to explain it. A deadlock reported as a
 * deadlock is the difference between a bug in the scenario and a bug in the console.
 */
function cyclicSteps(deps: Map<string, string[]>): Set<string> {
  const cyclic = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      for (const member of trail.slice(trail.indexOf(id))) cyclic.add(member);
      return;
    }
    state.set(id, 'visiting');
    for (const dependency of deps.get(id) ?? []) visit(dependency, [...trail, id]);
    state.set(id, 'done');
  };
  for (const id of deps.keys()) visit(id, []);
  return cyclic;
}

/** Schedule and run every step, honoring `after` and the declared-order default. */
async function execute(steps: Step[], state: RunState): Promise<void> {
  const running = new Map<string, Promise<void>>();
  const deps = dependenciesOf(steps);
  const cyclic = cyclicSteps(deps);
  // Every entry is registered before any continuation resumes (the loop below is
  // synchronous up to the first `await`), so `after` may point at a step declared later.
  const gate = Promise.resolve();
  steps.forEach((step) => {
    const dependencies = deps.get(step.id) ?? [];
    running.set(
      step.id,
      (async () => {
        await gate;
        if (cyclic.has(step.id)) {
          state.outcomes.set(step.id, {
            id: step.id,
            kind: step.kind,
            title: step.title,
            status: 'failed',
            expected: step.expect ?? 'ok',
            error: `circular dependency: ${step.id} waits on ${dependencies.join(', ')}`,
            durationMs: 0,
          });
          return;
        }
        await Promise.allSettled(dependencies.map((id) => running.get(id)));
        const blocked = dependencies.filter((id) => state.outcomes.get(id)?.status !== 'passed');
        if (blocked.length > 0 && step.kind !== 'assert') {
          state.outcomes.set(step.id, {
            id: step.id,
            kind: step.kind,
            title: step.title,
            status: 'skipped',
            expected: step.expect ?? 'ok',
            error: `blocked by ${blocked.join(', ')}`,
            durationMs: 0,
          });
          return;
        }
        await runStep(step, state);
      })(),
    );
  });
  await Promise.all(running.values());
}

async function runStep(step: Step, state: RunState): Promise<void> {
  const startedAt = state.clock();
  const expected: Expectation = step.expect ?? 'ok';
  const finish = (outcome: Omit<StepOutcome, 'durationMs'>): void => {
    state.outcomes.set(step.id, { ...outcome, durationMs: state.clock() - startedAt });
  };
  try {
    const output = await withTimeout(perform(step, state), step.timeout_ms, `step ${step.id}`);
    if (expected === 'reject') {
      finish({
        id: step.id,
        kind: step.kind,
        title: step.title,
        status: 'failed',
        expected,
        error: 'expected a refusal, but the call succeeded',
        output: output.binding,
        result: output.result,
      });
      return;
    }
    if (output.binding !== undefined) state.bindings.set(step.id, output.binding);
    finish({
      id: step.id,
      kind: step.kind,
      title: step.title,
      status: 'passed',
      expected,
      output: output.binding,
      result: output.result,
    });
  } catch (error) {
    const refused = error instanceof RefusedError ? { status: error.status, reason: error.reason } : undefined;
    const passed = expected === 'reject' && refused !== undefined;
    if (refused !== undefined) state.bindings.set(step.id, { refused: true, status: refused.status });
    finish({
      id: step.id,
      kind: step.kind,
      title: step.title,
      status: passed ? 'passed' : 'failed',
      expected,
      refused,
      error: passed ? undefined : message(error),
    });
  }
}

interface StepProduct {
  binding?: Json | undefined;
  result?: InvocationResult | undefined;
}

async function perform(step: Step, state: RunState): Promise<StepProduct> {
  switch (step.kind) {
    case 'invoke':
      return await invoke(step, state);
    case 'resolve':
      return await resolve(step, state);
    case 'assert':
      return assert(step, state);
    case 'fetch':
    case 'subscribe':
    case 'emit':
      // Named, not silently skipped: encoding the §6 pressure tests is what makes these
      // land, and until they do a scenario that uses one must fail rather than pass thin.
      throw new Error(`console: \`${step.kind}\` steps are not implemented in this build`);
  }
}

async function invoke(step: InvokeStep, state: RunState): Promise<StepProduct> {
  const link = state.links.get(step.participant);
  if (link === undefined) {
    throw new Error(`${step.participant} was not discovered — no address to dial`);
  }
  const bindings: Bindings = state.bindings;
  const result = await link.invoke({
    step: step.id,
    capability: step.capability,
    inputs: (step.inputs ?? []).map((input) => ({
      plane: input.port.plane,
      shape: 'shape' in input.port ? input.port.shape : undefined,
      value: input.value === undefined ? undefined : bind(input.value, bindings),
    })),
    options: (step.options === undefined ? {} : bind(step.options, bindings)) as JsonObject,
    budgetUnits: step.budget_units,
  });
  return { binding: bindingFor(result), result };
}

async function resolve(step: ResolveStep, state: RunState): Promise<StepProduct> {
  const ref = step.ref;
  const resolved = await state.resolver.resolve(ref);
  state.log.record({
    step: step.id,
    participant: CONSOLE_IDENTITY,
    direction: 'response',
    plane: 'entity',
    entities: [resolved.id],
    detail: detail({
      resolved: ref.id ?? ref.name ?? null,
      id: resolved.id,
      kind: resolved.kind,
      authority: resolved.authority,
      confidence: resolved.confidence,
    }),
  });
  return {
    binding: {
      id: resolved.id,
      kind: resolved.kind,
      authority: resolved.authority,
      confidence: resolved.confidence,
    },
  };
}

function assert(step: AssertStep, state: RunState): StepProduct {
  const args = (step.args ?? []).map((arg) => bind(arg, state.bindings));
  const verdict = evaluateAssertion(step.predicate, args, state.context());
  state.assertions.push({
    id: step.id,
    predicate: step.predicate,
    args,
    ok: verdict.ok,
    pending: verdict.pending ?? false,
    detail: verdict.detail,
    support: verdict.support,
  });
  if (!verdict.ok) throw new Error(verdict.detail);
  return { binding: true };
}

/** What later steps can address as `${id.…}` — the normalised result, not the raw body. */
function bindingFor(result: InvocationResult): Json {
  const binding: JsonObject = {};
  if (result.tier !== undefined) binding.tier = result.tier;
  if (result.provider !== undefined) binding.provider = result.provider;
  if (result.model !== undefined) binding.model = result.model;
  if (result.text !== undefined) binding.text = result.text;
  if (result.cost !== undefined) binding.cost = { ...result.cost };
  if (result.assets !== undefined) binding.assets = result.assets.map((asset) => ({ ...asset }));
  return binding;
}

/**
 * The liveness bound (delta P): a step that exceeds it fails rather than hanging the run.
 * The timer is always cleared — a scenario that finishes fast should not hold the process
 * open for the length of its longest declared timeout.
 */
async function withTimeout<T>(work: Promise<T>, ms: number | undefined, what: string): Promise<T> {
  if (ms === undefined) return await work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded its ${ms}ms liveness bound`)), ms);
  });
  try {
    return await Promise.race([work, bound]);
  } finally {
    clearTimeout(timer);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
