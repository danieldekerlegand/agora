import { parseScenario, SPEC_VERSIONS } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { findScenario, SCENARIO_LIBRARY } from './library.ts';

/** The commons' own identity, plus the neutral sample cast. Nothing else may ship. */
const NEUTRAL_AUTHORITIES = ['agora', 'producer', 'processor', 'curator', 'consumer', 'external'];

describe('the scenario library', () => {
  it('offers every scenario the console ships', () => {
    expect(SCENARIO_LIBRARY.map((entry) => entry.scenario.id)).toEqual([
      'kcs:provider-router-roundtrip',
      'kcs:sample-pipeline',
    ]);
  });

  it('casts every bundled scenario from the neutral sample authorities only', () => {
    // The commons is public; the ecosystem's real conformance scenarios and their fixtures
    // live in the private `legacy` integration repo. What ships here is the agnostic KCS
    // runner plus a sample proving it runs end to end — a bundled scenario naming a real
    // deployment's participant would put that deployment's cast back into a public runtime.
    // Asserted as an allow-list rather than a deny-list, so the check itself names nobody.
    for (const entry of SCENARIO_LIBRARY) {
      for (const participant of entry.scenario.participants ?? []) {
        expect(NEUTRAL_AUTHORITIES).toContain(participant.identity.split(':')[0]);
      }
    }
  });

  it('holds documents that parse, at the KCS version the commons is pinned to', () => {
    // A menu item that only fails when somebody clicks it is worse than no menu: the
    // library carries the documents themselves, so a scenario that stopped parsing is a
    // red gate here rather than a red run in front of an operator.
    for (const entry of SCENARIO_LIBRARY) {
      expect(parseScenario(entry.scenario).kcs_version).toBe(SPEC_VERSIONS.kcs);
    }
  });

  it('says what each one proves', () => {
    for (const entry of SCENARIO_LIBRARY) {
      expect(entry.summary.length).toBeGreaterThan(0);
    }
    expect(findScenario('kcs:sample-pipeline')?.scenario.participants).toHaveLength(3);
  });

  it('knows nothing about a scenario it does not ship', () => {
    expect(findScenario('kcs:not-a-scenario')).toBeUndefined();
  });
});
