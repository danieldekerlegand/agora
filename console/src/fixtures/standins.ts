/**
 * Stand-in fixtures for the peers that have not adopted the bus yet (KCS delta N).
 *
 * These are what a scenario's `standin.fixtures` path points at. They are deliberately
 * *fabric-shaped* rather than console-shaped: KGP delta packs, KMI asset envelopes, KINP
 * links exactly as `koine/specs` writes them — so when Insimul or Pinakes does publish a
 * manifest, the scenario is unchanged, the fixture is deleted, and the assertions that
 * were passing against the fixture are the same assertions now passing against the peer.
 *
 * A fixture that drifted from the spec would be the one way a green run could mean
 * nothing, which is why they are read through the same {@link ../kcs/facts.ts} extraction
 * the live path uses.
 *
 * Fixtures are grouped **per scenario**, not one per peer: a stand-in is a recording of the
 * exchanges one scenario drives, and two scenarios ask the same peer different questions.
 * The identity is the peer's own either way, so adoption still deletes fixtures rather than
 * rewriting scenarios.
 */
import type { Json } from '@agora/schemas';

import insimul from './standin-insimul.json';
import pinakes from './standin-pinakes.json';
import worldsToFabricArgos from './worlds-to-fabric/analyzer.json';
import worldsToFabricInsimul from './worlds-to-fabric/insimul.json';
import worldsToFabricPinakes from './worlds-to-fabric/pinakes.json';

/** Where each fixture lives, as a scenario names it. */
export const INSIMUL_STANDIN = 'fixtures/standin-insimul.json';
export const PINAKES_STANDIN = 'fixtures/standin-pinakes.json';

/** `kcs:worlds-to-fabric` (US-CS2) — none of its three participants has adopted KCB yet. */
export const WORLDS_TO_FABRIC_INSIMUL = 'fixtures/worlds-to-fabric/insimul.json';
export const WORLDS_TO_FABRIC_ARGOS = 'fixtures/worlds-to-fabric/analyzer.json';
export const WORLDS_TO_FABRIC_PINAKES = 'fixtures/worlds-to-fabric/pinakes.json';

const FIXTURES: Record<string, unknown> = {
  [INSIMUL_STANDIN]: insimul,
  [PINAKES_STANDIN]: pinakes,
  [WORLDS_TO_FABRIC_INSIMUL]: worldsToFabricInsimul,
  [WORLDS_TO_FABRIC_ARGOS]: worldsToFabricArgos,
  [WORLDS_TO_FABRIC_PINAKES]: worldsToFabricPinakes,
};

/**
 * A loader over the bundled fixtures — what a gate hands the runner in place of fetching
 * them over HTTP. Unknown paths fail loudly: a scenario naming a fixture nobody ships must
 * go red, not run against an empty stand-in.
 */
export function bundledFixtures(): (path: string) => Promise<Json> {
  return (path: string): Promise<Json> => {
    const document = FIXTURES[path];
    if (document === undefined) return Promise.reject(new Error(`no bundled fixture at ${path}`));
    return Promise.resolve(document as Json);
  };
}
