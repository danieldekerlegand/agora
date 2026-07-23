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
 * - `agent-card.ts` — the A2A AgentCard + KCB manifest extension (KCB §2), the served document
 * - `manifest.ts` — the KCB capability manifest (KCB §2), narrowed out of the card extension
 * - `scenario.ts` — the KCS conformance-scenario document (KCS §2/§3), what the console runs
 * - `relation-registry.ts` — where the shared relation registry lives (koine) and which
 *   `registryVersion` this build speaks
 * - `axes.ts`     — dialect (KGP §5) / egress (§7.2) / trust, and the egress enforcement
 * - `registry-schema.ts` — the registry's own schema and validator, over both its artifacts
 * - `validator.ts` — the ajv validator over the ported koine interchange schemas (legacy-absorbed)
 * - `validate.ts`  — the CLI over `validator.ts` (exit 0/1/2), twin of the Python validator's CLI
 *
 * `./fixtures` is a second entry point, carrying a snapshot of the real koine registry for
 * tests. It is deliberately not re-exported here: it is test data, not a library surface.
 */
export { SPEC_VERSIONS } from './versions.ts';
export { RELATION_REGISTRY, type RegistryMirror } from './relation-registry.ts';
export {
  assertRelationsResolve,
  assertSignatureStability,
  CANONICAL_KINDS,
  CLAIM_KINDS,
  crossesAsClaim,
  diffSignatures,
  isCanonicalKind,
  isCompatibleRegistryVersion,
  isRegistryDocument,
  parseRegistry,
  parseVocabulary,
  predicateNames,
  RegistryError,
  relationSignature,
  VOCABULARY_COLUMNS,
  type CanonicalKind,
  type MappingEntry,
  type ProjectMappings,
  type RegistryDocument,
  type RegistrySnapshot,
  type RelationRow,
  type SignatureChange,
  type VocabularyFile,
  type VocabularyIndex,
} from './registry-schema.ts';
export {
  assertPackEgress,
  DEFAULT_DIALECT,
  DEFAULT_EGRESS,
  DIALECT_TIERS,
  dialectAdmits,
  EGRESS_CLASSES,
  EgressError,
  egressOf,
  filterForEgress,
  filterPackForEgress,
  inspectPackEgress,
  isDialectTier,
  isEgressClass,
  isExportable,
  isTrustTier,
  PACK_SECTIONS,
  TRUST_TIERS,
  type DialectTier,
  type EgressBearing,
  type EgressClass,
  type EgressFilter,
  type EgressReport,
  type EgressViolation,
  type PackLike,
  type PackSection,
  type RelationEgress,
  type TrustTier,
  type Withheld,
} from './axes.ts';
export { ARTIFACT_SCHEMAS, validate, type ArtifactName } from './validator.ts';
export { canonicalJson, isJsonObject, type Json, type JsonObject } from './json.ts';
export { isPlane, PLANES, type Plane } from './planes.ts';
export {
  isKinpId,
  isWorldId,
  kindOf,
  KINP_KINDS,
  parseKinpId,
  worldOf,
  type KinpId,
  type KinpKind,
} from './identity.ts';
export {
  KCB_MANIFEST_EXTENSION_URI,
  type AgentCapabilities,
  type AgentCard,
  type AgentExtension,
} from './agent-card.ts';
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
