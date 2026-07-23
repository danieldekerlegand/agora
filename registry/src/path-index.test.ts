import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findCapabilityPath, type CapabilityPath, type PathQuery } from './path.ts';
import {
  findCapabilityPathIndexed,
  forcePureTsFallback,
  isNativeIndexActive,
} from './path-index.ts';
import type { Registration } from './registry.ts';
import goldenData from './fixtures/golden-paths.json';

/** The shape of `golden-paths.json` — captured from the retired TS `findCapabilityPath` (US-1). */
interface GoldenFile {
  description: string;
  cases: {
    name: string;
    registrations: Registration[];
    query: PathQuery;
    expected: CapabilityPath | null;
  }[];
}

const golden = goldenData as unknown as GoldenFile;

describe('golden parity fixtures', () => {
  it('captured at least the ecosystem set plus a synthetic multi-hop chain', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(10);
    expect(golden.cases.map((c) => c.name)).toContain(
      'synthetic four-hop chain, priced final hop wins',
    );
  });

  // The retired TS path is the baseline the golden fixtures were captured from, so this both
  // guards the fixtures against silent corruption and pins the fallback engine to them.
  describe.each(golden.cases)('$name', ({ registrations, query, expected }) => {
    it('the pure-TS findCapabilityPath reproduces the recorded CapabilityPath', () => {
      expect(findCapabilityPath(registrations, query) ?? null).toEqual(expected);
    });

    it('the binding shim returns the identical CapabilityPath', () => {
      expect(findCapabilityPathIndexed(registrations, query) ?? null).toEqual(expected);
    });
  });
});

describe('source-first fallback — native absent (US-5)', () => {
  // Force the pure-TS branch regardless of whether an addon was built on this machine, then prove
  // it reproduces every golden CapabilityPath byte-for-byte — so `import '@agora/registry'` and its
  // ./src/index.ts exports never fail or diverge when no native/wasm artifact is present.
  beforeEach(() => forcePureTsFallback(true));
  afterEach(() => forcePureTsFallback(false));

  it('serves the pure-TS fallback, not the native index', () => {
    expect(isNativeIndexActive()).toBe(false);
  });

  describe.each(golden.cases)('$name', ({ registrations, query, expected }) => {
    it('the forced fallback returns the identical CapabilityPath', () => {
      expect(findCapabilityPathIndexed(registrations, query) ?? null).toEqual(expected);
    });
  });
});

describe('binding shim', () => {
  it('runs whether or not a native artifact was built — source-first never fails to import', () => {
    // No assertion on which backend answered: the point is the call resolves either way. When the
    // artifact is absent (the default gate) the pure-TS fallback serves; when present, the addon.
    const answer = findCapabilityPathIndexed([], { from: {}, to: {} });
    expect(answer).toBeUndefined();
    expect(typeof isNativeIndexActive()).toBe('boolean');
  });
});
