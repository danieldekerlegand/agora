/**
 * The two normative decisions a reconciler makes, kept pure and away from the wire.
 *
 * 1. **Which relation** — `same_as` or `based_on` (identity.md §4.5, delta C). This is the
 *    firewall: `same_as` licenses fact transfer, `based_on` does not, so choosing wrong is
 *    how "fought a dragon" ends up on the real Napoleon.
 * 2. **Apply or queue** — the hybrid merge policy (§11 decision 2). Auto-apply above a
 *    per-world confidence threshold; route high-impact or below-threshold links to a review
 *    queue.
 *
 * Both are functions of the candidates and the policy alone — no I/O, no clock — because
 * "why did the resolver link these?" has to be answerable from the record afterwards.
 */
import { worldOf } from '@agora/schemas';

import { CONSENSUS_REALITY, type LinkProposal, type ReconciliationCandidate } from './types.ts';

export interface MergePolicy {
  /** Auto-apply at or above this confidence; below it, queue for review. */
  threshold: number;
  /** Per-world overrides — §11 decision 2: "the threshold is configurable per world". */
  perWorld: Readonly<Record<string, number>>;
  /**
   * Worlds whose entities inherit identity from the world a reference was observed in
   * (§4.5). Inheritance policy is per-world metadata (§5), so it is configured, not guessed
   * — except for playthrough forks, which inherit by construction (see {@link inheritsIdentity}).
   */
  identityInheriting: readonly string[];
  /**
   * How far the top candidate must beat the runner-up to count as unambiguous. Two
   * near-tied candidates are the "ambiguous" case §4.5 sends to review rather than guessing
   * between — a coin flip here is a wrong `same_as` half the time.
   */
  ambiguityMargin: number;
  /** The world an id that is not named into one is read in (§5). */
  defaultWorld: string;
}

export const DEFAULT_MERGE_POLICY: MergePolicy = {
  threshold: 0.9,
  perWorld: {},
  identityInheriting: [],
  ambiguityMargin: 0.05,
  defaultWorld: CONSENSUS_REALITY,
};

export function mergePolicy(overrides: Partial<MergePolicy> = {}): MergePolicy {
  return { ...DEFAULT_MERGE_POLICY, ...overrides };
}

/** The confidence a link must clear in this world before it is applied unreviewed. */
export function thresholdFor(world: string, policy: MergePolicy): number {
  return policy.perWorld[world] ?? policy.threshold;
}

/** The world an id is read in: the one it is named into (§5), else the policy default. */
export function worldFor(id: string | undefined, policy: MergePolicy): string {
  if (id === undefined) return policy.defaultWorld;
  return worldOf(id) ?? policy.defaultWorld;
}

/**
 * Does an identifier in `candidate`'s world denote the same referent as one in `observed`?
 *
 * True in three cases: the same world; a playthrough fork of it (§5 — a save file *forks*
 * the canon, so its entities are the canon's entities until overridden, which is inheritance
 * by construction rather than by configuration); or a world the operator has declared
 * identity-inheriting.
 */
export function inheritsIdentity(observed: string, candidate: string, policy: MergePolicy): boolean {
  if (observed === candidate) return true;
  if (isForkOf(observed, candidate)) return true;
  return policy.identityInheriting.includes(candidate);
}

/** `insimul:world:alderforest#save-7f` and `insimul:world:alderforest` — same canon (§5). */
export function isForkOf(a: string, b: string): boolean {
  return a !== b && baseWorld(a) === baseWorld(b);
}

function baseWorld(world: string): string {
  const [base] = world.split('#');
  return base as string;
}

export interface LinkDecision {
  /** The world the reference was observed in (§5). */
  world: string;
  candidates: readonly ReconciliationCandidate[];
  /** The provisional local being reconciled (§6), when the caller minted one. */
  subject?: string | undefined;
  /**
   * Candidates already reachable from the subject *only* through `based_on` edges. §4.5:
   * such a candidate "is never promoted to `same_as` by transitivity" — the fiction that
   * was modeled on Napoleon does not become Napoleon because a matcher likes the name.
   */
  lineageOnly?: readonly string[];
  policy: MergePolicy;
}

/**
 * Pick a relation and decide whether to apply it — the whole of §4.5 plus §11 decision 2.
 *
 * The order matters. Ambiguity is checked before anything else, because "which candidate"
 * is upstream of "which relation": a resolver that picks a relation for the wrong entity
 * has produced a confident, well-reasoned, wrong link.
 */
export function decideLink(input: LinkDecision): LinkProposal {
  const { candidates, policy, subject, world } = input;
  const [top, runnerUp] = candidates;
  if (top === undefined) {
    return { relation: null, subject, confidence: 0, review: false, why: 'no candidate matched' };
  }
  if (runnerUp !== undefined && top.confidence - runnerUp.confidence < policy.ambiguityMargin) {
    return {
      relation: null,
      subject,
      confidence: top.confidence,
      review: true,
      why:
        `ambiguous: ${top.id} and ${runnerUp.id} are within ${policy.ambiguityMargin} ` +
        `(${top.confidence} vs ${runnerUp.confidence}) — queued rather than guessed (§4.5)`,
    };
  }

  const lineageOnly = input.lineageOnly ?? [];
  const inherits = inheritsIdentity(world, top.world, policy);
  const crossesWorlds = top.world !== world;
  let relation: 'same_as' | 'based_on' = inherits ? 'same_as' : 'based_on';
  let why = inherits
    ? `${top.world} inherits identity from ${world} (§4.5)`
    : `${top.world} does not inherit identity from ${world} — lineage only (§4.5)`;
  if (relation === 'same_as' && lineageOnly.includes(top.id)) {
    relation = 'based_on';
    why = `${top.id} is reachable only through an existing based_on chain — never promoted by transitivity (§4.5)`;
  }

  const threshold = thresholdFor(world, policy);
  const proposal: LinkProposal = {
    relation,
    subject,
    object: top.id,
    confidence: top.confidence,
    review: false,
    why,
  };
  if (top.confidence < threshold) {
    return { ...proposal, review: true, why: `${why}; below the ${threshold} threshold for ${world}` };
  }
  // High-impact (§11 decision 2): a `same_as` that crosses a world boundary licenses facts
  // to flow between two worlds on the strength of configured inheritance metadata. A fork
  // inherits by construction and needs no such trust, so it is not high-impact.
  if (relation === 'same_as' && crossesWorlds && !isForkOf(world, top.world)) {
    return {
      ...proposal,
      review: true,
      why: `${why}; a same_as from ${world} into ${top.world} transfers facts across worlds — high-impact (§11 decision 2)`,
    };
  }
  return proposal;
}
