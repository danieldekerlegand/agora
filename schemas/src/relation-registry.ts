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
 *   predicates cross into the canonical node/edge vocabulary. It coins no relation names: a
 *   mapping that crosses as a claim names the vocabulary relation it normalizes to.
 *
 * **Which projects those two artifacts cover is the registry's own data, never this build's.**
 * A loaded document declares its cast — the canonical host it names in `canonicalProject`, the
 * bridged projects its `projects` block carries — and `registry-schema.ts` validates that the
 * declaration is well-formed and self-consistent, not that it matches a set pinned here. That
 * is the difference between a commons any conformant deployment can load its registry into and
 * one that speaks a single ecosystem's registry.
 *
 * A relation's signature is immutable once published — changing arity, argument order or
 * symmetry silently changes every dependent claim id (KGP §3), so a change means a new
 * relation name. The validator enforces that across `version`s.
 *
 * What a registry entry's classifications *mean* — the dialect / egress / trust axes, and the
 * §7.2 enforcement that hangs off `egress` — is `axes.ts`.
 */

/**
 * The registry contract this build implements. `version` is the `registryVersion` of
 * `koine/registry/predicate-mapping.json`; the loader refuses a registry it does not speak.
 */
export const RELATION_REGISTRY = {
  /**
   * `registryVersion` of the canonical registry (koine). 0.3.0 split the old
   * `portabilityClasses` key into the two axes `axes.ts` models — a registry at 0.2.0 still
   * says `portability: [...]` and cannot be read by this build. 0.4.0 added a second bridged
   * project's mappings (additive: no existing entry changed, no signature moved). 0.4.1/0.4.2
   * are further additive bridge-mapping changes only — 0.4.1 added a set of `_name/2` seed
   * predicates and 0.4.2 landed the rest of that second bridge (its `pending` flags flipped to
   * false, the pending-schema lists emptied). No bridged project was added and no relation
   * signature moved, so the vocabulary is unchanged.
   */
  version: '0.4.2',
  /** The repo that holds the authoritative copy. There is exactly one. */
  repo: 'koine',
  /** The relation vocabulary: the shared core plus namespaced domain extensions. */
  vocabulary: {
    core: 'registry/relations.tsv',
    domains: 'registry/relations',
  },
  /** The bridge layer: bridged-project predicates ⇄ the canonical vocabulary. */
  mappings: 'registry/predicate-mapping.json',
} as const;
