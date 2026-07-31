/**
 * **SAMPLE FIXTURES — not a contract.** Every project name in this module and the JSON beside
 * it is fixture text: the cast of the ecosystem agora was extracted from, kept so the sample
 * scenarios stay faithful to koine's worked examples. Nothing in the console's runtime reads a
 * name from here — a stand-in is loaded by PATH, and a real deployment points at its own.
 *
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
import monitorArgos from './monitor/analyzer.json';
import monitorInsimul from './monitor/insimul.json';
import mediaTransformArgos from './media-transform/analyzer.json';
import mediaTransformFormant from './media-transform/composer.json';
import mediaTransformInsimul from './media-transform/insimul.json';
import mediaTransformPinakes from './media-transform/pinakes.json';
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

/**
 * `kcs:media-transform` (US-CS3) — four projects, none of them on the bus.
 *
 * These fixtures carry a `manifest` as well as canned exchanges, because the scenario's
 * first step is *path planning*: a peer that has published no manifest is missing from the
 * control plane too, and `capability_path_exists` would have nothing to plan over. The
 * runner indexes them for the run only (see `kcs/runner.ts`).
 */
export const MEDIA_TRANSFORM_INSIMUL = 'fixtures/media-transform/insimul.json';
export const MEDIA_TRANSFORM_ARGOS = 'fixtures/media-transform/analyzer.json';
export const MEDIA_TRANSFORM_FORMANT = 'fixtures/media-transform/composer.json';
export const MEDIA_TRANSFORM_PINAKES = 'fixtures/media-transform/pinakes.json';

/**
 * The streams the live monitor (US-CS7) is pointed at.
 *
 * Kept apart from the scenario fixtures rather than folded in with them, because a monitor is
 * *configured with what to watch*: subscribing to every fixture that happens to carry a
 * `subscribe` section would have the same peer watched three times over, once per scenario
 * that recorded it. These carry no `manifest` on purpose — they describe streams to observe,
 * not routes anybody may dial.
 *
 * `monitor/analyzer.json` emits exchange telemetry (`kcs/spans.ts`); `monitor/insimul.json`
 * emits none, which is the documented control-plane limitation on screen: an invoke served by
 * a provider that publishes no telemetry is simply absent from the feed.
 */
export const MONITOR_ARGOS = 'fixtures/monitor/analyzer.json';
export const MONITOR_INSIMUL = 'fixtures/monitor/insimul.json';

const MONITORED: Record<string, unknown> = {
  [MONITOR_ARGOS]: monitorArgos,
  [MONITOR_INSIMUL]: monitorInsimul,
};

/** The watch list, as a copy — a caller that could edit this map edits what everyone sees. */
export function monitorStandins(): Record<string, Json> {
  return { ...(MONITORED as Record<string, Json>) };
}

const FIXTURES: Record<string, unknown> = {
  [INSIMUL_STANDIN]: insimul,
  [PINAKES_STANDIN]: pinakes,
  ...MONITORED,
  [WORLDS_TO_FABRIC_INSIMUL]: worldsToFabricInsimul,
  [WORLDS_TO_FABRIC_ARGOS]: worldsToFabricArgos,
  [WORLDS_TO_FABRIC_PINAKES]: worldsToFabricPinakes,
  [MEDIA_TRANSFORM_INSIMUL]: mediaTransformInsimul,
  [MEDIA_TRANSFORM_ARGOS]: mediaTransformArgos,
  [MEDIA_TRANSFORM_FORMANT]: mediaTransformFormant,
  [MEDIA_TRANSFORM_PINAKES]: mediaTransformPinakes,
};

/**
 * A loader over the bundled fixtures — what a gate hands the runner in place of fetching
 * them over HTTP. Unknown paths fail loudly: a scenario naming a fixture nobody ships must
 * go red, not run against an empty stand-in.
 */
/**
 * Every bundled fixture, by the path a scenario names it at.
 *
 * The manual explorer browses these as well as the registry: a fixture that carries a
 * `manifest` describes a peer nobody can dial yet, and an operator wanting to see the shape
 * of a capability before its provider ships it has nowhere else to look. Handed out as a
 * copy — a caller that could edit this map would be editing what every scenario stands in on.
 */
export function bundledStandins(): Record<string, Json> {
  return { ...(FIXTURES as Record<string, Json>) };
}

export function bundledFixtures(): (path: string) => Promise<Json> {
  return (path: string): Promise<Json> => {
    const document = FIXTURES[path];
    if (document === undefined) return Promise.reject(new Error(`no bundled fixture at ${path}`));
    return Promise.resolve(document as Json);
  };
}
