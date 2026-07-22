import { describe, expect, it } from 'vitest';

import { isKinpId, isWorldId, kindOf, parseKinpId, worldOf } from './index.ts';

describe('KINP compact identifiers', () => {
  it('splits the namespace / kind / local-id triple', () => {
    expect(parseKinpId('orchestrator:agent:composer')).toEqual({
      namespace: 'orchestrator',
      kind: 'agent',
      localId: 'composer',
    });
  });

  it('accepts the spec §3.2 examples', () => {
    for (const id of [
      'pinakes:ent:napoleon-i',
      'analyzer:claim:sha256-9f3c1a',
      'insimul:world:alderforest',
      'agora:agent:provider-router',
    ]) {
      expect(isKinpId(id)).toBe(true);
    }
  });

  it('rejects unknown kinds, wrong arity, uppercase and non-strings', () => {
    expect(isKinpId('agora:service:router')).toBe(false);
    expect(isKinpId('agora:agent')).toBe(false);
    expect(isKinpId('agora:agent:router:extra')).toBe(false);
    expect(isKinpId('Agora:agent:router')).toBe(false);
    expect(isKinpId(42)).toBe(false);
  });
});

describe('world scoping (§5)', () => {
  it('reads the world an entity is named into, fork and all', () => {
    expect(worldOf('insimul:world:alderforest:ent:npc-renaud')).toBe('insimul:world:alderforest');
    expect(worldOf('insimul:world:alderforest#save-7f:ent:npc-renaud')).toBe(
      'insimul:world:alderforest#save-7f',
    );
  });

  it('does not guess a world for an id that is not named into one', () => {
    // A `pinakes:ent:` id is scoped by its assertion's own `world`, not by its name —
    // guessing here would decide a firewall question (§4.3) from a string.
    expect(worldOf('pinakes:ent:napoleon-i')).toBeUndefined();
    expect(worldOf('insimul:place:alderforest:ent:x')).toBeUndefined();
    expect(worldOf(42)).toBeUndefined();
  });

  it('recognises a world id itself', () => {
    expect(isWorldId('insimul:world:alderforest')).toBe(true);
    expect(isWorldId('pinakes:ent:napoleon-i')).toBe(false);
  });

  it('reads the kind out of both forms — a world-scoped id is still an entity', () => {
    // The reason this exists: `parseKinpId` answers `undefined` for the five-segment form,
    // so a caller asking "is this an entity?" would decide no for every id inside a world.
    expect(kindOf('pinakes:ent:napoleon-i')).toBe('ent');
    expect(kindOf('insimul:world:alderforest:ent:npc-renaud')).toBe('ent');
    expect(kindOf('insimul:world:alderforest#save-7f:claim:sha256-9f3c1a')).toBe('claim');
    expect(kindOf('insimul:place:alderforest:ent:x')).toBeUndefined();
    expect(kindOf(42)).toBeUndefined();
  });
});
