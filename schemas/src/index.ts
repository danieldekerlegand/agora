/**
 * Shared protocol types for the agora commons.
 *
 * These mirror the ratified koine specs — see `../../koine/specs/`. The specs are
 * authoritative; anything here that disagrees with them is a bug in this file.
 *
 * - `versions.ts` — the spec versions this build implements (cross-pinned to Python)
 * - `json.ts`     — the JSON value type everything off the wire starts as
 * - `planes.ts`   — the three protocol planes (KCB §2.1)
 * - `identity.ts` — KINP compact identifiers (KINP §3.2)
 * - `manifest.ts` — the KCB capability manifest (KCB §2), what the registry indexes
 * - `scenario.ts` — the KCS conformance-scenario document (KCS §2/§3), what the console runs
 * - `relation-registry.ts` — where the shared relation registry lives (koine) and which
 *   `registryVersion` this build speaks
 */
export { SPEC_VERSIONS } from './versions.ts';
export { RELATION_REGISTRY, type RegistryMirror } from './relation-registry.ts';
export { isJsonObject, type Json, type JsonObject } from './json.ts';
export { isPlane, PLANES, type Plane } from './planes.ts';
export { isKinpId, KINP_KINDS, parseKinpId, type KinpId, type KinpKind } from './identity.ts';
export {
  isCapabilityManifest,
  isCompatibleKcbVersion,
  ManifestError,
  parseManifest,
  type Capability,
  type CapabilityCost,
  type CapabilityManifest,
  type EntityPort,
  type KnowledgePort,
  type ManifestAuth,
  type ManifestSigning,
  type MediaPort,
  type Port,
} from './manifest.ts';
export {
  isCompatibleKcsVersion,
  parseScenario,
  ScenarioError,
  STEP_KINDS,
  type AssertStep,
  type EmitStep,
  type EntityDescriptor,
  type Expectation,
  type FetchStep,
  type InvokeStep,
  type Participant,
  type PortValue,
  type ResolveStep,
  type ScenarioDocument,
  type Standin,
  type Step,
  type StepBase,
  type StepKind,
  type SubscribeStep,
} from './scenario.ts';
