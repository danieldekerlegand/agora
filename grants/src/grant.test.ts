import { describe, expect, it } from 'vitest';

import {
  admits,
  GRANT_VERBS,
  GrantError,
  grantToken,
  isGrantVerb,
  parseCeiling,
  parseGrant,
  parseGrantToken,
  permits,
  requiredScope,
  scopeCovers,
} from './grant.ts';

describe('the §4 verb set', () => {
  it('is exactly the five verbs the spec names', () => {
    expect([...GRANT_VERBS].sort()).toEqual(
      ['describe', 'discover', 'fetch', 'invoke', 'subscribe'].sort(),
    );
  });

  it('rejects anything outside it', () => {
    expect(isGrantVerb('invoke')).toBe(true);
    expect(isGrantVerb('publish')).toBe(false);
    expect(isGrantVerb('INVOKE')).toBe(false);
    expect(isGrantVerb(7)).toBe(false);
  });
});

describe('the token spelling', () => {
  it('round-trips <verb>:<scope>', () => {
    expect(grantToken({ verb: 'subscribe', scope: 'world/consensus-reality' })).toBe(
      'subscribe:world/consensus-reality',
    );
    expect(parseGrantToken('subscribe:world/consensus-reality')).toEqual({
      verb: 'subscribe',
      scope: 'world/consensus-reality',
    });
  });

  it('splits on the FIRST colon, so a scope keeps its own', () => {
    expect(parseGrantToken('invoke:urn:thing')).toEqual({ verb: 'invoke', scope: 'urn:thing' });
  });

  it('refuses a missing scope, a missing verb and an unknown verb as 422', () => {
    for (const bad of ['invoke:', 'finetune', '', ':finetune']) {
      expect(() => parseGrantToken(bad)).toThrow(GrantError);
    }
    expect(() => parseGrantToken('publish:world/x')).toThrow(/unknown grant verb/);
    try {
      parseGrantToken('publish:world/x');
    } catch (err) {
      expect((err as GrantError).status).toBe(422);
    }
  });
});

describe('scope coverage', () => {
  it('honors * as everything', () => {
    expect(scopeCovers('*', 'world/anything')).toBe(true);
    expect(scopeCovers('*', 'finetune')).toBe(true);
  });

  it('honors a trailing /* as its subtree, and not as a bare prefix', () => {
    expect(scopeCovers('world/*', 'world/consensus-reality')).toBe(true);
    expect(scopeCovers('world/*', 'world/')).toBe(true);
    expect(scopeCovers('world/*', 'worldly/x')).toBe(false);
    expect(scopeCovers('world/*', 'other/x')).toBe(false);
  });

  it('is otherwise exact', () => {
    expect(scopeCovers('finetune', 'finetune')).toBe(true);
    expect(scopeCovers('finetune', 'finetune-v2')).toBe(false);
  });

  it('binds the verb as well as the scope', () => {
    const grant = { verb: 'subscribe', scope: '*' } as const;
    expect(permits(grant, 'subscribe', 'world/x')).toBe(true);
    expect(permits(grant, 'invoke', 'world/x')).toBe(false);
  });
});

describe('the ceiling scalar', () => {
  it('reads a number, a numeric string, and clamps at zero', () => {
    expect(parseCeiling(12)).toBe(12);
    expect(parseCeiling('12.5')).toBe(12.5);
    expect(parseCeiling(' 3 ')).toBe(3);
    expect(parseCeiling(-1)).toBe(0);
  });

  it('reads absence as unbounded — and ONLY absence', () => {
    expect(parseCeiling(undefined)).toBeUndefined();
    expect(parseCeiling(null)).toBeUndefined();
    for (const bad of [true, false, 'plenty', '', {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseCeiling(bad)).toThrow(GrantError);
    }
  });

  it('admits an estimate under the ceiling, and any estimate without one', () => {
    expect(admits({ verb: 'invoke', scope: 'finetune', budget_units: 10 }, 9)).toBe(true);
    expect(admits({ verb: 'invoke', scope: 'finetune', budget_units: 10 }, 10)).toBe(true);
    expect(admits({ verb: 'invoke', scope: 'finetune', budget_units: 10 }, 10.5)).toBe(false);
    expect(admits({ verb: 'invoke', scope: 'finetune' }, 1e9)).toBe(true);
  });
});

describe('parsing a presented grant', () => {
  it('accepts a token, an object, and the split spelling alike', () => {
    const expected = { verb: 'subscribe', scope: 'world/x', budget_units: undefined };
    expect(parseGrant('subscribe:world/x')).toEqual(expected);
    expect(parseGrant({ scope: 'subscribe:world/x' })).toEqual(expected);
    expect(parseGrant({ verb: 'subscribe', scope: 'world/x' })).toEqual(expected);
  });

  it('grades absence 403 and unreadability 422', () => {
    for (const missing of [undefined, null, '']) {
      try {
        parseGrant(missing);
        expect.unreachable('a missing grant must be refused');
      } catch (err) {
        expect((err as GrantError).status).toBe(403);
      }
    }
    for (const unreadable of [42, ['invoke:finetune'], {}, { scope: 'invoke:finetune', budget_units: 'lots' }]) {
      try {
        parseGrant(unreadable);
        expect.unreachable('an unreadable grant must be refused');
      } catch (err) {
        expect((err as GrantError).status).toBe(422);
      }
    }
  });
});

describe('the scope a subscription needs granting for', () => {
  it('keeps a world topic and reduces a capability topic', () => {
    expect(requiredScope('world/consensus-reality')).toBe('world/consensus-reality');
    expect(requiredScope('capability/generate.image')).toBe('generate.image');
    expect(requiredScope('generate.image')).toBe('generate.image');
  });
});
