import { describe, expect, it } from 'vitest';

import { ManifestError, SPEC_VERSIONS } from '@agora/schemas';

import { createRegistry, type CapabilityRegistry } from './index.ts';
import {
  COMPOSER,
  DESCRIBER,
  NARRATOR,
  PREMIUM_RENDERER,
  RENDERER,
  UNPRICED_RENDERER,
  WORLD_EXPORT,
} from './fixtures/providers.ts';

function indexed(...manifests: unknown[]): CapabilityRegistry {
  const registry = createRegistry();
  for (const manifest of manifests) registry.register(manifest);
  return registry;
}

describe('registering manifests (KCB §3 population)', () => {
  it('indexes a manifest and hands back the address to dial', () => {
    const registry = indexed(COMPOSER);
    expect(registry.address(COMPOSER.identity)).toEqual({
      identity: 'orchestrator:agent:composer',
      endpoints: COMPOSER.endpoints,
    });
    expect(registry.list().map((r) => r.identity)).toEqual([COMPOSER.identity]);
  });

  it('records how the manifest arrived, and in what order', () => {
    const registry = createRegistry();
    const first = registry.register(COMPOSER);
    const second = registry.register(RENDERER, { source: 'pull' });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect([first.source, second.source]).toEqual(['push', 'pull']);
  });

  it('treats the provider as authoritative: re-registering replaces, never merges', () => {
    const registry = indexed(COMPOSER);
    const withdrawn = { ...COMPOSER, capabilities: [] };
    const again = registry.register(withdrawn);
    expect(registry.get(COMPOSER.identity)?.manifest.capabilities).toEqual([]);
    // A redeploy is the same provider, so it keeps its place in the index.
    expect(again.sequence).toBe(1);
    expect(registry.list()).toHaveLength(1);
  });

  it('stores the manifest verbatim, insulated from both sides', () => {
    const mutable = structuredCloneish(COMPOSER);
    const registry = createRegistry();
    const registration = registry.register(mutable);
    mutable.identity = 'orchestrator:agent:impostor';
    expect(registration.manifest.identity).toBe('orchestrator:agent:composer');
    expect(() => {
      (registration.manifest as { identity: string }).identity = 'orchestrator:agent:impostor';
    }).toThrow();
  });

  it('refuses anything that is not a readable KCB manifest', () => {
    const registry = createRegistry();
    expect(() => registry.register({ kcb_version: SPEC_VERSIONS.kcb })).toThrow(ManifestError);
    expect(registry.list()).toEqual([]);
  });

  it('drops a provider on request — the index is a cache, not the source of truth', () => {
    const registry = indexed(COMPOSER);
    expect(registry.remove(COMPOSER.identity)).toBe(true);
    expect(registry.remove(COMPOSER.identity)).toBe(false);
    expect(registry.address(COMPOSER.identity)).toBeUndefined();
  });
});

describe('find (KCB §3)', () => {
  it('finds by capability name', () => {
    const registry = indexed(COMPOSER, NARRATOR, RENDERER);
    const matches = registry.find({ capability: 'narrate' });
    expect(matches.map((m) => m.identity)).toEqual([NARRATOR.identity]);
    expect(matches[0]?.capabilities[0]?.endpoint).toBe('https://analyzer.example/mcp');
  });

  it('finds by port, in the direction asked for', () => {
    const registry = indexed(COMPOSER, RENDERER, DESCRIBER);
    expect(registry.find({ produces: { mediaType: 'audio/midi' } }).map((m) => m.identity)).toEqual([
      COMPOSER.identity,
    ]);
    expect(registry.find({ consumes: { mediaType: 'audio/midi' } }).map((m) => m.identity)).toEqual([
      RENDERER.identity,
    ]);
  });

  it('finds by plane, across the planes a capability spans', () => {
    const registry = indexed(COMPOSER, DESCRIBER);
    expect(registry.find({ plane: 'entity' }).map((m) => m.identity)).toEqual([DESCRIBER.identity]);
    expect(registry.find({ plane: 'media' }).map((m) => m.identity)).toEqual([COMPOSER.identity]);
  });

  it('finds by world (delta J)', () => {
    const registry = indexed(NARRATOR, RENDERER);
    expect(registry.find({ world: 'alderforest' }).map((m) => m.identity)).toEqual([
      NARRATOR.identity,
    ]);
    expect(registry.find({ world: 'consensus-reality' })).toEqual([]);
  });

  it('conjoins its clauses', () => {
    const registry = indexed(NARRATOR);
    expect(registry.find({ world: 'alderforest', produces: { mediaType: 'audio/wav' } })).toHaveLength(1);
    expect(registry.find({ world: 'alderforest', produces: { mediaType: 'video/mp4' } })).toEqual([]);
  });

  it('lists every provider for an empty query', () => {
    const registry = indexed(COMPOSER, RENDERER);
    expect(registry.find()).toHaveLength(2);
  });

  it('answers with addresses — never with a way to invoke through the registry', () => {
    const match = indexed(RENDERER).find({ capability: 'render' })[0];
    expect(match?.address.endpoints.mcp).toBe('https://composer.example/mcp');
    // ADR-0001 decision 3: a capability endpoint is dialed by the caller, directly.
    expect(match?.capabilities[0]?.endpoint).toBe('https://composer.example/mcp/render');
    expect(Object.keys(match ?? {})).not.toContain('invoke');
  });
});

describe('ranking (KCB §3 delta K)', () => {
  it('prefers the zero-cost route', () => {
    const registry = indexed(PREMIUM_RENDERER, RENDERER);
    const matches = registry.find({ capability: 'render' });
    expect(matches.map((m) => m.identity)).toEqual([RENDERER.identity, PREMIUM_RENDERER.identity]);
    expect(matches[0]?.estUnits).toBe(0);
    expect(matches[0]?.capabilities[0]?.tier).toBe('local');
  });

  it('ranks an unpriced capability last — unknown is not free', () => {
    const registry = indexed(UNPRICED_RENDERER, PREMIUM_RENDERER);
    expect(registry.find({ capability: 'render' }).map((m) => m.identity)).toEqual([
      PREMIUM_RENDERER.identity,
      UNPRICED_RENDERER.identity,
    ]);
  });
});

describe('providers with ports but no named capability', () => {
  it('are discoverable and dialable', () => {
    const registry = indexed(WORLD_EXPORT);
    const matches = registry.find({ produces: { dialect: 'grounding-only' } });
    expect(matches.map((m) => m.identity)).toEqual([WORLD_EXPORT.identity]);
    expect(matches[0]?.capabilities).toEqual([]);
    expect(matches[0]?.unpriced).toBe(true);
  });

  it('never answer a capability-name query', () => {
    expect(indexed(WORLD_EXPORT).find({ capability: 'export' })).toEqual([]);
  });
});

/** A structural copy that keeps the manifest mutable, for the tamper test above. */
function structuredCloneish<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
