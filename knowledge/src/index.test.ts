import { describe, expect, it } from 'vitest';

import * as knowledge from './index.ts';
import { knowledgeLaunchFromEnv } from './main.ts';

describe('the public surface', () => {
  it('exposes the bridge, and nothing that would make it a store or a relay', () => {
    expect(typeof knowledge.createKnowledgeSync).toBe('function');
    expect(typeof knowledge.admitClaims).toBe('function');
    expect(typeof knowledge.buildPack).toBe('function');
    // A `store`, a `query` or a `forward` here would be a different service than the one the
    // module header describes — the bridge holds nothing and routes nothing.
    const names = Object.keys(knowledge);
    expect(names.filter((name) => /^(store|query|forward|proxy|relay)/.test(name))).toEqual([]);
  });

  it('reports what it will not do, on its own surface', () => {
    const described = knowledge.describeKnowledgeSync();
    expect(described.retainsClaims).toBe(false);
    expect(described.coinsRelations).toBe(false);
    expect(described.identity).toBe(knowledge.KNOWLEDGE_SYNC_IDENTITY);
  });
});

describe('knowledgeLaunchFromEnv', () => {
  const REQUIRED = {
    AGORA_KNOWLEDGE_CONSUMER: 'http://127.0.0.1:9/kgp/packs',
    AGORA_KNOWLEDGE_CONSUMER_IDENTITY: 'pinakes:agent:authority',
    AGORA_KNOWLEDGE_REGISTRY: 'http://127.0.0.1:9/koine',
  };

  it('refuses to start without a consumer or a registry — there is no safe default', () => {
    expect(() => knowledgeLaunchFromEnv({})).toThrow(/AGORA_KNOWLEDGE_CONSUMER/);
    const noRegistry = { ...REQUIRED, AGORA_KNOWLEDGE_REGISTRY: '' };
    expect(() => knowledgeLaunchFromEnv(noRegistry)).toThrow(/AGORA_KNOWLEDGE_REGISTRY/);
  });

  it('defaults the policy to the contract\'s own defaults', () => {
    const launch = knowledgeLaunchFromEnv(REQUIRED);
    expect(launch.policy).toEqual({ dialect: 'grounding-only' });
    expect(launch.port).toBe(knowledge.DEFAULT_KNOWLEDGE_PORT);
  });

  it('reads the four §5/§7 knobs off AGORA_KNOWLEDGE_*', () => {
    const launch = knowledgeLaunchFromEnv({
      ...REQUIRED,
      AGORA_KNOWLEDGE_DIALECT: 'horn-safe',
      AGORA_KNOWLEDGE_LICENSES: 'public-domain, permissive',
      AGORA_KNOWLEDGE_MIN_CONFIDENCE: '0.8',
      AGORA_KNOWLEDGE_TRUSTED_SOURCES: 'refkb,herbarium',
    });
    expect(launch.policy).toEqual({
      dialect: 'horn-safe',
      licenses: ['public-domain', 'permissive'],
      minConfidence: 0.8,
      trustedSources: ['refkb', 'herbarium'],
    });
  });

  it('is loud about a value it cannot read, rather than guessing one', () => {
    expect(() =>
      knowledgeLaunchFromEnv({ ...REQUIRED, AGORA_KNOWLEDGE_DIALECT: 'full-prolog-ish' }),
    ).toThrow(/KGP §5/);
    expect(() =>
      knowledgeLaunchFromEnv({ ...REQUIRED, AGORA_KNOWLEDGE_LICENSES: 'whatever' }),
    ).toThrow(/§7\.1/);
    expect(() =>
      knowledgeLaunchFromEnv({ ...REQUIRED, AGORA_KNOWLEDGE_MIN_CONFIDENCE: '7' }),
    ).toThrow(/between 0 and 1/);
  });
});
