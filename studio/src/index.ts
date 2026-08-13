/**
 * `@agora/studio` — the studio shell's surface.
 *
 * Source-first like every other area here: this file *is* the package's entry point, nothing
 * is emitted. Views land alongside `App` as they are built; the shell exports no participant
 * data, because it holds none — everything on this surface is a component, a shape, or a
 * function over data the caller supplies.
 */
import { SPEC_VERSIONS } from '@agora/schemas';

import { STUDIO_CONFIG_FORMAT } from './config.ts';

export { App, type AppProps } from './App.tsx';
export { Connections, type ConnectionsProps } from './Connections.tsx';
export { SpecViewer, type SpecViewerProps } from './SpecViewer.tsx';
export { Stage, type StageProps } from './Stage.tsx';
export { TopologyGraph, type TopologyGraphProps } from './TopologyGraph.tsx';
export { useTopology, type TopologyReading } from './useTopology.ts';
export {
  useConnections,
  type ConnectionsOptions,
  type ConnectionsReading,
} from './useConnections.ts';
export {
  embeddedConfigText,
  readStudioConfig,
  type StudioConfigReading,
} from './config.ts';
export {
  discoverNodes,
  discoverTopology,
  edgesOf,
  nodesOf,
  pathEdges,
  resolveNodes,
  topologyOf,
  type Discovery,
  type EdgeScope,
  type IdentityResolver,
  type Topology,
  type TopologyEdge,
  type TopologyInput,
  type TopologyNode,
  type TopologyQuery,
} from './topology.ts';
export {
  directLink,
  healthOf,
  httpProbe,
  monitorConnections,
  statusOf,
  unwatchedConnections,
  type ConnectionHealth,
  type ConnectionProbe,
  type ConnectionStatus,
  type DirectLink,
  type HttpProbeOptions,
  type MonitoredEdge,
  type MonitoredTopology,
  type MonitorOptions,
  type Observation,
  type ProbeFetch,
  type ProbeRequestInit,
  type ProbeResponse,
} from './connection.ts';
export {
  connectionKey,
  trackConnections,
  uptimeOf,
  type ConnectionError,
  type ConnectionRecord,
  type TrackOptions,
} from './history.ts';
export {
  advertisementOf,
  isEmptyView,
  pinnedVersion,
  specViewOf,
  type Advertisement,
  type ArtifactKind,
  type ArtifactSource,
  type SpecAdvertisement,
  type SpecArtifact,
  type SpecName,
  type SpecView,
} from './specs.ts';
export {
  backboneOf,
  EMPTY_BACKBONE,
  isEmpty,
  labelOf,
  type Backbone,
  type Connection,
  type Participant,
} from './backbone.ts';

export interface StudioDescription {
  kcbVersion: string;
  /** Always false — ADR-0001 decisions 3 and 7. Studio draws what it watched; it is not a
   * path between two participants, and there is no verb on this surface that could become one. */
  relaysPayloads: false;
  /** Always 0. Whatever is on screen came in at runtime; nothing ships in the bundle. */
  bundledParticipants: 0;
  /** The config format this build reads. The config itself lives with the user, never here. */
  configFormat: string;
}

/**
 * What this build is, in the terms the rest of the tree describes itself in (`describeRegistry`,
 * `describeResolver`). Both invariants are asserted in the test suite, so flipping either one
 * fails the gate rather than quietly changing what Studio is.
 */
export function describeStudio(): StudioDescription {
  return {
    kcbVersion: SPEC_VERSIONS.kcb,
    relaysPayloads: false,
    bundledParticipants: 0,
    configFormat: STUDIO_CONFIG_FORMAT,
  };
}
