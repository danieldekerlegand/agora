/**
 * Where the shared relation registry lives, and which version of it this build speaks.
 *
 * The registry is **data**, and data lives in koine (`koine/registry/`); the schema, validator
 * and loader consumers call are agora's (ADR-0001 — koine specifies, agora implements). That
 * split is why this file holds a *pointer and a version*, not a copy: a vendored copy would be
 * the second source of truth the registry exists to prevent.
 *
 * Two artifacts, one vocabulary:
 *
 * - the **vocabulary** (`relations.tsv` + `relations/<domain>.tsv`) — every relation name that
 *   may appear in a claim, with the arity/arg-order/symmetry that make claim normalization
 *   deterministic across producers (KGP §3.2 rule 1);
 * - the **bridge mappings** (`predicate-mapping.json`) — how each bridged project's own
 *   predicates cross into the canonical node/edge vocabulary. Lifted verbatim out of pinakes
 *   (merged `17f0713`) per the ADR-0002 amendment. It coins no relation names: a mapping that
 *   crosses as a claim names the vocabulary relation it normalizes to.
 *
 * A relation's signature is immutable once published — changing arity, argument order or
 * symmetry silently changes every dependent claim id (KGP §3), so a change means a new
 * relation name. The validator enforces that across `version`s.
 */

/** A copy of the registry that is generated from the canonical one, never authored. */
export interface RegistryMirror {
  /** The project holding the mirror (a KINP namespace). */
  readonly project: string;
  /** Its path within that project's repo. */
  readonly path: string;
  /** How it is kept honest: regenerated from koine, with a drift gate comparing the two. */
  readonly mode: 'generated-mirror';
}

/**
 * The registry contract this build implements. `version` is the `registryVersion` of
 * `koine/registry/predicate-mapping.json`; the loader refuses a registry it does not speak.
 */
export const RELATION_REGISTRY = {
  /** `registryVersion` of the canonical registry (koine). */
  version: '0.2.0',
  /** The repo that holds the authoritative copy. There is exactly one. */
  repo: 'koine',
  /** The relation vocabulary: the shared core plus namespaced domain extensions. */
  vocabulary: {
    core: 'registry/relations.tsv',
    domains: 'registry/relations',
  },
  /** The bridge layer: bridged-project predicates ⇄ the canonical vocabulary. */
  mappings: 'registry/predicate-mapping.json',
  /** Declared mirrors. Regenerated from koine — a hand edit here is how a registry forks. */
  mirrors: [
    { project: 'pinakes', path: 'shared/predicate-mapping.json', mode: 'generated-mirror' },
  ] as readonly RegistryMirror[],
} as const;
