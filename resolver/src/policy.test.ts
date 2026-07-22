import { describe, expect, it } from 'vitest';

import { decideLink, inheritsIdentity, mergePolicy, thresholdFor } from './index.ts';
import type { ReconciliationCandidate } from './index.ts';

const ALDERFOREST = 'insimul:world:alderforest';
const REALITY = 'pinakes:world:consensus-reality';

function candidate(
  id: string,
  confidence: number,
  world: string,
  name?: string,
): ReconciliationCandidate {
  return {
    id,
    score: confidence * 100,
    confidence,
    match: false,
    types: [],
    world,
    ...(name === undefined ? {} : { name }),
  };
}

describe('same_as vs based_on (identity.md §4.5)', () => {
  const policy = mergePolicy();

  it('links across worlds as based_on — lineage only, no fact transfer', () => {
    // The worked case from §4.3: a fiction modeled on the real Napoleon. `same_as` here is
    // what would make "fought a dragon" a fact about the real figure.
    const proposal = decideLink({
      world: ALDERFOREST,
      subject: 'analyzer:ent:e-8842',
      candidates: [candidate('pinakes:ent:napoleon-i', 0.95, REALITY, 'Napoleon I')],
      policy,
    });
    expect(proposal.relation).toBe('based_on');
    expect(proposal.object).toBe('pinakes:ent:napoleon-i');
    expect(proposal.why).toMatch(/does not inherit identity/);
  });

  it('links within one world as same_as, and applies it above the threshold', () => {
    const proposal = decideLink({
      world: ALDERFOREST,
      subject: 'analyzer:ent:e-8842',
      candidates: [candidate(`${ALDERFOREST}:ent:npc-renaud`, 0.96, ALDERFOREST)],
      policy,
    });
    expect(proposal).toMatchObject({ relation: 'same_as', review: false });
  });

  it('treats a playthrough fork as identity-inheriting by construction (§5)', () => {
    const fork = `${ALDERFOREST}#save-7f`;
    expect(inheritsIdentity(fork, ALDERFOREST, policy)).toBe(true);
    const proposal = decideLink({
      world: fork,
      candidates: [candidate(`${ALDERFOREST}:ent:npc-renaud`, 0.99, ALDERFOREST)],
      policy,
    });
    // A save file forks the canon, so its entities are the canon's entities — and that
    // needs no operator to vouch for it, hence not high-impact.
    expect(proposal).toMatchObject({ relation: 'same_as', review: false });
  });

  it('reviews a configured cross-world same_as — high-impact (§11 decision 2)', () => {
    const proposal = decideLink({
      world: ALDERFOREST,
      candidates: [candidate('pinakes:ent:napoleon-i', 0.99, REALITY)],
      policy: mergePolicy({ identityInheriting: [REALITY] }),
    });
    // Configured inheritance is a claim about two different worlds; getting it wrong is the
    // contamination §4.3 exists to prevent, so it is proposed but never applied silently.
    expect(proposal).toMatchObject({ relation: 'same_as', review: true });
    expect(proposal.why).toMatch(/high-impact/);
  });

  it('never promotes a based_on chain to same_as by transitivity', () => {
    const proposal = decideLink({
      world: REALITY,
      subject: `${ALDERFOREST}:ent:npc-renaud`,
      candidates: [candidate('pinakes:ent:napoleon-i', 0.99, REALITY)],
      lineageOnly: ['pinakes:ent:napoleon-i'],
      policy,
    });
    // Same world by the caller's own account, high confidence, and still not `same_as`:
    // the entity is already known to be *modeled on* this one (§4.5, final paragraph).
    expect(proposal.relation).toBe('based_on');
    expect(proposal.why).toMatch(/based_on chain/);
  });
});

describe('the hybrid merge policy (§11 decision 2)', () => {
  it('queues a below-threshold match instead of applying it', () => {
    const proposal = decideLink({
      world: ALDERFOREST,
      candidates: [candidate('pinakes:ent:napoleon-i', 0.83, REALITY)],
      policy: mergePolicy(),
    });
    expect(proposal).toMatchObject({ relation: 'based_on', review: true, confidence: 0.83 });
    expect(proposal.why).toMatch(/below the 0.9 threshold/);
  });

  it('takes the threshold from the world when one is configured', () => {
    const policy = mergePolicy({ perWorld: { [ALDERFOREST]: 0.8 } });
    expect(thresholdFor(ALDERFOREST, policy)).toBe(0.8);
    expect(thresholdFor(REALITY, policy)).toBe(0.9);
    expect(
      decideLink({
        world: ALDERFOREST,
        candidates: [candidate('pinakes:ent:napoleon-i', 0.83, REALITY)],
        policy,
      }).review,
    ).toBe(false);
  });

  it('refuses to pick between two near-tied candidates', () => {
    const proposal = decideLink({
      world: REALITY,
      candidates: [
        candidate('pinakes:ent:napoleon-i', 0.97, REALITY, 'Napoleon I'),
        candidate('pinakes:ent:napoleon-iii', 0.95, REALITY, 'Napoleon III'),
      ],
      policy: mergePolicy(),
    });
    // Which candidate is upstream of which relation: a confident link to the wrong nephew
    // is worse than no link, and §4.5 says queue it.
    expect(proposal).toMatchObject({ relation: null, review: true });
    expect(proposal.object).toBeUndefined();
    expect(proposal.why).toMatch(/ambiguous/);
  });

  it('proposes nothing, and queues nothing, when nothing matched', () => {
    expect(
      decideLink({ world: REALITY, candidates: [], policy: mergePolicy() }),
    ).toMatchObject({ relation: null, review: false, confidence: 0 });
  });
});
