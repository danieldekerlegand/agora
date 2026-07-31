/**
 * Stand-in fixtures for the peers that have not adopted the bus yet (KCS delta N).
 *
 * These are what a scenario's `standin.fixtures` path points at. They are deliberately
 * *fabric-shaped* rather than console-shaped: KGP delta packs, KMI asset envelopes, KINP
 * links exactly as `koine/specs` writes them — so when Producer or Curator does publish a
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
 *
 * Every peer here is a **neutral sample** cast — a producer, a processor, a curator and one
 * unadopted provider. The ecosystem's real conformance scenarios, with the deployment's own
 * participants, live in the private `legacy` integration repo (see `console/README.md`).
 */
import type { Json } from '@agora/schemas';

import producer from './standin-producer.json';
import monitorProcessor from './monitor/processor.json';
import monitorProducer from './monitor/producer.json';
import sampleProvider from './sample-provider.json';
import curator from './standin-curator.json';
import samplePipelineProcessor from './sample-pipeline/processor.json';
import samplePipelineProducer from './sample-pipeline/producer.json';
import samplePipelineCurator from './sample-pipeline/curator.json';

/** Where each fixture lives, as a scenario names it. */
export const PRODUCER_STANDIN = 'fixtures/standin-producer.json';
export const CURATOR_STANDIN = 'fixtures/standin-curator.json';

/** `kcs:sample-pipeline` — none of its three participants has adopted KCB yet. */
export const SAMPLE_PIPELINE_PRODUCER = 'fixtures/sample-pipeline/producer.json';
export const SAMPLE_PIPELINE_PROCESSOR = 'fixtures/sample-pipeline/processor.json';
export const SAMPLE_PIPELINE_CURATOR = 'fixtures/sample-pipeline/curator.json';

/**
 * A peer that publishes a manifest but has not adopted the bus.
 *
 * It carries a `manifest` as well as canned exchanges, which no scenario fixture has to: a
 * peer that has published no manifest is missing from the control plane too, so there is
 * nothing for `capability_path_exists` to plan over and nothing for the manual explorer to
 * browse. The runner indexes it for the run only (see `kcs/runner.ts`).
 */
export const SAMPLE_PROVIDER = 'fixtures/sample-provider.json';

/**
 * The streams the live monitor (US-CS7) is pointed at.
 *
 * Kept apart from the scenario fixtures rather than folded in with them, because a monitor is
 * *configured with what to watch*: subscribing to every fixture that happens to carry a
 * `subscribe` section would have the same peer watched three times over, once per scenario
 * that recorded it. These carry no `manifest` on purpose — they describe streams to observe,
 * not routes anybody may dial.
 *
 * `monitor/processor.json` emits exchange telemetry (`kcs/spans.ts`); `monitor/producer.json`
 * emits none, which is the documented control-plane limitation on screen: an invoke served by
 * a provider that publishes no telemetry is simply absent from the feed.
 */
export const MONITOR_PROCESSOR = 'fixtures/monitor/processor.json';
export const MONITOR_PRODUCER = 'fixtures/monitor/producer.json';

const MONITORED: Record<string, unknown> = {
  [MONITOR_PROCESSOR]: monitorProcessor,
  [MONITOR_PRODUCER]: monitorProducer,
};

/** The watch list, as a copy — a caller that could edit this map edits what everyone sees. */
export function monitorStandins(): Record<string, Json> {
  return { ...(MONITORED as Record<string, Json>) };
}

const FIXTURES: Record<string, unknown> = {
  [PRODUCER_STANDIN]: producer,
  [CURATOR_STANDIN]: curator,
  ...MONITORED,
  [SAMPLE_PIPELINE_PRODUCER]: samplePipelineProducer,
  [SAMPLE_PIPELINE_PROCESSOR]: samplePipelineProcessor,
  [SAMPLE_PIPELINE_CURATOR]: samplePipelineCurator,
  [SAMPLE_PROVIDER]: sampleProvider,
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
