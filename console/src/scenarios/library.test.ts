import { parseScenario, SPEC_VERSIONS } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { findScenario, SCENARIO_LIBRARY } from './library.ts';

describe('the scenario library', () => {
  it('offers every scenario the console ships', () => {
    expect(SCENARIO_LIBRARY.map((entry) => entry.scenario.id)).toEqual([
      'kcs:provider-router-roundtrip',
      'kcs:worlds-to-fabric',
      'kcs:media-transform',
    ]);
  });

  it('holds documents that parse, at the KCS version the commons is pinned to', () => {
    // A menu item that only fails when somebody clicks it is worse than no menu: the
    // library carries the documents themselves, so a scenario that stopped parsing is a
    // red gate here rather than a red run in front of an operator.
    for (const entry of SCENARIO_LIBRARY) {
      expect(parseScenario(entry.scenario).kcs_version).toBe(SPEC_VERSIONS.kcs);
    }
  });

  it('says what each one proves, and which koine document it encodes', () => {
    for (const entry of SCENARIO_LIBRARY) {
      expect(entry.summary.length).toBeGreaterThan(0);
    }
    expect(findScenario('kcs:worlds-to-fabric')?.source).toBe(
      'koine/scenarios/e2e-worlds-to-fabric.md',
    );
  });

  it('knows nothing about a scenario it does not ship', () => {
    expect(findScenario('kcs:not-a-scenario')).toBeUndefined();
  });
});
