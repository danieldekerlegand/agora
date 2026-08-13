import { describe, expect, it } from 'vitest';

import { attenuate, derivedExpiry, narrowedCeiling } from './attenuate.ts';
import { GrantError, parseGrant, permits, type Grant, type IssuedGrant } from './grant.ts';
import { createGrantIssuer, type GrantIssuer } from './issuer.ts';
import { createSigningKey, isoAt, instant } from './keys.ts';
import { grantFingerprint } from './verify.ts';

const GRANTEE = 'example:agent:caller';
const NEXT_HOP = 'example:agent:next-hop';

function grant(scope: string, budget_units?: number): Grant {
  return parseGrant({ scope, ...(budget_units === undefined ? {} : { budget_units }) });
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof GrantError ? err.status : -1;
  }
}

/** The wire form — a parent is presented as JSON, never as an object we still hold a handle on. */
function presented(grant: IssuedGrant): unknown {
  return JSON.parse(JSON.stringify(grant));
}

describe('narrowing the three dimensions', () => {
  it('keeps a scope the parent covers, and refuses one it does not', () => {
    const parent = grant('subscribe:world/*');
    expect(attenuate(parent, grant('subscribe:world/consensus-reality')).scope).toBe(
      'world/consensus-reality',
    );
    expect(attenuate(parent, grant('subscribe:world/*')).scope).toBe('world/*');
    expect(statusOf(() => attenuate(parent, grant('subscribe:*')))).toBe(403);
    expect(statusOf(() => attenuate(parent, grant('subscribe:elsewhere')))).toBe(403);
  });

  it('refuses a verb the parent does not carry, however broad its scope', () => {
    expect(statusOf(() => attenuate(grant('subscribe:*'), grant('invoke:finetune')))).toBe(403);
    expect(statusOf(() => attenuate(grant('fetch:*'), grant('subscribe:world/x')))).toBe(403);
  });

  it('lowers a ceiling, and refuses to raise one', () => {
    expect(attenuate(grant('invoke:finetune', 100), grant('invoke:finetune', 40)).budget_units).toBe(40);
    expect(statusOf(() => attenuate(grant('invoke:finetune', 100), grant('invoke:finetune', 101)))).toBe(403);
  });

  it('inherits the parent ceiling when the child states none — an unstated ceiling never widens', () => {
    // Absent means unbounded everywhere in this package, so a child that said nothing would
    // otherwise walk out with MORE than the grant it was derived from.
    expect(attenuate(grant('invoke:finetune', 100), grant('invoke:finetune')).budget_units).toBe(100);
    expect(narrowedCeiling(100, undefined)).toBe(100);
  });

  it('leaves the child unbounded only where the parent already was', () => {
    expect(narrowedCeiling(undefined, undefined)).toBeUndefined();
    expect(narrowedCeiling(undefined, 10)).toBe(10);
    expect(attenuate(grant('invoke:finetune'), grant('invoke:finetune', 10)).budget_units).toBe(10);
  });
});

describe('a child never outlives its parent', () => {
  const parent: IssuedGrant = {
    verb: 'invoke',
    scope: 'finetune',
    grantee: GRANTEE,
    expires_at: '2026-08-13T12:10:00.000Z',
    signature: { key_id: 'k', alg: 'ed25519', value: 'v' },
  };

  it('takes its own lifetime when that ends first', () => {
    expect(derivedExpiry(parent, '2026-08-13T12:00:00.000Z', 60_000)).toBe('2026-08-13T12:01:00.000Z');
  });

  it('takes the parent expiry when the lifetime would run past it', () => {
    // Otherwise a holder could re-mint its own extension: present a grant in its last second,
    // walk away with a fresh hour of the same authority.
    expect(derivedExpiry(parent, '2026-08-13T12:09:59.000Z', 3_600_000)).toBe(parent.expires_at);
  });

  it('refuses to derive from an already-expired parent', () => {
    expect(statusOf(() => derivedExpiry(parent, '2026-08-13T12:10:00.000Z', 1000))).toBe(403);
  });
});

describe('the issuer derives from a presented parent', () => {
  const key = createSigningKey('attenuate-test');
  let clock = '2026-08-13T12:00:00.000Z';
  const issuer: GrantIssuer = createGrantIssuer({
    key,
    lifetimeMs: 60 * 60 * 1000,
    now: () => clock,
  });

  const parent = issuer.issue({
    grantee: GRANTEE,
    scope: 'subscribe:world/*',
    budget_units: 100,
  });

  it('mints the narrowed child, signed and verifiable like any other grant', () => {
    const child = issuer.derive({
      parent: presented(parent),
      grantee: NEXT_HOP,
      scope: 'world/consensus-reality',
      budget_units: 25,
    });
    expect(child).toMatchObject({
      verb: 'subscribe',
      scope: 'world/consensus-reality',
      budget_units: 25,
      grantee: NEXT_HOP,
    });
    // It is a grant like any other: it verifies, and a relying party reads it with `permits`.
    const verified = issuer.verify(presented(child));
    expect(permits(verified, 'subscribe', 'world/consensus-reality')).toBe(true);
    expect(permits(verified, 'subscribe', 'world/anything-else')).toBe(false);
  });

  it('keeps the parent verb and grantee when the derivation names neither', () => {
    const child = issuer.derive({ parent: presented(parent), scope: 'world/one' });
    expect(child.verb).toBe('subscribe');
    expect(child.grantee).toBe(GRANTEE);
    expect(child.budget_units).toBe(100);
  });

  it('names its parent by fingerprint, not by carrying it', () => {
    const child = issuer.derive({ parent: presented(parent), scope: 'world/two' });
    expect(child.derived_from).toBe(grantFingerprint(parent));
    // The fingerprint identifies the parent to whoever already holds it, and hands whoever does
    // not exactly nothing they could spend.
    expect(JSON.stringify(child)).not.toContain(parent.signature.value);
    expect(issuer.verify(presented(child)).derived_from).toBe(child.derived_from);
  });

  it('refuses every widening: scope, verb, and ceiling', () => {
    const derive = (request: Record<string, unknown>): unknown =>
      issuer.derive({ parent: presented(parent), ...request });
    expect(statusOf(() => derive({ scope: '*' }))).toBe(403);
    expect(statusOf(() => derive({ scope: 'elsewhere' }))).toBe(403);
    expect(statusOf(() => derive({ verb: 'invoke', scope: 'world/x' }))).toBe(403);
    expect(statusOf(() => derive({ scope: 'world/x', budget_units: 101 }))).toBe(403);
  });

  it('refuses a parent it cannot verify — an unchecked parent is not a parent', () => {
    const forged = { ...presented(parent) as IssuedGrant, budget_units: 10_000 };
    expect(statusOf(() => issuer.derive({ parent: forged, scope: 'world/x' }))).toBe(403);
    expect(statusOf(() => issuer.derive({ scope: 'world/x' }))).toBe(403);
    expect(statusOf(() => issuer.derive({ parent: 'subscribe:world/*', scope: 'world/x' }))).toBe(422);
  });

  it('refuses a parent that has expired, before reading a claim of it', () => {
    const expiring = createGrantIssuer({ key, lifetimeMs: 1000, now: () => clock });
    const shortLived = expiring.issue({ grantee: GRANTEE, scope: 'fetch:asset' });
    const before = clock;
    clock = isoAt(instant(before) + 2000);
    try {
      expect(statusOf(() => expiring.derive({ parent: presented(shortLived), scope: 'asset' }))).toBe(403);
    } finally {
      clock = before;
    }
  });

  it('shortens the child when the parent ends before the child lifetime would', () => {
    const before = clock;
    clock = isoAt(instant(parent.expires_at) - 30_000);
    try {
      const child = issuer.derive({ parent: presented(parent), scope: 'world/late' });
      expect(child.expires_at).toBe(parent.expires_at);
    } finally {
      clock = before;
    }
  });

  it('applies the operator ceiling policy on top of the parent, tightest winning', () => {
    const capped = createGrantIssuer({
      key,
      now: () => clock,
      ceilings: { mode: 'clamp', caps: [{ scope: 'world/*', max_units: 10 }] },
    });
    const generous = capped.issue({ grantee: GRANTEE, scope: 'subscribe:world/*', budget_units: 10 });
    // The policy caps at 10 and the parent carries 10; a child asking for 5 gets 5, and one
    // asking for more than the parent is refused before the policy is ever consulted.
    expect(capped.derive({ parent: presented(generous), scope: 'world/x', budget_units: 5 }).budget_units).toBe(5);
    expect(statusOf(() => capped.derive({ parent: presented(generous), scope: 'world/x', budget_units: 50 }))).toBe(403);
  });
});
