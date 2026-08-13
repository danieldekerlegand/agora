import { describe, expect, it } from 'vitest';

import { GrantError } from './grant.ts';
import { createKeyring, createSigningKey, DEFAULT_OVERLAP_MS, publicMaterial } from './keys.ts';

const START = '2026-08-13T12:00:00.000Z';
const HOUR = 60 * 60 * 1000;

/** A clock a test can wind forward — a rotation is a thing that happens over time, and waiting
 * a day for the overlap to close is not a test. */
function testClock(startIso = START): { now: () => string; advance: (ms: number) => void } {
  let at = Date.parse(startIso);
  return {
    now: () => new Date(at).toISOString(),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof GrantError ? err.status : -1;
  }
}

describe('a keyring with one key', () => {
  it('publishes the current key, with no retirement instant to publish', () => {
    const key = createSigningKey('k1');
    const ring = createKeyring({ key, now: () => START });
    expect(ring.published()).toEqual([publicMaterial(key)]);
    expect(ring.published()[0]).not.toHaveProperty('not_after');
    expect(ring.verifying('k1')).toBe(key);
    expect(ring.verifying('k2')).toBeUndefined();
  });
});

describe('rotation', () => {
  it('mints under the successor while the outgoing key keeps verifying', () => {
    const clock = testClock();
    const first = createSigningKey('k1');
    const second = createSigningKey('k2');
    const ring = createKeyring({ key: first, now: clock.now });

    const retiring = ring.rotate(second, { overlapMs: 2 * HOUR });
    expect(ring.current).toBe(second);
    expect(retiring.key).toBe(first);
    expect(retiring.not_after).toBe('2026-08-13T14:00:00.000Z');

    // Both verify during the overlap; the successor is published first, the outgoing key second
    // and carrying the instant it stops counting — a poller can see the rotation in flight.
    expect(ring.verifying('k1')).toBe(first);
    expect(ring.verifying('k2')).toBe(second);
    expect(ring.published()).toEqual([
      publicMaterial(second),
      { ...publicMaterial(first), not_after: retiring.not_after },
    ]);
  });

  it('stops verifying the outgoing key the instant the window closes', () => {
    const clock = testClock();
    const first = createSigningKey('k1');
    const ring = createKeyring({ key: first, now: clock.now });
    ring.rotate(createSigningKey('k2'), { overlapMs: HOUR });

    clock.advance(HOUR - 1);
    expect(ring.verifying('k1')).toBe(first);

    // At exactly `not_after` the window has closed: the key is out, and out of the key set.
    clock.advance(1);
    expect(ring.verifying('k1')).toBeUndefined();
    expect(ring.published().map((k) => k.key_id)).toEqual(['k2']);
    expect(ring.previous).toEqual([]);
  });

  it('defaults the overlap to a window longer than a grant lives', () => {
    const clock = testClock();
    const ring = createKeyring({ key: createSigningKey('k1'), now: clock.now });
    const retiring = ring.rotate(createSigningKey('k2'));
    expect(Date.parse(retiring.not_after) - Date.parse(START)).toBe(DEFAULT_OVERLAP_MS);
  });

  it('rotates twice, keeping every key still inside its own window', () => {
    const clock = testClock();
    const ring = createKeyring({ key: createSigningKey('k1'), now: clock.now });
    ring.rotate(createSigningKey('k2'), { overlapMs: 4 * HOUR });
    clock.advance(HOUR);
    ring.rotate(createSigningKey('k3'), { overlapMs: 4 * HOUR });
    expect(ring.published().map((k) => k.key_id)).toEqual(['k3', 'k2', 'k1']);

    clock.advance(3 * HOUR + 1); // k1's window closed an hour ago, k2's has an hour to go
    expect(ring.published().map((k) => k.key_id)).toEqual(['k3', 'k2']);
  });

  it('refuses a key_id already in the ring — a signature must resolve to one key', () => {
    const ring = createKeyring({ key: createSigningKey('k1'), now: () => START });
    expect(statusOf(() => ring.rotate(createSigningKey('k1')))).toBe(422);
    ring.rotate(createSigningKey('k2'), { overlapMs: HOUR });
    expect(statusOf(() => ring.rotate(createSigningKey('k1')))).toBe(422);
  });

  it('refuses an overlap that is not a duration', () => {
    const ring = createKeyring({ key: createSigningKey('k1'), now: () => START });
    expect(statusOf(() => ring.rotate(createSigningKey('k2'), { overlapMs: -1 }))).toBe(422);
    expect(statusOf(() => ring.rotate(createSigningKey('k3'), { overlapMs: Number.NaN }))).toBe(422);
  });
});

describe('retirement', () => {
  it('ends an overlap early — the key stops verifying and stops being published', () => {
    const clock = testClock();
    const ring = createKeyring({ key: createSigningKey('k1'), now: clock.now });
    ring.rotate(createSigningKey('k2'), { overlapMs: 8 * HOUR });
    expect(ring.verifying('k1')).toBeDefined();

    ring.retire('k1');
    expect(ring.verifying('k1')).toBeUndefined();
    expect(ring.published().map((k) => k.key_id)).toEqual(['k2']);
  });

  it('refuses to retire the minting key — an issuer with no key cannot mint', () => {
    const ring = createKeyring({ key: createSigningKey('k1'), now: () => START });
    expect(statusOf(() => ring.retire('k1'))).toBe(422);
    expect(ring.current.key_id).toBe('k1');
  });

  it('refuses to retire a key it does not hold, rather than reporting a no-op as done', () => {
    const ring = createKeyring({ key: createSigningKey('k1'), now: () => START });
    expect(statusOf(() => ring.retire('k9'))).toBe(422);
  });
});

describe('adopting keys at construction', () => {
  it('takes an outgoing key with its window, as a redeploy mid-rotation would', () => {
    const clock = testClock();
    const outgoing = createSigningKey('k1');
    const ring = createKeyring({
      key: createSigningKey('k2'),
      previous: [{ key: outgoing, not_after: '2026-08-13T13:00:00.000Z' }],
      now: clock.now,
    });
    expect(ring.verifying('k1')).toBe(outgoing);
    clock.advance(HOUR);
    expect(ring.verifying('k1')).toBeUndefined();
  });

  it('refuses two keys under one key_id, and a window that is not an instant', () => {
    const key = createSigningKey('k1');
    expect(
      statusOf(() =>
        createKeyring({ key, previous: [{ key, not_after: '2026-08-13T13:00:00.000Z' }] }),
      ),
    ).toBe(422);
    expect(
      statusOf(() =>
        createKeyring({ key, previous: [{ key: createSigningKey('k0'), not_after: 'soon' }] }),
      ),
    ).toBe(422);
  });
});
