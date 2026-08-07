import { describe, expect, it } from 'vitest';

import { hashClaimInput } from '@agora/knowledge';

import {
  createGroundingResolver,
  createLocalResolver,
  GroundingPackError,
  normalizeName,
  similarity,
  type GroundingResolver,
  type IngestReport,
} from './index.ts';

/**
 * The producer in these fixtures is `herbarium` — a namespace that names no project in this
 * tree and no application anywhere. That is the point of the story: the bridge is generic over
 * who produced the pack, so a fixture that named a real app would be testing an integration
 * instead of a contract.
 */
const PRODUCER = 'herbarium';
const CONSENSUS = 'refkb:world:consensus-reality';
const FICTION = 'worldsim:world:alderforest';

function packId(seed: string): string {
  return hashClaimInput(seed);
}

interface PackParts {
  readonly entities?: readonly unknown[];
  readonly links?: readonly unknown[];
  readonly assertions?: readonly unknown[];
  readonly [key: string]: unknown;
}

/** A minimal conformant §2 envelope, with whatever the caller wants overridden. */
function pack(parts: PackParts = {}): Record<string, unknown> {
  return {
    kgp_version: '0.4.0',
    pack_id: packId('pack'),
    producer: PRODUCER,
    worlds: [CONSENSUS],
    kind: 'snapshot',
    basis: null,
    dialect: 'grounding-only',
    entities: [],
    assertions: [],
    links: [],
    provenance: [],
    manifest: { counts: {}, created: '2026-08-06T00:00:00.000Z', license_policy: {} },
    ...parts,
  };
}

function entity(id: string, name: string, extra: Record<string, unknown> = {}): unknown {
  return {
    csid: id,
    entityType: 'person',
    fields: { name, aliases: [] },
    provenance: { source: PRODUCER, confidence: 1 },
    license: 'CC-BY-4.0',
    ...extra,
  };
}

function link(
  relation: string,
  from: string,
  to: string,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    id: `${PRODUCER}:claim:${hashClaimInput(`${relation}(${from},${to})`)}`,
    relation,
    args: [from, to],
    world: CONSENSUS,
    confidence: 0.97,
    provenance: { source: PRODUCER, confidence: 0.97 },
    license: 'CC-BY-4.0',
    egress: 'exportable',
    ...extra,
  };
}

describe('ingesting a grounding pack — the §2 envelope', () => {
  it('reads a conformant pack and reports what it did', () => {
    const resolver = createGroundingResolver();
    const report = resolver.ingest(
      pack({
        entities: [entity('refkb:ent:napoleon-i', 'Napoleon I')],
        links: [link('same_as', 'herbarium:local:ent:e-8842', 'refkb:ent:napoleon-i')],
      }),
    );
    expect(report).toMatchObject({
      producer: PRODUCER,
      worlds: [CONSENSUS],
      kind: 'snapshot',
      entities: 1,
      rejected: [],
      queued: [],
    });
    expect(report.applied).toHaveLength(1);
    expect(resolver.packs).toEqual([report.pack]);
  });

  it('refuses anything that is not the §2 envelope, by clause', () => {
    const resolver = createGroundingResolver();
    const refusals: [unknown, RegExp][] = [
      ['not a pack', /JSON object/],
      [pack({ kgp_version: undefined }), /kgp_version/],
      [pack({ pack_id: 'nope' }), /content address/],
      [pack({ producer: 'Herbarium' }), /KINP namespace/],
      [pack({ worlds: [] }), /at least one world/],
      [pack({ kind: 'patch' }), /snapshot or delta/],
      [pack({ kind: 'delta', basis: null }), /must name the pack_id/],
      [pack({ dialect: 'local-only' }), /egress class/],
    ];
    for (const [value, message] of refusals) {
      expect(() => resolver.ingest(value)).toThrow(GroundingPackError);
      expect(() => resolver.ingest(value)).toThrow(message);
    }
  });

  it('reads a pack from a newer minor but refuses a different major', () => {
    const resolver = createGroundingResolver();
    // 0.5.0 is additive over the pinned 0.4.0 (§3.4/§4.1 are about a projection this module does
    // not read), so a producer that moved first is still conformant here.
    expect(() => resolver.ingest(pack({ kgp_version: '0.5.0' }))).not.toThrow();
    try {
      resolver.ingest(pack({ kgp_version: '1.0.0' }));
      expect.unreachable('a different major must be refused');
    } catch (error) {
      expect((error as GroundingPackError).code).toBe('unsupported-version');
    }
  });

  it('refuses a pack whose dialect tier exceeds what it can evaluate (§5)', () => {
    const resolver = createGroundingResolver();
    try {
      resolver.ingest(pack({ dialect: 'full-prolog' }));
      expect.unreachable('a full-prolog pack must be refused by a grounding-only consumer');
    } catch (error) {
      expect((error as GroundingPackError).code).toBe('dialect-exceeded');
    }
    // …and admits it once the consumer declares it can evaluate that tier.
    expect(() =>
      createGroundingResolver({ dialect: 'full-prolog' }).ingest(pack({ dialect: 'full-prolog' })),
    ).not.toThrow();
  });

  it('refuses the whole pack — and reports — when it carries local-only content (§7.2)', () => {
    const resolver = createGroundingResolver();
    const carrying = pack({
      entities: [entity('refkb:ent:napoleon-i', 'Napoleon I', { egress: 'local-only' })],
    });
    try {
      resolver.ingest(carrying);
      expect.unreachable('local-only content disqualifies the pack');
    } catch (error) {
      const refusal = error as GroundingPackError;
      expect(refusal.code).toBe('local-only');
      // Reported, never silently dropped: a consumer that stripped the record and carried on
      // would hide a producer bug or a tampered pack.
      expect(refusal.violations).toEqual([
        { section: 'entities', index: 0, egress: 'local-only' },
      ]);
    }
    expect(resolver.entities.size).toBe(0);
  });
});

describe('ingesting a grounding pack — per-record admission', () => {
  it('refuses a grounding link under any relation KINP does not reserve — there is no `mentions`', () => {
    const resolver = createGroundingResolver();
    const report = resolver.ingest(
      pack({
        entities: [entity('refkb:ent:napoleon-i', 'Napoleon I')],
        links: [link('mentions', 'herbarium:local:ent:e-8842', 'refkb:ent:napoleon-i')],
      }),
    );
    expect(report.applied).toEqual([]);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.code).toBe('not-a-link-relation');
    expect(report.rejected[0]?.reason).toMatch(/source-local id `same_as`/);
    expect(report.rejected[0]?.reason).toMatch(/ADR-0008 decision 5/);
    expect(resolver.equivalence).toEqual([]);
  });

  it('ingests the same grounding once it is expressed as a source-local `same_as`', () => {
    const resolver = createGroundingResolver();
    const report = resolver.ingest(
      pack({
        entities: [entity('refkb:ent:napoleon-i', 'Napoleon I')],
        links: [link('same_as', 'herbarium:local:ent:e-8842', 'refkb:ent:napoleon-i')],
      }),
    );
    expect(report.rejected).toEqual([]);
    expect(resolver.equivalence).toHaveLength(1);
    expect(resolver.equivalence[0]).toMatchObject({
      relation: 'same_as',
      from: 'herbarium:local:ent:e-8842',
      to: 'refkb:ent:napoleon-i',
    });
  });

  it('carries a reserved lifecycle relation without walking it as an equivalence edge', () => {
    const resolver = createGroundingResolver();
    const report = resolver.ingest(
      pack({ links: [link('part_of', 'refkb:ent:corsica', 'refkb:ent:france')] }),
    );
    expect(report.rejected[0]?.code).toBe('not-an-equivalence-edge');
    expect(resolver.equivalence).toEqual([]);
  });

  it('admits per record on license, and rejects with a report (§7.1)', () => {
    const resolver = createGroundingResolver();
    const report = resolver.ingest(
      pack({
        entities: [
          entity('refkb:ent:a', 'A', { license: 'CC-BY-NC-4.0' }),
          entity('refkb:ent:b', 'B', { license: '' }),
          entity('refkb:ent:c', 'C'),
        ],
      }),
    );
    expect(report.entities).toBe(1);
    expect(report.rejected.map((entry) => entry.code)).toEqual([
      'license-refused',
      'license-missing',
    ]);
    expect(resolver.entities.has('refkb:ent:c')).toBe(true);
  });

  it('re-derives a link’s claim id from its hash_input and rejects a disagreeing one (§3.1/§4.1)', () => {
    const resolver = createGroundingResolver();
    const from = 'herbarium:local:ent:e-8842';
    const to = 'refkb:ent:napoleon-i';
    const canonical = `${CONSENSUS}|same_as(${from},${to})`;
    const honest = resolver.ingest(
      pack({
        links: [
          link('same_as', from, to, { hash_input: canonical, claim: hashClaimInput(canonical) }),
        ],
      }),
    );
    expect(honest.rejected).toEqual([]);
    expect(honest.unverified).toBe(0);

    const lying = createGroundingResolver().ingest(
      pack({
        links: [
          link('same_as', from, to, { hash_input: canonical, claim: hashClaimInput('something else') }),
        ],
      }),
    );
    expect(lying.rejected[0]?.code).toBe('claim-id-mismatch');
  });

  it('counts a link it could not re-derive rather than pretending the check ran', () => {
    const report = createGroundingResolver().ingest(
      pack({ links: [link('same_as', 'herbarium:local:ent:e-1', 'refkb:ent:napoleon-i')] }),
    );
    expect(report.unverified).toBe(1);
    expect(report.applied).toHaveLength(1);
  });
});

describe('the merged view, computed at query time (KINP §4.1, §8)', () => {
  const local = 'herbarium:local:ent:e-8842';
  const canonical = 'refkb:ent:napoleon-i';
  const external = 'wikidata:ent:q517';

  function grounded(): GroundingResolver {
    const resolver = createGroundingResolver();
    resolver.ingest(
      pack({
        entities: [entity(canonical, 'Napoleon I')],
        links: [
          link('same_as', local, canonical),
          link('same_as', canonical, external),
          link('based_on', 'worldsim:world:alderforest:ent:npc-renaud', canonical),
        ],
      }),
    );
    return resolver;
  }

  it('closes over same_as transitively and in both directions', async () => {
    const resolved = await grounded().resolve({ id: local });
    expect(resolved.sameAs.sort()).toEqual([canonical, external].sort());
    // The reference was the identity: nothing about the id itself was matched or guessed.
    expect(resolved.confidence).toBe(1);
  });

  it('never crosses a based_on edge — the §4.3 firewall', async () => {
    const resolved = await grounded().resolve({ id: local });
    expect(resolved.sameAs).not.toContain('worldsim:world:alderforest:ent:npc-renaud');
    const fiction = await grounded().resolve({ id: 'worldsim:world:alderforest:ent:npc-renaud' });
    expect(fiction.basedOn).toEqual([canonical]);
    expect(fiction.sameAs).toEqual([]);
  });

  it('stores nothing merged — the view widens as packs arrive, without rewriting a thing', async () => {
    const resolver = grounded();
    const before = await resolver.resolve({ id: local });
    expect(before.sameAs).not.toContain('musicbrainz:ent:napoleon');

    resolver.ingest(
      pack({
        pack_id: packId('second'),
        links: [link('same_as', external, 'musicbrainz:ent:napoleon')],
      }),
    );
    const after = await resolver.resolve({ id: local });
    // The same id, resolved twice, answers differently because the closure is walked per call.
    expect(after.sameAs).toContain('musicbrainz:ent:napoleon');
    // And the first answer is untouched: it was a view, not a write.
    expect(before.sameAs).not.toContain('musicbrainz:ent:napoleon');
  });

  it('keeps every provenance record behind the merge (KGP §7)', async () => {
    const resolved = await grounded().resolve({ id: local });
    expect(resolved.provenance).toContainEqual({ agent: PRODUCER });
  });

  it('never relabels a pack-derived answer as the authority’s', async () => {
    const resolved = await grounded().resolve({ id: local });
    expect(resolved.authority).toBe('local');
  });

  it('queues a below-threshold same_as instead of merging it (§4.5, §11 decision 2)', async () => {
    const resolver = createGroundingResolver();
    const report = resolver.ingest(
      pack({
        links: [link('same_as', local, canonical, { confidence: 0.4, provenance: { source: PRODUCER, confidence: 0.4 } })],
      }),
    );
    expect(report.applied).toEqual([]);
    expect(report.queued).toHaveLength(1);
    expect(report.queued[0]?.review).toBe(true);
    expect(report.queued[0]?.why).toMatch(/below the 0.9 threshold/);
    // Emitted nothing: the weak link is not in the equivalence layer, so no merge happened.
    expect(resolver.equivalence).toEqual([]);
    expect((await resolver.resolve({ id: local })).sameAs).toEqual([]);
    expect(resolver.reviewQueue).toHaveLength(1);
  });

  it('treats a link with no stated confidence as below any threshold', () => {
    const report = createGroundingResolver().ingest(
      pack({ links: [link('same_as', local, canonical, { confidence: null, provenance: { source: PRODUCER } })] }),
    );
    expect(report.applied).toEqual([]);
    expect(report.queued).toHaveLength(1);
  });
});

describe('grounding a mention against an ingested pack (ADR-0008 decision 5)', () => {
  function grounded(entities: readonly unknown[]): GroundingResolver {
    const resolver = createGroundingResolver();
    resolver.ingest(pack({ entities }));
    return resolver;
  }

  it('emits a same_as from the source-local id to the canonical entity, in the same world', async () => {
    const resolver = grounded([entity('refkb:ent:napoleon-i', 'Napoleon I')]);
    const result = await resolver.reconcile({
      query: 'napoleon i',
      of: 'herbarium:local:ent:e-8842',
      world: CONSENSUS,
    });
    expect(result.proposal).toMatchObject({
      relation: 'same_as',
      subject: 'herbarium:local:ent:e-8842',
      object: 'refkb:ent:napoleon-i',
      review: false,
    });
    expect(result.authority).toBe('local');
    expect(resolver.applied).toHaveLength(1);
    // And the decision is immediately part of the query-time view — the grounded result consumers
    // see is the merge view over the same_as closure, nothing written back over either side.
    const resolved = await resolver.resolve({ id: 'herbarium:local:ent:e-8842' });
    expect(resolved.sameAs).toEqual(['refkb:ent:napoleon-i']);
  });

  it('matches an exact reconciliation key ahead of any name', async () => {
    const resolver = grounded([
      entity('refkb:ent:napoleon-i', 'Napoleon I', {
        fields: { name: 'Napoleon I', keys: { wikidata_qid: 'Q517' } },
      }),
    ]);
    const result = await resolver.reconcile({ query: 'Q517', world: CONSENSUS });
    expect(result.candidates[0]).toMatchObject({ id: 'refkb:ent:napoleon-i', confidence: 1 });
  });

  it('crosses into `based_on` when the reference’s world does not inherit identity (§4.3)', async () => {
    const resolver = grounded([entity('refkb:ent:napoleon-i', 'Napoleon I')]);
    const result = await resolver.reconcile({
      query: 'Napoleon I',
      of: 'worldsim:world:alderforest:ent:npc-renaud',
      world: FICTION,
    });
    expect(result.proposal.relation).toBe('based_on');
    // Lineage only: the fictional general is not the real Napoleon, so no fact transfers.
    const resolved = await resolver.resolve({ id: 'worldsim:world:alderforest:ent:npc-renaud' });
    expect(resolved.sameAs).toEqual([]);
    expect(resolved.basedOn).toEqual(['refkb:ent:napoleon-i']);
  });

  it('emits nothing and queues when two candidates are too close to tell apart', async () => {
    const resolver = grounded([
      entity('refkb:ent:napoleon-i', 'Napoleon I'),
      entity('refkb:ent:napoleon-i-of-france', 'Napoleon I'),
    ]);
    const result = await resolver.reconcile({ query: 'Napoleon I', of: 'herbarium:local:ent:e-1' });
    expect(result.proposal.relation).toBeNull();
    expect(result.proposal.review).toBe(true);
    expect(result.proposal.why).toMatch(/ambiguous/);
    expect(resolver.applied).toEqual([]);
    expect(resolver.reviewQueue).toHaveLength(1);
    expect(resolver.equivalence).toEqual([]);
  });

  it('emits nothing and queues when nothing matches at all', async () => {
    const resolver = grounded([entity('refkb:ent:napoleon-i', 'Napoleon I')]);
    const result = await resolver.reconcile({ query: 'a name in no pack', of: 'herbarium:local:ent:e-2' });
    expect(result.candidates).toEqual([]);
    expect(result.proposal.relation).toBeNull();
    expect(resolver.applied).toEqual([]);
    expect(resolver.reviewQueue).toHaveLength(1);
  });

  it('queues rather than applies a fuzzy hit that cannot clear the threshold', async () => {
    const resolver = grounded([entity('refkb:ent:napoleon-i', 'Napoleon I')]);
    const result = await resolver.reconcile({ query: 'Napoleon II', of: 'herbarium:local:ent:e-3' });
    expect(result.candidates[0]?.confidence).toBeLessThan(0.9);
    expect(result.proposal.review).toBe(true);
    expect(resolver.applied).toEqual([]);
  });

  it('honours the OpenRefine `type` filter over the ingested entity types', async () => {
    const resolver = grounded([
      entity('refkb:ent:napoleon-i', 'Napoleon I'),
      entity('refkb:ent:napoleon-brandy', 'Napoleon I', { entityType: 'product' }),
    ]);
    const result = await resolver.reconcile({ query: 'Napoleon I', type: 'product' });
    expect(result.candidates.map((c) => c.id)).toEqual(['refkb:ent:napoleon-brandy']);
  });

  it('leaves reconciliation to the delegate while nothing has been ingested', async () => {
    // Degraded, not broken, and never guessing: with no packs and no authority the refusal is
    // the local resolver's, exactly as before this surface existed.
    const resolver = createGroundingResolver({ delegate: createLocalResolver() });
    await expect(resolver.reconcile({ query: 'Napoleon' })).rejects.toThrow(/equivalence is the authority/);
  });
});

describe('the matcher’s two primitives', () => {
  it('normalizes case, diacritics and punctuation into a blocking key', () => {
    expect(normalizeName('Napoléon  I.')).toBe('napoleon i');
    expect(normalizeName('napoleon i')).toBe(normalizeName('NAPOLEON-I'));
  });

  it('scores similarity in 0..1, and identical strings at 1', () => {
    expect(similarity('napoleon i', 'napoleon i')).toBe(1);
    expect(similarity('napoleon i', 'napoleon ii')).toBeGreaterThan(0.8);
    expect(similarity('napoleon', 'dragon')).toBeLessThan(0.5);
    expect(similarity('', '')).toBe(0);
  });
});

describe('producer-agnosticism', () => {
  it('reads a pack from a namespace it has never heard of, with no adapter anywhere', async () => {
    const resolver = createGroundingResolver();
    const report: IngestReport = resolver.ingest({
      kgp_version: '0.4.0',
      pack_id: packId('somebody-else'),
      producer: 'tidepool-survey',
      worlds: ['tidepool-survey:world:field-notes'],
      kind: 'snapshot',
      basis: null,
      dialect: 'grounding-only',
      entities: [
        {
          csid: 'tidepool-survey:ent:sp-114',
          entityType: 'taxon',
          fields: { name: 'Pisaster ochraceus', aliases: ['ochre sea star'] },
          provenance: { source: 'tidepool-survey', confidence: 1 },
          license: 'CC0-1.0',
        },
      ],
      assertions: [],
      links: [
        {
          id: 'tidepool-survey:claim:x',
          relation: 'same_as',
          args: ['tidepool-survey:local:ent:obs-9', 'tidepool-survey:ent:sp-114'],
          world: 'tidepool-survey:world:field-notes',
          confidence: 0.99,
          provenance: { source: 'tidepool-survey', confidence: 0.99 },
          license: 'CC0-1.0',
        },
      ],
      provenance: [],
      manifest: { counts: {}, created: '2026-08-06T00:00:00.000Z', license_policy: {} },
    });
    expect(report.producer).toBe('tidepool-survey');
    expect(report.rejected).toEqual([]);
    const resolved = await resolver.resolve({ id: 'tidepool-survey:local:ent:obs-9' });
    expect(resolved.sameAs).toEqual(['tidepool-survey:ent:sp-114']);
    // An alias the pack carried grounds a mention, with nothing in this repo naming the producer.
    const result = await resolver.reconcile({
      query: 'ochre sea star',
      of: 'tidepool-survey:local:ent:obs-10',
      world: 'tidepool-survey:world:field-notes',
    });
    expect(result.proposal.object).toBe('tidepool-survey:ent:sp-114');
  });
});
