/**
 * The scenario library — every conformance scenario the console ships, in one list.
 *
 * A library rather than a hard-coded default because a conformance suite is only useful if
 * it can be *run*: the UI lists these, an operator picks one, and it goes out over the same
 * direct connections (ADR-0001 decision 7). Nothing here is a description of a scenario —
 * each entry carries the scenario document itself, so a scenario that stopped parsing is a
 * red gate rather than a menu item that fails when somebody clicks it.
 *
 * Order is the order the console offers them: the cheapest real round-trip first, then the
 * multi-participant sample.
 *
 * Both entries are **neutral** — a commons runtime ships the runner and a sample to prove it
 * runs, not a particular deployment's cast. The ecosystem's own conformance scenarios, with
 * their real participants and fixtures, live in the private `legacy` integration repo; they
 * are loaded from there rather than bundled here (see `console/README.md`).
 */
import type { ScenarioDocument } from '@agora/schemas';

import { PROVIDER_ROUTER_ROUNDTRIP } from './provider-router-roundtrip.ts';
import { SAMPLE_PIPELINE } from './sample-pipeline.ts';

export interface LibraryEntry {
  scenario: ScenarioDocument;
  /** One line: the property the scenario exists to prove. */
  summary: string;
  /** The koine document this encodes, when it encodes one (KCS §6). */
  source?: string;
}

export const SCENARIO_LIBRARY: readonly LibraryEntry[] = [
  {
    scenario: PROVIDER_ROUTER_ROUNDTRIP,
    summary:
      'A completion under a ceiling of zero budget units: the ladder always completes, for nothing.',
  },
  {
    scenario: SAMPLE_PIPELINE,
    summary:
      'A scoped world stays out of the baseline across the media→knowledge bridge — the identity firewall.',
  },
];

/** The library entry for a scenario id, or `undefined` — the console ships no others. */
export function findScenario(id: string): LibraryEntry | undefined {
  return SCENARIO_LIBRARY.find((entry) => entry.scenario.id === id);
}
