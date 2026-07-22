/**
 * Shared protocol types for the agora commons.
 *
 * These mirror the ratified koine specs — see `../../koine/specs/`. The specs are
 * authoritative; anything here that disagrees with them is a bug in this file.
 *
 * - `versions.ts` — the spec versions this build implements (cross-pinned to Python)
 * - `planes.ts`   — the three protocol planes (KCB §2.1)
 * - `identity.ts` — KINP compact identifiers (KINP §3.2)
 * - `manifest.ts` — the KCB capability manifest (KCB §2), what the registry indexes
 */
export { SPEC_VERSIONS } from './versions.ts';
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
