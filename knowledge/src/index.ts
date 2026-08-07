/**
 * `@agora/knowledge` — the generic KGP knowledge-sync bridge.
 *
 * The data-plane half of "apps are thin producers, the commons bridges the planes": any
 * participant that can name its facts in the shared relation vocabulary submits them here, and
 * they arrive at a KGP consumer as a gated, content-addressed pack. What makes it *generic* is
 * what it does not contain — no mapping from anybody's local predicates onto the vocabulary
 * (that is the producer's own thin adapter, ADR-0008), no producer allowlist, and no name of any
 * particular knowledge authority. A producer is whoever submits; a consumer is whoever published
 * a KCB manifest with a knowledge-plane input port.
 *
 * - `claim.ts`     — the claim envelope and KGP §3's byte discipline (ADR-0006)
 * - `license.ts`   — the §7.1 license classes and the admission allowlist
 * - `admission.ts` — the gate: registry, §5 dialect, §7 filters, §7.1 license, §7.2 egress
 * - `pack.ts`      — the §2 GroundingPack and its §2.1 content address
 * - `consumer.ts`  — a consumer discovered from its KCB manifest and dialed directly
 * - `sync.ts`      — the bridge itself: submit → admit → pack → deliver → receipt
 * - `server.ts`    — the HTTP surface (`POST /claims`), and `describeKnowledgeSync()`
 * - `main.ts`      — the standalone entry point, configured from `AGORA_KNOWLEDGE_*`
 */
export {
  assertionId,
  canonicalArgument,
  canonicalClaim,
  canonicalDecimal,
  canonicalIdentifier,
  canonicalLiteral,
  claimId,
  ClaimError,
  hashClaimInput,
  isClaimLiteral,
  type Claim,
  type ClaimArgument,
  type ClaimLiteral,
  type ClaimProvenance,
} from './claim.ts';
export {
  admitsLicense,
  classifyLicense,
  DEFAULT_LICENSE_ALLOWLIST,
  isLicenseClass,
  LICENSE_CLASSES,
  type LicenseClass,
  type LicenseClassifier,
} from './license.ts';
export {
  admitClaims,
  isLinkRelation,
  LINK_RELATIONS,
  REJECTION_CODES,
  type Admission,
  type AdmissionOptions,
  type AdmissionPolicy,
  type AdmittedClaim,
  type Rejection,
  type RejectionCode,
  type RelationLookup,
} from './admission.ts';
export {
  buildPack,
  dialectOf,
  packId,
  PackError,
  type GroundingPack,
  type PackAssertion,
  type PackManifest,
  type PackOptions,
  type PackProvenance,
} from './pack.ts';
export {
  consumerFromManifest,
  ConsumerError,
  httpConsumer,
  knowledgeSink,
  type DeliverFetch,
  type DeliveryReceipt,
  type HttpConsumerOptions,
  type KgpConsumer,
  type ManifestConsumerOptions,
} from './consumer.ts';
export {
  createKnowledgeSync,
  parseSubmission,
  SyncError,
  type ClaimSubmission,
  type KnowledgeSync,
  type KnowledgeSyncOptions,
  type SyncReceipt,
} from './sync.ts';
export {
  createSyncServer,
  describeKnowledgeSync,
  KNOWLEDGE_SYNC_IDENTITY,
  type ServiceAddress,
  type SyncDescription,
  type SyncServerOptions,
  type SyncService,
} from './server.ts';
export {
  DEFAULT_KNOWLEDGE_HOST,
  DEFAULT_KNOWLEDGE_PORT,
  knowledgeLaunchFromEnv,
  startKnowledgeSync,
  type KnowledgeEnv,
  type KnowledgeLaunch,
  type StartedKnowledgeSync,
} from './main.ts';
