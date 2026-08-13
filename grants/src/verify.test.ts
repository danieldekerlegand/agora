/**
 * Verification, driven the way a relying party actually meets it: over grants that went through
 * JSON, against key material that came off `GET /keys`, on a clock that can be wound forward.
 */
import { describe, expect, it } from 'vitest';

import { GrantError, permits, type IssuedGrant } from './grant.ts';
import { createGrantIssuer } from './issuer.ts';
import { createSigningKey, type PublishedKey } from './keys.ts';
import { createGrantVerifier, isExpired, parseIssuedGrant, verifyGrant } from './verify.ts';

const START = '2026-08-13T12:00:00.000Z';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const GRANTEE = 'example:agent:some-principal';

function testClock(startIso = START): { now: () => string; advance: (ms: number) => void } {
  let at = Date.parse(startIso);
  return {
    now: () => new Date(at).toISOString(),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** Exactly what a relying party holds: the grant as it came off the wire. A value with no JSON
 * form at all (`undefined`) stays itself — "nothing was presented" is a case too. */
function overTheWire<T>(value: T): unknown {
  const json = JSON.stringify(value);
  return json === undefined ? value : (JSON.parse(json) as unknown);
}

function refusalOf(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
    return { status: 0, message: 'no refusal' };
  } catch (err) {
    if (err instanceof GrantError) return { status: err.status, message: err.message };
    throw err;
  }
}

describe('a grant carries its lifetime', () => {
  it('mints an expiry the caller can read, one lifetime out', () => {
    const clock = testClock();
    const issuer = createGrantIssuer({
      key: createSigningKey('k1'),
      lifetimeMs: 2 * HOUR,
      now: clock.now,
    });
    const grant = issuer.issue({ grantee: GRANTEE, scope: 'invoke:finetune' });
    expect(grant.expires_at).toBe('2026-08-13T14:00:00.000Z');
    expect(isExpired(grant, START)).toBe(false);
    expect(isExpired(grant, grant.expires_at)).toBe(true);
  });

  it('refuses to be configured to mint one that never expires', () => {
    const key = createSigningKey('k1');
    for (const lifetimeMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(refusalOf(() => createGrantIssuer({ key, lifetimeMs })).status).toBe(422);
    }
  });

  it('refuses an expired grant with a 403 — an answer the caller can act on', () => {
    const clock = testClock();
    const issuer = createGrantIssuer({
      key: createSigningKey('k1'),
      lifetimeMs: HOUR,
      now: clock.now,
    });
    const grant = overTheWire(issuer.issue({ grantee: GRANTEE, scope: 'invoke:finetune' }));
    const verify = createGrantVerifier({ keys: issuer.publicKeys(), now: clock.now });

    clock.advance(HOUR - MINUTE);
    expect(verify(grant)).toMatchObject({ verb: 'invoke', scope: 'finetune' });

    clock.advance(MINUTE);
    const refusal = refusalOf(() => verify(grant));
    expect(refusal.status).toBe(403);
    expect(refusal.message).toContain('expired');
    // Not a 422: it WAS a grant, and it says when it stopped being one.
    expect(refusal.message).toContain('2026-08-13T13:00:00.000Z');
  });

  it('cannot have its lifetime extended by editing it — the expiry is signed', () => {
    const issuer = createGrantIssuer({ key: createSigningKey('k1'), lifetimeMs: HOUR });
    const grant = issuer.issue({ grantee: GRANTEE, scope: 'invoke:finetune' });
    const stretched = { ...grant, expires_at: '2099-01-01T00:00:00.000Z' };
    expect(refusalOf(() => issuer.verify(overTheWire(stretched))).status).toBe(403);
  });
});

describe('issue → rotate → verify → retire → refuse', () => {
  it('honors a grant signed under the previous key for the length of the overlap', () => {
    const clock = testClock();
    const first = createSigningKey('k1');
    const issuer = createGrantIssuer({ key: first, lifetimeMs: 8 * HOUR, now: clock.now });

    // Issued under k1, and in the caller's hands before anything rotates.
    const held = overTheWire(issuer.issue({ grantee: GRANTEE, scope: 'subscribe:world/*' }));
    expect(issuer.verify(held)).toMatchObject({ signature: { key_id: 'k1' } });

    // Rotate. New grants are minted under k2; the one already held still verifies.
    const retiring = issuer.rotate(createSigningKey('k2'), { overlapMs: 4 * HOUR });
    expect(retiring.key.key_id).toBe('k1');
    expect(issuer.issue({ grantee: GRANTEE, scope: 'fetch:asset' }).signature.key_id).toBe('k2');
    clock.advance(2 * HOUR);
    const stillGood = issuer.verify(held);
    expect(permits(stillGood, 'subscribe', 'world/consensus-reality')).toBe(true);

    // Retire the outgoing key early: every grant signed under it stops verifying at once. This
    // is the coarse instrument the issuer has instead of a revocation list.
    issuer.retire('k1');
    const refusal = refusalOf(() => issuer.verify(held));
    expect(refusal.status).toBe(403);
    expect(refusal.message).toContain('k1');
  });

  it('refuses a grant whose key aged out of the overlap without an operator saying so', () => {
    const clock = testClock();
    const issuer = createGrantIssuer({
      key: createSigningKey('k1'),
      lifetimeMs: 8 * HOUR,
      now: clock.now,
    });
    const held = overTheWire(issuer.issue({ grantee: GRANTEE, scope: 'invoke:compose' }));
    issuer.rotate(createSigningKey('k2'), { overlapMs: HOUR });

    clock.advance(HOUR - 1);
    expect(issuer.verify(held)).toMatchObject({ scope: 'compose' });

    clock.advance(1);
    expect(refusalOf(() => issuer.verify(held)).status).toBe(403);
    // The grant itself is still inside its own lifetime — it is the key that ran out.
    expect(refusalOf(() => issuer.verify(held)).message).not.toContain('expired at');
  });

  it('publishes a key set that says which key is on its way out and until when', () => {
    const clock = testClock();
    const issuer = createGrantIssuer({ key: createSigningKey('k1'), now: clock.now });
    issuer.rotate(createSigningKey('k2'), { overlapMs: 3 * HOUR });
    const published = overTheWire(issuer.publicKeys()) as PublishedKey[];
    expect(published.map((k) => k.key_id)).toEqual(['k2', 'k1']);
    expect(published[0]).not.toHaveProperty('not_after');
    expect(published[1]?.not_after).toBe('2026-08-13T15:00:00.000Z');
  });
});

describe('the verifier a relying party runs', () => {
  it('verifies from polled key material alone, without dialing the issuer', () => {
    const clock = testClock();
    const issuer = createGrantIssuer({ key: createSigningKey('k1'), now: clock.now });
    // The relying party's whole input: the JSON `GET /keys` served, and the presented grant.
    const polled = overTheWire(issuer.publicKeys()) as PublishedKey[];
    const grant = overTheWire(issuer.issue({ grantee: GRANTEE, scope: 'invoke:finetune' }));

    const verified = verifyGrant(grant, { keys: polled, now: clock.now });
    expect(verified.grantee).toBe(GRANTEE);
    expect(permits(verified, 'invoke', 'finetune')).toBe(true);
  });

  it('follows a rotation when the key set is re-polled, without being rebuilt', () => {
    const clock = testClock();
    const issuer = createGrantIssuer({ key: createSigningKey('k1'), now: clock.now });
    // A poller: whatever it last fetched is what the verifier sees.
    let polled = overTheWire(issuer.publicKeys()) as PublishedKey[];
    const verify = createGrantVerifier({ keys: () => polled, now: clock.now });

    issuer.rotate(createSigningKey('k2'), { overlapMs: 4 * HOUR });
    const minted = overTheWire(issuer.issue({ grantee: GRANTEE, scope: 'fetch:asset' }));
    // Not yet polled: the new key is not one this verifier has ever seen.
    expect(refusalOf(() => verify(minted)).status).toBe(403);

    polled = overTheWire(issuer.publicKeys()) as PublishedKey[];
    expect(verify(minted)).toMatchObject({ verb: 'fetch', scope: 'asset' });
  });

  it('refuses what it cannot trust with a 403, and what it cannot read with a 422', () => {
    const clock = testClock();
    const issuer = createGrantIssuer({ key: createSigningKey('k1'), now: clock.now });
    const keys = issuer.publicKeys();
    const verify = createGrantVerifier({ keys, now: clock.now });
    const grant = issuer.issue({ grantee: GRANTEE, scope: 'invoke:finetune', budget_units: 10 });

    // 403 — a real grant shape, nothing here that authorizes it.
    const untrusted: IssuedGrant[] = [
      { ...grant, budget_units: 10_000 },
      { ...grant, scope: '*' },
      { ...grant, grantee: 'example:agent:someone-else' },
      { ...grant, signature: { ...grant.signature, key_id: 'k9' } },
      { ...grant, signature: { ...grant.signature, alg: 'hs256' } },
    ];
    for (const presented of untrusted) {
      expect(refusalOf(() => verify(overTheWire(presented))).status).toBe(403);
    }

    // Presenting nothing is a 403, not a 422 — `apr_grant:parse/1` grades an absent grant as
    // "you are not authorized", because the caller did not send a broken grant, it sent none.
    expect(refusalOf(() => verify(undefined)).status).toBe(403);

    // 422 — not a grant. The caller can fix every one of these.
    const unreadable: unknown[] = [
      42,
      { ...grant, verb: 'publish' },
      { ...grant, budget_units: 'plenty' },
      { ...grant, expires_at: 'soon' },
      { ...grant, expires_at: undefined },
      { ...grant, grantee: '  ' },
      { ...grant, signature: undefined },
      { ...grant, signature: { key_id: 'k1', alg: 'ed25519' } },
      'invoke:finetune',
    ];
    for (const presented of unreadable) {
      expect(refusalOf(() => verify(overTheWire(presented))).status).toBe(422);
    }

    expect(verify(overTheWire(grant))).toMatchObject({ verb: 'invoke', scope: 'finetune' });
  });

  it('reads an issued grant back with every claim intact', () => {
    const issuer = createGrantIssuer({ key: createSigningKey('k1') });
    const grant = issuer.issue({ grantee: GRANTEE, scope: 'subscribe:world/x', budget_units: 4 });
    expect(parseIssuedGrant(overTheWire(grant))).toEqual(grant);
  });
});
