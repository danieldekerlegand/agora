/**
 * The KINP resolver reference implementation (`koine/specs/identity.md` §8).
 *
 * Resolves identifiers and reconciles duplicate entity references, backed by Pinakes as
 * the authoritative store for real-world entities. Like the registry it is a *lookup*
 * service (ADR-0001 decision 3) — it returns identity, never relayed payloads.
 *
 * **US-AG4 defines the interface, not the implementation.** The real thing is backlogged
 * to grounding-pinakes / capability-registry; what lives here is the seam the console
 * depends on, plus {@link createLocalResolver}, which answers exactly the questions that
 * need no authority — an id that is already a well-formed KINP id resolves to itself —
 * and refuses everything else loudly rather than guessing. A resolver that quietly
 * invented ids would seed the fabric with entities nothing else can join against, which
 * is the precise failure KINP §4 exists to prevent.
 */
import { parseKinpId, SPEC_VERSIONS, type KinpKind } from '@agora/schemas';

/** KINP identity of the resolver service itself. */
export const RESOLVER_IDENTITY = 'agora:agent:resolver';

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

/** Where an identity came from. `local` needs no authority; `pinakes` is the authority. */
export type ResolutionAuthority = 'local' | 'pinakes';

export interface ResolvedIdentity {
  id: string;
  kind: KinpKind;
  authority: ResolutionAuthority;
  /** 1 when the reference *was* the identity; below 1 once matching is involved. */
  confidence: number;
}

/** The outcome of reconciling several references (identity.md §4: `same_as` / review). */
export interface Reconciliation {
  /** The surviving identity. */
  id: string;
  /** Ids folded into it. */
  sameAs: string[];
  /** True when the merge needs human review rather than auto-applying (KINP §11). */
  review: boolean;
}

/**
 * The seam the console depends on. Deliberately two verbs — `resolve` and `reconcile` are
 * what identity.md §8 names; anything else belongs to the graph API, not here.
 */
export interface Resolver {
  resolve(ref: EntityRef): Promise<ResolvedIdentity>;
  reconcile(refs: EntityRef[]): Promise<Reconciliation>;
}

/** Thrown when answering would require the authority this stub does not have. */
export class ResolverUnavailableError extends Error {
  constructor(message: string) {
    super(`${message} — the full resolver is backlogged (grounding-pinakes)`);
    this.name = 'ResolverUnavailableError';
  }
}

/**
 * A resolver with no backing store: it recognises ids, and refuses to invent them.
 *
 * Enough for the conformance console to resolve the provider ids the registry hands it;
 * not enough to resolve a name, which is exactly where Pinakes' authority begins.
 */
export function createLocalResolver(): Resolver {
  return {
    resolve(ref: EntityRef): Promise<ResolvedIdentity> {
      const id = ref.id;
      const parsed = id === undefined ? undefined : parseKinpId(id);
      if (id === undefined || parsed === undefined) {
        return Promise.reject(
          new ResolverUnavailableError(`cannot resolve ${describe(ref)} without a minting authority`),
        );
      }
      return Promise.resolve({ id, kind: parsed.kind, authority: 'local', confidence: 1 });
    },
    reconcile(refs: EntityRef[]): Promise<Reconciliation> {
      return Promise.reject(
        new ResolverUnavailableError(
          `cannot reconcile ${refs.length} reference(s): equivalence is Pinakes' to assert`,
        ),
      );
    },
  };
}

export interface ResolverDescription {
  identity: string;
  kinpVersion: string;
  /** False until the real resolver lands — the console should not mistake the stub. */
  implemented: boolean;
  verbs: readonly string[];
}

export function describeResolver(): ResolverDescription {
  return {
    identity: RESOLVER_IDENTITY,
    kinpVersion: SPEC_VERSIONS.kinp,
    implemented: false,
    verbs: ['resolve', 'reconcile'],
  };
}

function describe(ref: EntityRef): string {
  return JSON.stringify(ref.id ?? ref.name ?? ref);
}
