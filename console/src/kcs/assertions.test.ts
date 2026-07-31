import { createRegistry } from '@agora/registry';
import type { Json, ScenarioDocument } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import {
  ASSERTION_NAMES,
  ASSERTION_PLANES,
  evaluateAssertion,
  isImplemented,
  type AssertionContext,
} from './assertions.ts';
import { readFacts } from './facts.ts';
import { ObservationLog } from './log.ts';
import type { StepOutcome } from './outcome.ts';

const SCENARIO: ScenarioDocument = {
  kcs_version: '0.2.0',
  id: 'kcs:test',
  title: 'test',
  participants: [{ identity: 'agora:agent:provider-router' }],
  steps: [],
};

function context(outcomes: StepOutcome[] = []): AssertionContext {
  return {
    scenario: SCENARIO,
    outcomes: new Map(outcomes.map((outcome) => [outcome.id, outcome])),
    log: new ObservationLog(() => '2026-07-22T00:00:00.000Z'),
    registry: createRegistry(),
  };
}

/** Record one observation carrying whatever plane-typed records `body` holds. */
function observing(body: Json, step = 'stream', outcomes: StepOutcome[] = []): AssertionContext {
  const ctx = context(outcomes);
  ctx.log.record({
    step,
    participant: 'producer:agent:publisher',
    direction: 'frame',
    entities: [],
    detail: {},
    facts: readFacts(body),
  });
  return ctx;
}

const ITEM = 'producer:world:sample:ent:item-alpha';
const REFERENCE = 'curator:ent:reference-alpha';

function claim(overrides: Record<string, Json> = {}): Json {
  return {
    id: 'producer:claim:sha256-9f3c1a',
    world: 'producer:world:sample',
    subject: ITEM,
    relation: 'contains',
    object: 'producer:world:sample:ent:assembly-alpha',
    prov: { agent: 'producer:agent:publisher' },
    ...overrides,
  };
}

function ran(id: string, overrides: Partial<StepOutcome> = {}): StepOutcome {
  return { id, kind: 'invoke', status: 'passed', expected: 'ok', durationMs: 1, ...overrides };
}

function completion(overrides: Partial<StepOutcome> = {}): StepOutcome {
  return {
    id: 'completion',
    kind: 'invoke',
    status: 'passed',
    expected: 'ok',
    durationMs: 1,
    result: {
      tier: 'placeholder',
      cost: { currency: 'budget_units', budget_units: 0, projected_units: 0, actual_units: 0 },
      raw: {},
    },
    ...overrides,
  };
}

describe('the KCS §5 vocabulary', () => {
  it('declares every predicate the spec names, grouped by plane', () => {
    expect(ASSERTION_PLANES.identity).toContain('firewall_holds');
    expect(ASSERTION_PLANES.knowledge).toContain('claims_converge');
    expect(ASSERTION_PLANES.media).toContain('source_world_is');
    expect(ASSERTION_PLANES.control).toContain('dangling_ref_tolerated');
    expect(ASSERTION_NAMES).toHaveLength(17);
  });

  it('implements every one of them', () => {
    expect(ASSERTION_NAMES.filter((predicate) => !isImplemented(predicate))).toEqual([]);
  });

  it('never passes a predicate it cannot evaluate', () => {
    // The whole point: a scenario asserting `firewall_holds` must not go green on a
    // console that has never checked a firewall. Declared-but-pending is not a pass. The
    // list is empty today; the guard stays for the next predicate KCS adds.
    for (const name of ASSERTION_NAMES.filter((predicate) => !isImplemented(predicate))) {
      const verdict = evaluateAssertion(name, [], context());
      expect(verdict.ok).toBe(false);
      expect(verdict.pending).toBe(true);
    }
  });

  it('fails an unobserved subject rather than passing vacuously', () => {
    // Every plane predicate, asked about something the run never saw. None may pass:
    // "nothing contradicted it" is the failure mode this vocabulary exists to prevent.
    const nothing = context();
    for (const [predicate, args] of [
      ['claim_in_world', ['producer:claim:sha256-ffff', 'producer:world:sample']],
      ['claims_converge', ['producer:claim:sha256-ffff', 'curator:claim:sha256-eeee']],
      ['provenance_present', ['producer:claim:sha256-ffff']],
      ['based_on_exists', [ITEM, REFERENCE]],
      ['asset_attaches_to', ['producer:asset:blake3-ffff', ITEM]],
      ['source_world_is', ['producer:asset:blake3-ffff', null]],
      ['analysis_attributed_to_constituent', ['processor:asset:blake3-ffff']],
      ['dangling_ref_tolerated', ['producer:asset:blake3-ffff']],
      ['firewall_holds', ['query', 'curator:world:baseline']],
    ] as [string, Json[]][]) {
      expect(evaluateAssertion(predicate, args, nothing).ok).toBe(false);
    }
  });
});

describe('claim_in_world', () => {
  it('passes when every observation of the claim is in that world', () => {
    const ctx = observing({ assertions: [claim()] });
    expect(
      evaluateAssertion(
        'claim_in_world',
        ['producer:claim:sha256-9f3c1a', 'producer:world:sample'],
        ctx,
      ).ok,
    ).toBe(true);
  });

  it('fails a claim the producer never scoped — silence is not the baseline world', () => {
    const ctx = observing({ assertions: [claim({ world: null })] });
    const verdict = evaluateAssertion('claim_in_world', ['contains', 'producer:world:sample'], ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/no stated world/);
  });
});

describe('claims_converge', () => {
  it('is an identity check on the content-addressed id (KGP §3.1)', () => {
    const ctx = observing({ assertions: [claim(), claim({ prov: { agent: 'curator:agent:resolver' } })] });
    // Same fact from two producers with different provenance: one claim id, both provs.
    expect(
      evaluateAssertion(
        'claims_converge',
        ['producer:claim:sha256-9f3c1a', 'producer:claim:sha256-9f3c1a'],
        ctx,
      ).ok,
    ).toBe(true);
  });

  it('fails two claims that only look alike', () => {
    const ctx = observing({
      assertions: [claim(), claim({ id: 'processor:claim:sha256-different', subject: 'processor:ent:c-4410' })],
    });
    const verdict = evaluateAssertion(
      'claims_converge',
      ['producer:claim:sha256-9f3c1a', 'processor:claim:sha256-different'],
      ctx,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/distinct claim ids/);
  });
});

describe('provenance_present', () => {
  it('needs an agent, not merely a prov block', () => {
    expect(evaluateAssertion('provenance_present', ['contains'], observing({ assertions: [claim()] })).ok).toBe(
      true,
    );
    const anonymous = observing({ assertions: [claim({ prov: { asserted: '2026-07-20T09:00:00Z' } })] });
    expect(evaluateAssertion('provenance_present', ['contains'], anonymous).ok).toBe(false);
  });
});

describe('the identity firewall (KINP §4.3/§4.5)', () => {
  const sameAs = {
    links: [{ subject: ITEM, relation: 'same_as', object: REFERENCE }],
  };
  const basedOn = {
    links: [{ subject: ITEM, relation: 'based_on', object: REFERENCE, world: 'producer:world:sample' }],
  };

  it('passes when the scoped-world entity is only based_on the baseline one', () => {
    const ctx = observing(basedOn);
    expect(evaluateAssertion('no_sameas_across_worlds', [ITEM, REFERENCE], ctx).ok).toBe(true);
    expect(evaluateAssertion('based_on_exists', [ITEM, REFERENCE], ctx).ok).toBe(true);
  });

  it('fails a same_as that would let a scoped world flow into the baseline', () => {
    const verdict = evaluateAssertion('no_sameas_across_worlds', [ITEM, REFERENCE], observing(sameAs));
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/must be based_on/);
    expect(verdict.support).toHaveLength(1);
  });

  it('follows the same_as closure, so one hop of laundering does not hide it', () => {
    const laundered = observing({
      links: [
        { subject: ITEM, relation: 'same_as', object: 'producer:world:sample:ent:item-alias' },
        { subject: 'producer:world:sample:ent:item-alias', relation: 'same_as', object: REFERENCE },
      ],
    });
    expect(evaluateAssertion('no_sameas_across_worlds', [ITEM, REFERENCE], laundered).ok).toBe(false);
  });

  it('does not fault a same_as inside one world', () => {
    const withinWorld = observing({
      links: [
        {
          subject: ITEM,
          relation: 'same_as',
          object: 'producer:world:sample:ent:item-alias',
        },
      ],
    });
    expect(
      evaluateAssertion(
        'no_sameas_across_worlds',
        [ITEM, 'producer:world:sample:ent:item-alias'],
        withinWorld,
      ).ok,
    ).toBe(true);
  });

  it('never promotes a based_on chain to sameness by transitivity (delta C)', () => {
    const chain = observing({
      links: [
        { subject: ITEM, relation: 'based_on', object: 'curator:ent:general-x' },
        { subject: 'curator:ent:general-x', relation: 'same_as', object: REFERENCE },
      ],
    });
    expect(evaluateAssertion('no_sameas_across_worlds', [ITEM, REFERENCE], chain).ok).toBe(true);
    expect(evaluateAssertion('based_on_exists', [ITEM, REFERENCE], chain).ok).toBe(false);
  });
});

describe('firewall_holds', () => {
  const asked = 'curator:world:baseline';
  const real = claim({
    id: 'curator:claim:sha256-11aa22',
    world: asked,
    subject: REFERENCE,
    prov: { agent: 'curator:agent:resolver' },
  });

  it('passes when a real-world query returned only real-world claims', () => {
    const ctx = observing({ assertions: [real] }, 'query', [ran('query')]);
    expect(evaluateAssertion('firewall_holds', ['query', asked], ctx).ok).toBe(true);
  });

  it('fails the moment a scoped-world claim comes back', () => {
    const ctx = observing({ assertions: [real, claim()] }, 'query', [ran('query')]);
    const verdict = evaluateAssertion('firewall_holds', ['query', asked], ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/producer:world:sample/);
  });

  it('fails when the query itself did not run — a broken query proves nothing', () => {
    const ctx = observing({ assertions: [real] }, 'query', [ran('query', { status: 'failed' })]);
    expect(evaluateAssertion('firewall_holds', ['query', asked], ctx).ok).toBe(false);
  });
});

describe('the media plane (KMI §2/§5)', () => {
  const ingested = {
    id: 'producer:asset:blake3-a1b2c3',
    media_type: 'video/mp4',
    source_world: 'producer:world:sample',
    attaches_to: [ITEM],
  };
  const render = {
    id: 'processor:asset:blake3-c0de99',
    source_world: null,
    excerpt: { source: 'producer:asset:blake3-a1b2c3' },
    assertions: [
      {
        id: 'processor:claim:sha256-c3d4e5',
        world: 'producer:world:sample',
        subject: 'processor:asset:blake3-c0de99',
        relation: 'media:shows',
        object: ITEM,
        prov: { agent: 'processor:agent:pipeline' },
      },
    ],
  };

  it('reads attaches_to and source_world off the envelope', () => {
    const ctx = observing({ assets: [ingested] });
    expect(evaluateAssertion('asset_attaches_to', [ingested.id, ITEM], ctx).ok).toBe(true);
    expect(evaluateAssertion('asset_attaches_to', [ingested.id, REFERENCE], ctx).ok).toBe(false);
    expect(
      evaluateAssertion('source_world_is', [ingested.id, 'producer:world:sample'], ctx).ok,
    ).toBe(true);
  });

  it('distinguishes a generated asset from one that forgot to say (delta H)', () => {
    const generated = observing({ assets: [{ id: 'consumer:asset:blake3-aa', source_world: null }] });
    expect(evaluateAssertion('source_world_is', ['consumer:asset:blake3-aa', null], generated).ok).toBe(
      true,
    );
    const silent = observing({ assets: [{ id: 'consumer:asset:blake3-bb', media_type: 'audio/wav' }] });
    const verdict = evaluateAssertion('source_world_is', ['consumer:asset:blake3-bb', null], silent);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/requires one at ingest/);
  });

  it("attributes a composite's analysis to its constituent's world, not its own", () => {
    const ctx = observing({ assets: [ingested], results: [render] });
    expect(evaluateAssertion('analysis_attributed_to_constituent', [render.id], ctx).ok).toBe(true);
  });

  it('follows the lineage graph the whole way to an ingested asset (KMI §5)', () => {
    // A real edit puts an EDL between the render and the recording, and every intermediate is
    // generated. Stopping at the first hop would find only `source_world: null` and leave
    // the analysis attributable to nothing.
    const edl = { id: 'processor:asset:blake3-ed10a2', source_world: null };
    const composite = {
      id: 'processor:asset:blake3-d4af71',
      source_world: null,
      assertions: [
        { subject: 'processor:asset:blake3-d4af71', relation: 'media:derived_from', object: edl.id },
        { subject: edl.id, relation: 'media:derived_from', object: 'processor:asset:blake3-c0de99' },
        {
          id: 'processor:claim:sha256-2ad4e1',
          world: 'producer:world:sample',
          subject: 'processor:asset:blake3-d4af71',
          relation: 'media:shows',
          object: ITEM,
          prov: { agent: 'processor:agent:pipeline' },
        },
      ],
    };
    const ctx = observing({ assets: [ingested, edl], results: [render, composite] });
    const verdict = evaluateAssertion('analysis_attributed_to_constituent', [composite.id], ctx);
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toMatch(/producer:world:sample/);
  });

  it('fails when no constituent in the lineage was ever ingested', () => {
    const generated = { id: 'processor:asset:blake3-ed10a2', source_world: null };
    const composite = {
      id: 'processor:asset:blake3-d4af71',
      source_world: null,
      assertions: [
        { subject: 'processor:asset:blake3-d4af71', relation: 'media:derived_from', object: generated.id },
        {
          id: 'processor:claim:sha256-2ad4e1',
          world: 'producer:world:sample',
          subject: 'processor:asset:blake3-d4af71',
          relation: 'media:shows',
          object: ITEM,
          prov: { agent: 'processor:agent:pipeline' },
        },
      ],
    };
    const ctx = observing({ assets: [generated], results: [composite] });
    const verdict = evaluateAssertion('analysis_attributed_to_constituent', [composite.id], ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/attributable to no world/);
  });

  it('fails when the analysis was scoped to the composite instead', () => {
    // The render is generated (`source_world: null`), so a claim scoped to the baseline
    // world has dropped out of the scoped world its recording came from.
    const misfiled = {
      ...render,
      assertions: [{ ...render.assertions[0], world: 'curator:world:baseline' }],
    };
    const ctx = observing({ assets: [ingested], results: [misfiled] });
    const verdict = evaluateAssertion('analysis_attributed_to_constituent', [render.id], ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/curator:world:baseline/);
  });
});

describe('dangling_ref_tolerated', () => {
  const ref = 'producer:asset:blake3-ffffff';

  function missing(step: string, outcomes: StepOutcome[]): AssertionContext {
    const ctx = context(outcomes);
    ctx.log.record({
      step,
      participant: 'producer:agent:publisher',
      direction: 'response',
      entities: [],
      detail: { status: 404, dangling: true },
      facts: { claims: [], links: [], packs: [], assets: [{ id: ref, attaches_to: [], constituents: [], present: false }] },
    });
    return ctx;
  }

  it('passes when the fetch missed and the run carried on (KCB delta L)', () => {
    const ctx = missing('lazy-fetch', [
      ran('lazy-fetch', { kind: 'fetch', status: 'passed', expected: 'reject' }),
    ]);
    expect(evaluateAssertion('dangling_ref_tolerated', [ref], ctx).ok).toBe(true);
  });

  it('fails when the missing reference took the run down with it', () => {
    const ctx = missing('lazy-fetch', [ran('lazy-fetch', { kind: 'fetch', status: 'failed' })]);
    expect(evaluateAssertion('dangling_ref_tolerated', [ref], ctx).ok).toBe(false);
  });

  it('fails when nothing was ever dangling — tolerance untested is not tolerance', () => {
    expect(evaluateAssertion('dangling_ref_tolerated', [ref], context()).ok).toBe(false);
  });

  it('never passes a predicate that is not in the vocabulary at all', () => {
    const verdict = evaluateAssertion('looks_fine_to_me', [], context());
    expect(verdict.ok).toBe(false);
    expect(verdict.pending).toBeUndefined();
    expect(verdict.detail).toMatch(/not a KCS §5 predicate/);
  });
});

describe('tier_resolved', () => {
  it('passes on the tier the provider reported, and fails on any other', () => {
    const ctx = context([completion()]);
    expect(evaluateAssertion('tier_resolved', ['completion', 'placeholder'], ctx).ok).toBe(true);
    expect(evaluateAssertion('tier_resolved', ['completion', 'paid'], ctx).ok).toBe(false);
  });

  it('fails when the step never ran', () => {
    expect(evaluateAssertion('tier_resolved', ['completion', 'placeholder'], context()).ok).toBe(false);
  });
});

describe('cost_within_ceiling', () => {
  it('honors a zero ceiling', () => {
    expect(evaluateAssertion('cost_within_ceiling', ['completion', 0], context([completion()])).ok).toBe(
      true,
    );
  });

  it('fails a route that projected over the ceiling even if it spent nothing', () => {
    // A gate that only checks the bill passes a request that was one retry from a charge.
    const lucky = completion({
      result: {
        tier: 'paid',
        cost: { currency: 'budget_units', budget_units: 0, projected_units: 1200, actual_units: 0 },
        raw: {},
      },
    });
    expect(evaluateAssertion('cost_within_ceiling', ['completion', 0], context([lucky])).ok).toBe(false);
  });

  it('fails when no cost was reported — silence is not zero', () => {
    const silent = completion({ result: { tier: 'placeholder', raw: {} } });
    const verdict = evaluateAssertion('cost_within_ceiling', ['completion', 0], context([silent]));
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/not a zero cost/);
  });
});

describe('refused', () => {
  it('passes only when the step meant to be refused was', () => {
    const rejected = completion({ expected: 'reject', refused: { status: 409, reason: 'nope' } });
    expect(evaluateAssertion('refused', ['completion'], context([rejected])).ok).toBe(true);
    expect(evaluateAssertion('refused', ['completion'], context([completion()])).ok).toBe(false);
  });
});

describe('always_completes', () => {
  it('is about every step of the run, and ignores the assertions themselves', () => {
    const ctx = context([
      completion(),
      { id: 'check', kind: 'assert', status: 'failed', expected: 'ok', durationMs: 0 },
    ]);
    expect(evaluateAssertion('always_completes', [], ctx).ok).toBe(true);

    const broken = context([completion({ status: 'failed' })]);
    expect(evaluateAssertion('always_completes', [], broken).ok).toBe(false);
  });
});
