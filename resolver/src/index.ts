/**
 * The KINP resolver reference implementation (`koine/specs/identity.md` §8).
 *
 * Resolves identifiers and reconciles duplicate entity references, backed by Pinakes as the
 * authoritative store for real-world entities (§11 decision 1). Like the registry it is a
 * *lookup* service (ADR-0001 decision 3) — it returns identity, never relayed payloads.
 *
 * Two implementations, one seam:
 *
 * - {@link createPinakesResolver} — dials the authority, computes the `same_as` closure
 *   without ever crossing a `based_on` edge (§4.3), matches descriptors in the
 *   OpenRefine/Wikidata shape (§4.5), applies the hybrid merge policy (§11 decision 2), and
 *   falls back to a local cache when the authority is unreachable (§8).
 * - {@link createLocalResolver} — answers only the questions that need no authority: an id
 *   that is already a well-formed KINP id resolves to itself. It refuses everything else
 *   loudly rather than guessing, because a resolver that quietly invented ids would seed the
 *   fabric with entities nothing else can join against — the precise failure §4 prevents.
 *
 * The console defaults to the local one and takes the Pinakes one when it is given an
 * authority address, so a run with no Pinakes in it is degraded, not broken.
 */
import { kindOf, worldOf, SPEC_VERSIONS } from '@agora/schemas';

import {
  ResolverUnavailableError,
  type EntityRef,
  type ReconciliationQuery,
  type ReconciliationResult,
  type Resolver,
  type ResolvedIdentity,
  RESOLVER_IDENTITY,
} from './types.ts';

export {
  AuthorityUnreachableError,
  CONSENSUS_REALITY,
  RESOLVER_IDENTITY,
  ResolverUnavailableError,
  type AuthorityResolver,
  type EntityRef,
  type LinkProposal,
  type LinkRelation,
  type ProvenanceRef,
  type ReconciliationCandidate,
  type ReconciliationProperty,
  type ReconciliationQuery,
  type ReconciliationResult,
  type ResolutionAuthority,
  type ResolvedIdentity,
  type Resolver,
} from './types.ts';
export {
  DEFAULT_MERGE_POLICY,
  decideLink,
  inheritsIdentity,
  isForkOf,
  mergePolicy,
  thresholdFor,
  worldFor,
  type LinkDecision,
  type MergePolicy,
} from './policy.ts';
export { createMemoryCache, type ResolverCache } from './cache.ts';
export {
  createFileCache,
  createFileLinkStore,
  createMemoryLinkStore,
  type LinkStore,
} from './persistence.ts';
export {
  createResolverServer,
  type ResolverService,
  type ResolverServerOptions,
  type ServiceAddress,
} from './server.ts';
export {
  closureOver,
  createPinakesResolver,
  PINAKES_IDENTITY,
  readCandidates,
  readResolution,
  type AuthorityFetch,
  type AuthorityRequestInit,
  type AuthorityResponse,
  type PinakesOptions,
} from './pinakes.ts';

/**
 * A resolver with no backing store: it recognises ids, and refuses to invent them.
 *
 * Enough for the conformance console to resolve the provider ids the registry hands it; not
 * enough to resolve a name or to assert an equivalence, which is exactly where the
 * authority's job begins.
 */
export function createLocalResolver(): Resolver {
  return {
    resolve(ref: EntityRef): Promise<ResolvedIdentity> {
      const id = ref.id;
      const kind = id === undefined ? undefined : kindOf(id);
      if (id === undefined || kind === undefined) {
        return Promise.reject(
          new ResolverUnavailableError(
            `cannot resolve ${describe(ref)} without a minting authority`,
          ),
        );
      }
      const resolved: ResolvedIdentity = {
        id,
        kind,
        authority: 'local',
        confidence: 1,
        sameAs: [],
        basedOn: [],
        provenance: [],
        attachedAssets: [],
      };
      const world = ref.world ?? worldOf(id);
      if (world !== undefined) resolved.world = world;
      return Promise.resolve(resolved);
    },
    reconcile(query: ReconciliationQuery): Promise<ReconciliationResult> {
      return Promise.reject(
        new ResolverUnavailableError(
          `cannot reconcile ${JSON.stringify(query.query)}: equivalence is the authority's to assert`,
        ),
      );
    },
  };
}

export interface ResolverDescription {
  identity: string;
  kinpVersion: string;
  /** True once a resolver that dials the authority exists — it does (US-CS4). */
  implemented: boolean;
  verbs: readonly string[];
}

export function describeResolver(): ResolverDescription {
  return {
    identity: RESOLVER_IDENTITY,
    kinpVersion: SPEC_VERSIONS.kinp,
    implemented: true,
    verbs: ['resolve', 'reconcile'],
  };
}

function describe(ref: EntityRef): string {
  return JSON.stringify(ref.id ?? ref.name ?? ref);
}
