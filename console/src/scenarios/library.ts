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
 * two hand-written pressure tests (KCS §6) in the order koine wrote them.
 */
import type { ScenarioDocument } from '@agora/schemas';

import { MEDIA_TRANSFORM } from './media-transform.ts';
import { PROVIDER_ROUTER_ROUNDTRIP } from './provider-router-roundtrip.ts';
import { WORLDS_TO_FABRIC } from './worlds-to-fabric.ts';

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
    scenario: WORLDS_TO_FABRIC,
    summary:
      'Fiction stays out of consensus reality across the media→knowledge bridge — the identity firewall.',
    source: 'koine/scenarios/e2e-worlds-to-fabric.md',
  },
  {
    scenario: MEDIA_TRANSFORM,
    summary:
      'A playthrough through four projects: a cross-plane route, a CAS fetch, source worlds, a spend ceiling.',
    source: 'koine/scenarios/e2e-media-transform.md',
  },
];

/** The library entry for a scenario id, or `undefined` — the console ships no others. */
export function findScenario(id: string): LibraryEntry | undefined {
  return SCENARIO_LIBRARY.find((entry) => entry.scenario.id === id);
}
