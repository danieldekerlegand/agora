import { describe, expect, it } from 'vitest';

import { createRegistry, type CapabilityRegistry } from './index.ts';
import {
  COMPOSER,
  DESCRIBER,
  NARRATOR,
  PREMIUM_RENDERER,
  RENDERER,
  UNPRICED_RENDERER,
} from './fixtures/providers.ts';

function indexed(...manifests: unknown[]): CapabilityRegistry {
  const registry = createRegistry();
  for (const manifest of manifests) registry.register(manifest);
  return registry;
}

const ALL = () => indexed(DESCRIBER, COMPOSER, RENDERER, PREMIUM_RENDERER, NARRATOR);

describe('capability-path search (KCB §3 composition)', () => {
  it('composes a score from a mood — across planes and providers', () => {
    // The pressure test's leg: entity(mood) → knowledge(mood-descriptor) → media(midi) →
    // media(wav). No hop is media-to-media only, which is exactly why ports are
    // plane-typed (§2.1 delta F).
    const path = ALL().path({ from: { entityType: 'mood' }, to: { mediaType: 'audio/wav' } });
    expect(path?.steps.map((s) => `${s.identity}/${s.capability}`)).toEqual([
      'pinakes:agent:describer/describe',
      'orchestrator:agent:composer/compose',
      'composer:agent:renderer/render',
    ]);
  });

  it('returns the projected cost so the caller can gate spend before invoking (delta K)', () => {
    const path = ALL().path({ from: { entityType: 'mood' }, to: { mediaType: 'audio/wav' } });
    expect(path?.projectedUnits).toBe(1200);
    expect(path?.unpriced).toBe(false);
  });

  it('prefers the zero-cost route when two providers offer the same hop', () => {
    const path = ALL().path({ from: { mediaType: 'audio/midi' }, to: { mediaType: 'audio/wav' } });
    expect(path?.steps.map((s) => s.identity)).toEqual([RENDERER.identity]);
    expect(path?.projectedUnits).toBe(0);
  });

  it('takes a priced route over an unpriced one — unknown is not free', () => {
    const registry = indexed(UNPRICED_RENDERER, PREMIUM_RENDERER);
    const path = registry.path({ from: { mediaType: 'audio/midi' }, to: { mediaType: 'audio/wav' } });
    expect(path?.steps.map((s) => s.identity)).toEqual([PREMIUM_RENDERER.identity]);
    expect(path?.projectedUnits).toBe(900);
  });

  it('honours world scoping on the goal port (delta J)', () => {
    const path = ALL().path({
      from: { shape: 'prompt-text' },
      to: { mediaType: 'audio/wav', world: 'alderforest' },
    });
    expect(path?.steps.map((s) => s.identity)).toEqual([NARRATOR.identity]);
  });

  it('is a plan of addresses to dial, not a route through the registry', () => {
    const path = indexed(RENDERER).path({
      from: { mediaType: 'audio/midi' },
      to: { mediaType: 'audio/wav' },
    });
    // ADR-0001 decision 3: the caller invokes each hop directly against these addresses.
    expect(path?.steps[0]?.address.endpoints.mcp).toBe('https://composer.example/mcp');
    expect(path?.steps[0]?.endpoint).toBe('https://composer.example/mcp/render');
  });

  it('has no path when no chain of contracts reaches the goal', () => {
    const path = ALL().path({ from: { entityType: 'mood' }, to: { mediaType: 'video/mp4' } });
    expect(path).toBeUndefined();
  });

  it('is bounded by maxHops', () => {
    const query = { from: { entityType: 'mood' }, to: { mediaType: 'audio/wav' } };
    expect(ALL().path({ ...query, maxHops: 2 })).toBeUndefined();
    expect(ALL().path({ ...query, maxHops: 3 })?.steps).toHaveLength(3);
  });

  it('finds nothing in an empty index', () => {
    expect(createRegistry().path({ from: {}, to: {} })).toBeUndefined();
  });
});
