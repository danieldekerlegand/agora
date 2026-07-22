/**
 * A hand-composed request, compiled into a one-step KCS scenario.
 *
 * This is the whole of manual mode's runtime, and it is deliberately three dozen lines: a
 * manual request is *not* a second way to talk to the fabric. It is compiled into a
 * {@link ScenarioDocument} with one step and handed to the same `runConformance` the
 * library uses, so discovery goes through the registry, the connection is opened directly
 * by `kcs/link.ts`, and the exchange lands in the same observation log under the same
 * report. A parallel client here would be a second implementation of ADR-0001 decision 7 —
 * and the one that nobody's scenarios keep honest.
 *
 * The compiled document carries no `assert` steps, and that is the honest reading of what
 * an operator did: a manual call proves the call went through, not that the fabric holds
 * any property. A green manual report means "the peer answered"; asserting more than that
 * is what the scenario library is for.
 */
import { RESOLVER_IDENTITY } from '@agora/resolver';
import {
  parseScenario,
  SPEC_VERSIONS,
  type EntityDescriptor,
  type Json,
  type JsonObject,
  type Participant,
  type PortValue,
  type ScenarioDocument,
  type Step,
} from '@agora/schemas';

import type { PortField } from './catalogue.ts';

/** `kcs:manual` — the synthetic scenario every manual request runs as. */
export const MANUAL_SCENARIO_ID = 'kcs:manual';

/** The single step's id, so a report can be read back to the request that made it. */
export const MANUAL_STEP_ID = 'manual';

/** Thrown when what was typed into the composer is not a request that can be sent. */
export class ManualRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualRequestError';
  }
}

export interface ManualInvoke {
  verb: 'invoke';
  participant: string;
  /** The fixture standing in for this peer, when it has not adopted the bus (delta N). */
  standin?: string | undefined;
  capability: string;
  inputs: PortValue[];
  /** Spend ceiling for this one call, in KCB budget units (§5 `cost_within_ceiling`). */
  budgetUnits?: number | undefined;
  options?: JsonObject | undefined;
}

export interface ManualFetch {
  verb: 'fetch';
  participant: string;
  standin?: string | undefined;
  asset: string;
}

export interface ManualResolve {
  verb: 'resolve';
  ref: EntityDescriptor;
}

export type ManualRequest = ManualInvoke | ManualFetch | ManualResolve;

/**
 * What the operator typed, as plane-typed port values.
 *
 * A field left blank sends nothing for that port: a port the caller had no value for is
 * absent, not empty. `undefined` is not `null` on the wire anywhere else in this console
 * and it is not here either.
 */
export function portValuesFrom(
  fields: readonly PortField[],
  texts: readonly string[],
): PortValue[] {
  const values: PortValue[] = [];
  fields.forEach((field, index) => {
    const text = (texts[index] ?? '').trim();
    if (text === '') return;
    if (field.entry === 'ref') {
      values.push({ port: field.port, ref: text });
      return;
    }
    try {
      values.push({ port: field.port, value: JSON.parse(text) as Json });
    } catch (error) {
      throw new ManualRequestError(
        `${field.label} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  return values;
}

/**
 * Compile a manual request into the scenario that will carry it.
 *
 * Validated through `parseScenario` rather than trusted, so a request the composer built
 * wrong fails with the spec's own message *before* anybody is dialed — the same check every
 * authored scenario passes through.
 */
export function manualScenario(request: ManualRequest): ScenarioDocument {
  return parseScenario({
    kcs_version: SPEC_VERSIONS.kcs,
    id: MANUAL_SCENARIO_ID,
    title: describeRequest(request),
    participants: participantsFor(request),
    steps: [stepFor(request)],
  });
}

/** The request in one line — the report's title, and the composer's own summary. */
export function describeRequest(request: ManualRequest): string {
  switch (request.verb) {
    case 'invoke':
      return `manual invoke — ${request.capability} on ${request.participant}`;
    case 'fetch':
      return `manual fetch — ${request.asset} from ${request.participant}`;
    case 'resolve':
      return `manual resolve — ${request.ref.id ?? request.ref.name ?? 'an unnamed entity'}`;
  }
}

/**
 * Who the run declares it is talking to. A `resolve` names the resolver rather than a
 * dialed peer: it is answered by the console's own resolver (KINP §8), and a participant
 * list that named a provider would put an address in the report that nobody contacted.
 */
function participantsFor(request: ManualRequest): Participant[] {
  if (request.verb === 'resolve') return [{ identity: RESOLVER_IDENTITY }];
  return [
    {
      identity: request.participant,
      ...(request.standin === undefined ? {} : { standin: { fixtures: request.standin } }),
    },
  ];
}

function stepFor(request: ManualRequest): Step {
  const base = { id: MANUAL_STEP_ID, title: describeRequest(request) } as const;
  switch (request.verb) {
    case 'invoke':
      return {
        ...base,
        kind: 'invoke',
        participant: request.participant,
        capability: request.capability,
        inputs: request.inputs,
        ...(request.budgetUnits === undefined ? {} : { budget_units: request.budgetUnits }),
        ...(request.options === undefined ? {} : { options: request.options }),
      };
    case 'fetch':
      return { ...base, kind: 'fetch', participant: request.participant, asset: request.asset };
    case 'resolve':
      return { ...base, kind: 'resolve', ref: request.ref };
  }
}
