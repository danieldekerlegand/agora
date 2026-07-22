import { describe, expect, it } from 'vitest';

import { isKinpId, parseKinpId } from './index.ts';

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
