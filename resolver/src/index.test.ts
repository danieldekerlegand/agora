import { describe, expect, it } from 'vitest';

import {
  createLocalResolver,
  describeResolver,
  RESOLVER_IDENTITY,
  ResolverUnavailableError,
} from './index.ts';

describe('@agora/resolver', () => {
  it('identifies itself in KINP terms and pins the KINP version', () => {
    expect(describeResolver()).toEqual({
      identity: RESOLVER_IDENTITY,
      kinpVersion: '0.2.0',
      implemented: true,
      verbs: ['resolve', 'reconcile'],
    });
  });
});

describe('the local resolver', () => {
  it('resolves an id that already is a KINP id, to itself and nothing more', async () => {
    await expect(createLocalResolver().resolve({ id: 'agora:agent:provider-router' })).resolves.toEqual(
      {
        id: 'agora:agent:provider-router',
        kind: 'agent',
        authority: 'local',
        confidence: 1,
        sameAs: [],
        basedOn: [],
        provenance: [],
        attachedAssets: [],
      },
    );
  });

  it('reads the world out of a world-scoped id (§5)', async () => {
    await expect(
      createLocalResolver().resolve({ id: 'worldsim:world:alderforest:ent:npc-renaud' }),
    ).resolves.toMatchObject({ kind: 'ent', world: 'worldsim:world:alderforest' });
  });

  it('refuses to invent an identity for a name', async () => {
    // Minting without authority would seed the fabric with ids nothing can join
    // against — the failure KINP §4 exists to prevent.
    await expect(createLocalResolver().resolve({ name: 'Napoleon I' })).rejects.toThrow(
      ResolverUnavailableError,
    );
    await expect(createLocalResolver().resolve({ id: 'not-a-kinp-id' })).rejects.toThrow(
      /minting authority/,
    );
  });

  it('refuses to reconcile — equivalence is the authority’s to assert', async () => {
    await expect(createLocalResolver().reconcile({ query: 'Napoleon' })).rejects.toThrow(
      ResolverUnavailableError,
    );
  });
});
