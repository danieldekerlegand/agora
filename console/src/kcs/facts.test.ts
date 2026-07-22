import { describe, expect, it } from 'vitest';

import { idsIn, isEmpty, readFacts } from './facts.ts';

const PACK = {
  kgp_version: '0.4.0',
  pack_id: 'sha256-de17a0',
  kind: 'delta',
  worlds: ['insimul:world:alderforest'],
  assertions: [
    {
      id: 'insimul:claim:sha256-9f3c1a',
      world: 'insimul:world:alderforest',
      subject: 'insimul:world:alderforest:ent:npc-renaud',
      relation: 'commands',
      object: 'insimul:world:alderforest:ent:army-of-ash',
      confidence: 0.9,
      prov: { agent: 'insimul:agent:world-server' },
    },
  ],
  links: [
    {
      world: 'insimul:world:alderforest',
      subject: 'insimul:world:alderforest:ent:npc-renaud',
      relation: 'based_on',
      object: 'pinakes:ent:napoleon-i',
      confidence: 0.7,
    },
  ],
};

describe('reading a GroundingPack (KGP §2)', () => {
  it('lifts the assertions with their world, confidence and provenance', () => {
    const facts = readFacts(PACK);
    expect(facts.packs).toEqual(['sha256-de17a0']);
    expect(facts.claims[0]).toMatchObject({
      id: 'insimul:claim:sha256-9f3c1a',
      world: 'insimul:world:alderforest',
      relation: 'commands',
      subject: 'insimul:world:alderforest:ent:npc-renaud',
      confidence: 0.9,
    });
    expect(facts.claims[0]?.prov?.agent).toBe('insimul:agent:world-server');
  });

  it('reads a reserved relation as a link as well as a claim (KINP §4.2)', () => {
    const facts = readFacts(PACK);
    // Both, deliberately: a `based_on` is an ordinary assertion that carries confidence
    // and provenance, *and* the edge the firewall assertions traverse.
    expect(facts.claims).toHaveLength(2);
    expect(facts.links).toEqual([
      {
        relation: 'based_on',
        from: 'insimul:world:alderforest:ent:npc-renaud',
        to: 'pinakes:ent:napoleon-i',
        world: 'insimul:world:alderforest',
        confidence: 0.7,
      },
    ]);
  });

  it('stamps every id the pack touched, for the log to record', () => {
    expect(idsIn(readFacts(PACK))).toContain('pinakes:ent:napoleon-i');
    expect(idsIn(readFacts(PACK))).toContain('insimul:world:alderforest');
  });
});

describe('reading an asset envelope (KMI §2)', () => {
  it('keeps stated-null apart from never-stated for source_world (delta H)', () => {
    // The distinction the firewall rests on: `null` says "generated, depicts no world";
    // silence says nothing at all, and must not be read as a null.
    const generated = readFacts({ id: 'composer:asset:blake3-aa', source_world: null }).assets[0];
    const silent = readFacts({ id: 'composer:asset:blake3-bb', media_type: 'audio/wav' }).assets[0];
    expect(generated?.source_world).toBeNull();
    expect(silent?.source_world).toBeUndefined();
  });

  it('folds lineage links into the composite they describe (KMI §3)', () => {
    const facts = readFacts({
      id: 'analyzer:asset:blake3-c0de99',
      media_type: 'video/mp4',
      source_world: null,
      excerpt: { source: 'insimul:asset:blake3-a1b2c3', start_ms: 0, end_ms: 4000 },
      links: [
        {
          subject: 'analyzer:asset:blake3-c0de99',
          relation: 'media:derived_from',
          object: 'analyzer:asset:blake3-master',
        },
      ],
    });
    expect(facts.assets[0]?.constituents).toEqual([
      'insimul:asset:blake3-a1b2c3',
      'analyzer:asset:blake3-master',
    ]);
  });

  it('reads attaches_to, media type and byte count — and never the bytes', () => {
    const facts = readFacts({
      id: 'insimul:asset:blake3-a1b2c3',
      media_type: 'video/mp4',
      bytes: 104857600,
      attaches_to: ['insimul:world:alderforest:ent:npc-renaud'],
      b64_json: 'ZmFrZSBieXRlcw==',
    });
    expect(facts.assets[0]).toMatchObject({
      media_type: 'video/mp4',
      bytes: 104857600,
      attaches_to: ['insimul:world:alderforest:ent:npc-renaud'],
      present: true,
    });
    expect(JSON.stringify(facts)).not.toContain('ZmFrZSBieXRlcw==');
  });
});

describe('what is not a fact', () => {
  it('reads nothing out of prose, however plausible (§7 Q2)', () => {
    // The determinism rule in one test: a model saying the right thing in English is not
    // an observation, so no assertion can be satisfied by it.
    const completion = {
      choices: [
        {
          message: {
            role: 'assistant',
            content:
              'Renaud commands the army of ash in insimul:world:alderforest, and is based_on Napoleon.',
          },
        },
      ],
    };
    expect(isEmpty(readFacts(completion))).toBe(true);
  });

  it('is not thrown off by junk, and does not walk forever', () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let depth = 0; depth < 50; depth += 1) node = node.data = {} as Record<string, unknown>;
    expect(isEmpty(readFacts(deep as never))).toBe(true);
    expect(isEmpty(readFacts(null))).toBe(true);
    expect(isEmpty(readFacts(undefined))).toBe(true);
    expect(isEmpty(readFacts([1, 'two', null] as never))).toBe(true);
  });
});
