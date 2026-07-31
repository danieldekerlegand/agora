/**
 * The KINP resolver's surface — `koine/specs/identity.md` §8.
 *
 * Two verbs, because §8 names two the console needs: `resolve` dereferences an identifier
 * into the *merged view* (computed here, never stored — §4.1), and `reconcile` fuzzy-matches
 * a descriptor to candidates in the OpenRefine/Wikidata shape (§4.5). `mint` is local by
 * construction (§6) and `link`/`query` belong to the graph API, not to identity.
 *
 * Everything here is ids and edges. The resolver never carries payloads: like the registry
 * it answers *who is who*, and the caller dials whoever that turns out to be (ADR-0001
 * decision 3).
 */
import type { KinpKind } from '@agora/schemas';

/** KINP identity of the resolver service itself. */
export const RESOLVER_IDENTITY = 'agora:agent:resolver';

/**
 * The canonical world for real-world knowledge (identity.md §5) — "the identity authority's
 * `…:world:consensus-reality`".
 *
 * The namespace is the *deployment's* authority, so this constant is only the default a
 * merge policy starts from: an operator whose authority is not `refkb` sets
 * {@link MergePolicy.defaultWorld} and nothing here has an opinion. `refkb` is the namespace
 * koine's own §5 examples use for a reference knowledge base, which is what keeps the
 * out-of-the-box default readable rather than naming somebody's project.
 */
export const CONSENSUS_REALITY = 'refkb:world:consensus-reality';

/** What a caller knows about a thing it wants an identity for (identity.md §4). */
export interface EntityRef {
  /** A compact KINP id, when the caller already has one. */
  id?: string;
  /** The KINP kind, when the caller knows it but not the id. */
  kind?: KinpKind;
  /** A human name / local key in the caller's own namespace. */
  name?: string;
  /** The world the reference was observed in (identity.md §5). */
  world?: string;
}

/**
 * Where an identity came from — a ROLE, never a vendor: which service plays the authority is
 * configuration ({@link AuthorityOptions.endpoint}), so it is not encodable in a type.
 *
 * `local` needs no authority — a content-addressed id (§6) or a well-formed id nobody has
 * anything to add about. `authority` is the configured authority answering live (§11
 * decision 1). `cache` is a previous authority answer replayed offline, and it is a distinct
 * value on purpose: a caller deciding whether to write back must be able to tell "the
 * authority says so" from "the authority said so, once".
 */
export type ResolutionAuthority = 'local' | 'authority' | 'cache';

/** One PROV-shaped provenance record as the authority stated it (§7.1). */
export interface ProvenanceRef {
  agent?: string;
  activity?: string;
  asserted?: string;
}

/**
 * A dereferenced identifier — §8's `{ entity, same_as_closure[], based_on[], provenance[],
 * attached_assets[] }`.
 *
 * The firewall (§4.3) is the whole reason the two link sets are separate fields rather than
 * one `related[]`: facts flow across {@link sameAs} and do **not** flow across
 * {@link basedOn}. A consumer that merges them has reimplemented the contamination this
 * spec exists to prevent.
 */
export interface ResolvedIdentity {
  id: string;
  kind: KinpKind;
  authority: ResolutionAuthority;
  /** 1 when the reference *was* the identity; below 1 once matching is involved. */
  confidence: number;
  /** The world the id is named into (§5), when it is named into one. */
  world?: string | undefined;
  /** Ids denoting the same referent, transitively closed over `same_as` only. */
  sameAs: string[];
  /** Ids this entity was modeled on — lineage, never inference (§4.3). */
  basedOn: string[];
  provenance: ProvenanceRef[];
  /** KMI assets attached to the entity (§7.2), by id. */
  attachedAssets: string[];
}

/** One `properties` entry of an OpenRefine reconciliation query. */
export interface ReconciliationProperty {
  pid: string;
  v: string | number | boolean;
}

/**
 * A descriptor to fuzzy-match — the OpenRefine/Wikidata Reconciliation API query (§4.5).
 *
 * `query`/`type`/`limit`/`properties` are that standard's fields verbatim, so an authority
 * with a Wikidata backbone answers it directly. `world` and `of` are the KINP additions the
 * firewall needs: which world the reference was *observed* in, and which provisional local
 * (§6) is being reconciled — without those two, §4.5 cannot pick `same_as` over `based_on`.
 */
export interface ReconciliationQuery {
  query: string;
  type?: string;
  limit?: number;
  properties?: ReconciliationProperty[];
  /** The world the reference was observed in (§5). Defaults to consensus reality. */
  world?: string;
  /** The provisional local this descriptor stands for, when the caller minted one (§6). */
  of?: string;
}

/** One ranked candidate — the OpenRefine `result` entry, plus its world. */
export interface ReconciliationCandidate {
  id: string;
  name?: string | undefined;
  /** The authority's own score, whatever scale it uses. */
  score: number;
  /** Normalised to 0..1, which is the scale KINP confidence is on (§7.1). */
  confidence: number;
  /** The authority's automatic-match flag. Advisory: §11 decision 2 is ours to apply. */
  match: boolean;
  types: string[];
  /** The world the candidate lives in, defaulted to consensus reality for authority ids. */
  world: string;
}

/** The equivalence-layer relations a reconciliation may propose (§4.2). */
export type LinkRelation = 'same_as' | 'based_on';

/**
 * What the resolver decided to do about a match — §4.5 chooses the relation, §11 decision 2
 * chooses whether it is applied or queued.
 *
 * `relation: null` is a deliberate refusal, not an absence: the resolver could not tell
 * which candidate is meant, and inventing a link is the failure mode the whole equivalence
 * layer exists to avoid.
 */
export interface LinkProposal {
  relation: LinkRelation | null;
  /** The local being reconciled, when the query named one. */
  subject?: string | undefined;
  /** The candidate the relation points at, absent when the resolver refused to pick one. */
  object?: string | undefined;
  confidence: number;
  /** True when this is QUEUED for human review rather than applied (§11 decision 2). */
  review: boolean;
  /** Why this relation, in one line — what a reviewer reads before approving. */
  why: string;
}

/** `reconcile`'s answer: the ranked candidates, and what was decided about the top one. */
export interface ReconciliationResult {
  candidates: ReconciliationCandidate[];
  proposal: LinkProposal;
  authority: ResolutionAuthority;
}

/**
 * The seam the console depends on. Deliberately two verbs — `resolve` and `reconcile` are
 * what identity.md §8 names; anything else belongs to the graph API, not here.
 */
export interface Resolver {
  resolve(ref: EntityRef): Promise<ResolvedIdentity>;
  reconcile(query: ReconciliationQuery): Promise<ReconciliationResult>;
}

/**
 * A resolver backed by a canonical authority, which therefore has a review queue.
 *
 * The hybrid merge policy (§11 decision 2) is only meaningful if the queued half goes
 * *somewhere*: a resolver that silently dropped below-threshold matches would be
 * always-auto with extra steps.
 */
export interface AuthorityResolver extends Resolver {
  /** Links awaiting the convergence-QA gate. Nothing here has been asserted. */
  readonly reviewQueue: readonly LinkProposal[];
  /** Links auto-applied above the threshold, in decision order. */
  readonly applied: readonly LinkProposal[];
}

/** Thrown when answering would require an authority this resolver does not have. */
export class ResolverUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolverUnavailableError';
  }
}

/**
 * The authority was dialed and could not answer, and nothing was cached.
 *
 * A subclass so `catch (ResolverUnavailableError)` still covers offline; a distinct class
 * because "I have no authority" and "the authority is down" call for different responses —
 * the second is retryable, and per §6 the caller may proceed on its provisional local.
 */
export class AuthorityUnreachableError extends ResolverUnavailableError {
  constructor(
    readonly authorityIdentity: string,
    readonly reason: string,
  ) {
    super(`${authorityIdentity} could not be reached (${reason}) and nothing was cached`);
    this.name = 'AuthorityUnreachableError';
  }
}
