/**
 * `@agora/grants` — the KCB §5 capability-grant issuer.
 *
 * koine fixes the *shape* of a grant and says issuance lives in "the control-plane host's
 * infra"; agora's job is to make that infra something a host can run rather than write. The
 * relying parties already exist in this tree — the router refuses what a grant does not cover,
 * the trainer refuses a run over its ceiling — and both accept a presented grant at face value.
 * This is the other end of that: mint it, sign it, and refuse at mint time anything they would
 * refuse at the door.
 *
 * Capability, never caller: the issuer knows verbs, scopes and ceilings, and nothing about who
 * is asking. The grantee is whatever principal the host names.
 *
 * - `grant.ts`  — the §5 grant shape and the relying parties' rules, mirrored
 * - `issuer.ts` — minting, the `{key_id, alg}` signature, and the public material
 * - `server.ts` — the HTTP surface (`POST /grants`, `GET /keys`, `GET /describe`)
 * - `main.ts`   — the standalone entry point, configured from `AGORA_GRANTS_*`
 */
export {
  admits,
  CEILING_KEY,
  GRANT_VERBS,
  GrantError,
  grantToken,
  isGrantVerb,
  parseCeiling,
  parseGrant,
  parseGrantToken,
  permits,
  requiredScope,
  scopeCovers,
  SUBTREE_SUFFIX,
  WILDCARD_SCOPE,
  type Grant,
  type GrantVerb,
} from './grant.ts';
export {
  canonicalGrantBytes,
  createGrantIssuer,
  createSigningKey,
  GRANT_ISSUER_IDENTITY,
  GRANT_SIGNING_ALG,
  parseGrantRequest,
  publicKeyFrom,
  publicMaterial,
  signingKeyFrom,
  verifyGrantSignature,
  type GrantIssuer,
  type GrantIssuerOptions,
  type GrantRequest,
  type GrantSignature,
  type IssuedGrant,
  type PublicKeyMaterial,
  type SigningKey,
} from './issuer.ts';
export {
  createGrantServer,
  describeGrantIssuer,
  type GrantService,
  type IssuerDescription,
  type ServiceAddress,
} from './server.ts';
