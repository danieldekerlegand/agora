/**
 * The Koine Conformance-Scenario document — `koine/specs/conformance-scenario.md` (KCS).
 *
 * A scenario is a declarative, replayable script that drives real providers over their
 * real MCP/A2A connections and asserts what was observed. It lives in `@agora/schemas`
 * rather than in the console because KCS §1 is explicit about the split: a step is typed
 * against all four planes, so the *format* is a cross-cutting contract; only the runtime
 * and UI belong to `agora/console`.
 *
 * Wire keys are `snake_case` as the spec writes them (`kcs_version`, `timeout_ms`,
 * `budget_units`) — a scenario is a document another project may author and hand to the
 * console, so this is a reader of the contract, not a translation of it.
 */
import type { Json, JsonObject } from './json.ts';
import type { KinpKind } from './identity.ts';
import { parseKinpId } from './identity.ts';
import { isPlane, type Plane } from './planes.ts';
import type { Port } from './manifest.ts';
import { SPEC_VERSIONS } from './versions.ts';

/** The step vocabulary (§3). One typed action each; `assert` evaluates over the log. */
export const STEP_KINDS = ['invoke', 'fetch', 'subscribe', 'resolve', 'emit', 'assert'] as const;

export type StepKind = (typeof STEP_KINDS)[number];

/**
 * What a step is expected to do (§3, delta O). `reject` steps *pass* when the call is
 * refused as intended — an unauthorized fetch, an over-ceiling invoke — so a negative-path
 * scenario asserts security rather than aborting on it.
 */
export type Expectation = 'ok' | 'reject';

/** Fields every step carries. `id` is mandatory: it is what `${id.path}` binds to (§2.1). */
export interface StepBase {
  id: string;
  kind: StepKind;
  /** Prose for the report — what this step is proving. */
  title?: string;
  expect?: Expectation;
  /** Explicit ordering. Absent, a step runs after the one declared before it. */
  after?: string[];
  /** Liveness bound (delta P). Exceeding it fails the step rather than hanging the run. */
  timeout_ms?: number;
}

/** A plane-typed value handed to a capability (§3: ports, never inline blobs). */
export interface PortValue {
  port: Port;
  /** The payload for this port, when it is small and structural (messages, a descriptor). */
  value?: Json;
  /** A KINP id — or a `${step.path}` binding — for anything the fabric already holds. */
  ref?: string;
}

/** Call a capability over the provider's real endpoint (KCB `invoke`). */
export interface InvokeStep extends StepBase {
  kind: 'invoke';
  /** KINP identity of the participant to dial. Resolved to an address at run time. */
  participant: string;
  /** The capability name as the provider's manifest declares it, e.g. `generate.text`. */
  capability: string;
  inputs?: PortValue[];
  /** Spend ceiling for this call, in KCB budget units (§5 `cost_within_ceiling`). */
  budget_units?: number;
  /** Wire-level hints (`max_tokens`, sampling). Ports carry the meaning; these carry the
   * knobs a transport needs and the planes have no vocabulary for. */
  options?: JsonObject;
}

/** Retrieve asset bytes (KCB `fetch`, KMI §7). */
export interface FetchStep extends StepBase {
  kind: 'fetch';
  participant: string;
  /** KINP asset id, or a binding to one a prior step minted. */
  asset: string;
}

/** Register for a world / capability and collect the delta stream (KCB §4, KGP §6). */
export interface SubscribeStep extends StepBase {
  kind: 'subscribe';
  participant: string;
  world?: string;
  capability?: string;
}

/** What a `resolve` step is asking about (KINP §4/§8). */
export interface EntityDescriptor {
  id?: string;
  kind?: KinpKind;
  name?: string;
  world?: string;
}

/** Look up an entity or its equivalence closure (KINP §8) via the resolver. */
export interface ResolveStep extends StepBase {
  kind: 'resolve';
  ref: EntityDescriptor;
}

/** Write a GroundingPack / assertion into the fabric (KGP). */
export interface EmitStep extends StepBase {
  kind: 'emit';
  participant: string;
  pack?: Json;
  claim?: Json;
}

/** Evaluate a predicate from the §5 vocabulary over the observation log. */
export interface AssertStep extends StepBase {
  kind: 'assert';
  predicate: string;
  args?: Json[];
}

export type Step =
  | InvokeStep
  | FetchStep
  | SubscribeStep
  | ResolveStep
  | EmitStep
  | AssertStep;

/**
 * A participant that has not adopted the bus yet may declare a `standin` (delta N); the
 * console uses the fixture in place of a live endpoint *and records that it did*, so a
 * green run never quietly means "half of it was a mock".
 */
export interface Standin {
  fixtures: string;
}

export interface Participant {
  /** KINP identity. A scenario never hard-codes an address — the registry resolves it. */
  identity: string;
  planes?: Plane[];
  standin?: Standin;
}

export interface ScenarioDocument {
  kcs_version: string;
  /** `kcs:<slug>` — the scenario is itself a fabric entity. */
  id: string;
  title: string;
  /** Scenario-level liveness bound (delta P). */
  timeout_ms?: number;
  participants: Participant[];
  setup?: Step[];
  steps: Step[];
  teardown?: Step[];
}

/** Thrown by {@link parseScenario}; the message names the offending path. */
export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioError';
  }
}

/**
 * True when a scenario's KCS version can be executed by this build — same rule as the
 * manifest's: same major, and below 1.0 the same minor.
 */
export function isCompatibleKcsVersion(version: string): boolean {
  const theirs = version.split('.');
  const ours = SPEC_VERSIONS.kcs.split('.');
  if (theirs[0] !== ours[0]) return false;
  return ours[0] !== '0' || theirs[1] === ours[1];
}

/**
 * Validate `value` as a scenario document, narrowing it in place.
 *
 * The structural checks are the ones a runner cannot recover from: duplicate step ids make
 * `${id.path}` ambiguous, and an `after` naming a step that does not exist is a schedule
 * that can never run. Both are caught here rather than half-way through a live run that
 * has already dialed somebody.
 */
export function parseScenario(value: unknown): ScenarioDocument {
  const doc = object(value, 'scenario');
  const version = string(doc.kcs_version, 'scenario.kcs_version');
  if (!isCompatibleKcsVersion(version)) {
    throw new ScenarioError(
      `scenario.kcs_version ${version} is not runnable by KCS ${SPEC_VERSIONS.kcs}`,
    );
  }
  string(doc.id, 'scenario.id');
  string(doc.title, 'scenario.title');
  participants(doc.participants);
  const ids = new Set<string>();
  for (const [phase, list] of [
    ['setup', doc.setup],
    ['steps', doc.steps],
    ['teardown', doc.teardown],
  ] as const) {
    if (list === undefined && phase !== 'steps') continue;
    array(list, `scenario.${phase}`).forEach((entry, index) =>
      step(entry, `scenario.${phase}[${index}]`, ids),
    );
  }
  // `after` is checked once every id is known, so a step may point either direction.
  for (const declared of [doc.setup, doc.steps, doc.teardown]) {
    if (declared === undefined) continue;
    for (const entry of declared as JsonObject[]) {
      for (const dependency of (entry.after ?? []) as string[]) {
        if (!ids.has(dependency)) {
          throw new ScenarioError(`step ${String(entry.id)} waits on unknown step ${dependency}`);
        }
      }
    }
  }
  return doc as unknown as ScenarioDocument;
}

function participants(value: unknown): void {
  const list = array(value, 'scenario.participants');
  if (list.length === 0) throw new ScenarioError('scenario.participants must not be empty');
  list.forEach((entry, index) => {
    const at = `scenario.participants[${index}]`;
    const participant = object(entry, at);
    if (parseKinpId(participant.identity) === undefined) {
      throw new ScenarioError(`${at}.identity must be a KINP id, got ${show(participant.identity)}`);
    }
    if (participant.planes !== undefined) {
      array(participant.planes, `${at}.planes`).forEach((plane, i) => {
        if (!isPlane(plane)) {
          throw new ScenarioError(`${at}.planes[${i}] must be a KCB plane, got ${show(plane)}`);
        }
      });
    }
  });
}

function step(value: unknown, at: string, ids: Set<string>): void {
  const entry = object(value, at);
  const id = string(entry.id, `${at}.id`);
  if (ids.has(id)) throw new ScenarioError(`${at}.id ${id} is declared twice — bindings need it unique`);
  ids.add(id);
  const kind = string(entry.kind, `${at}.kind`);
  if (!(STEP_KINDS as readonly string[]).includes(kind)) {
    throw new ScenarioError(`${at}.kind must be one of ${STEP_KINDS.join(', ')}, got ${show(kind)}`);
  }
  if (entry.expect !== undefined && entry.expect !== 'ok' && entry.expect !== 'reject') {
    throw new ScenarioError(`${at}.expect must be "ok" or "reject", got ${show(entry.expect)}`);
  }
  if (entry.after !== undefined) {
    array(entry.after, `${at}.after`).forEach((dependency, i) =>
      string(dependency, `${at}.after[${i}]`),
    );
  }
  if (kind === 'invoke') {
    string(entry.participant, `${at}.participant`);
    string(entry.capability, `${at}.capability`);
  }
  if (kind === 'assert') string(entry.predicate, `${at}.predicate`);
}

function object(value: unknown, at: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScenarioError(`${at} must be an object, got ${show(value)}`);
  }
  return value as JsonObject;
}

function array(value: unknown, at: string): Json[] {
  if (!Array.isArray(value)) throw new ScenarioError(`${at} must be an array, got ${show(value)}`);
  return value as Json[];
}

function string(value: unknown, at: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ScenarioError(`${at} must be a non-empty string, got ${show(value)}`);
  }
  return value;
}

function show(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}
