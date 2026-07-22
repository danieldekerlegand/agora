import { describe, expect, it } from 'vitest';

import {
  CrawlError,
  createRegistry,
  KCB_MANIFEST_PATH,
  manifestUrl,
  PROVIDER_ROUTER_IDENTITY,
  registerProviderRouter,
  type ManifestFetch,
} from './index.ts';
import { COMPOSER } from './fixtures/providers.ts';
import ROUTER_MANIFEST from './fixtures/provider-router.manifest.json';

/**
 * `provider-router.manifest.json` is the manifest the real service publishes with no keys
 * and no local servers — captured verbatim, and re-asserted against the running code by
 * `provider-router/tests/test_manifest.py`. So these tests index the router the registry
 * will actually meet, not a hand-written idea of it.
 */
function serving(body: unknown, { ok = true, status = 200 } = {}): [ManifestFetch, string[]] {
  const urls: string[] = [];
  const fetch: ManifestFetch = (url) => {
    urls.push(url);
    return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
  };
  return [fetch, urls];
}

describe('crawling a provider’s well-known manifest (KCB §3 pull)', () => {
  it('indexes the provider-router as the registry’s first entry', async () => {
    const registry = createRegistry();
    const [fetch] = serving(ROUTER_MANIFEST);
    const registration = await registerProviderRouter(registry, 'https://router.example', {
      fetch,
    });
    expect(registration.identity).toBe(PROVIDER_ROUTER_IDENTITY);
    expect(registration.sequence).toBe(1);
    expect(registration.source).toBe('pull');
    expect(registry.list().map((r) => r.identity)).toEqual([PROVIDER_ROUTER_IDENTITY]);
  });

  it('reads the manifest from the well-known path, trailing slash or not', async () => {
    const [fetch, urls] = serving(ROUTER_MANIFEST);
    await registerProviderRouter(createRegistry(), 'https://router.example/', { fetch });
    expect(urls).toEqual([`https://router.example${KCB_MANIFEST_PATH}`]);
    expect(manifestUrl('https://router.example')).toBe(urls[0]);
  });

  it('defaults to the router’s own bind address', async () => {
    const [fetch, urls] = serving(ROUTER_MANIFEST);
    await registerProviderRouter(createRegistry(), undefined, { fetch });
    expect(urls[0]).toBe(`http://127.0.0.1:8000${KCB_MANIFEST_PATH}`);
  });

  it('refuses — and does not index — a different provider at the router’s address', async () => {
    const registry = createRegistry();
    const [fetch] = serving(COMPOSER);
    await expect(registerProviderRouter(registry, 'https://router.example', { fetch })).rejects.toThrow(
      CrawlError,
    );
    expect(registry.list()).toEqual([]);
  });

  it('surfaces a failed fetch as a CrawlError naming the url', async () => {
    const [fetch] = serving(null, { ok: false, status: 503 });
    await expect(
      registerProviderRouter(createRegistry(), 'https://router.example', { fetch }),
    ).rejects.toThrow(/503/);
  });

  it('rejects a body that is not a KCB manifest', async () => {
    const [fetch] = serving({ hello: 'world' });
    await expect(
      registerProviderRouter(createRegistry(), 'https://router.example', { fetch }),
    ).rejects.toThrow(/kcb_version/);
  });
});

describe('the indexed provider-router', () => {
  async function routerIndex() {
    const registry = createRegistry();
    const [fetch] = serving(ROUTER_MANIFEST);
    await registerProviderRouter(registry, 'https://router.example', { fetch });
    return registry;
  }

  it('is discoverable by capability, with the endpoint to dial directly', async () => {
    const registry = await routerIndex();
    const match = registry.find({ capability: 'generate.text' })[0];
    expect(match?.identity).toBe(PROVIDER_ROUTER_IDENTITY);
    expect(match?.capabilities[0]?.endpoint).toBe(
      'http://127.0.0.1:8000/v1/chat/completions',
    );
  });

  it('advertises its zero-spend tier as a zero-cost route (§3 delta K)', async () => {
    const registry = await routerIndex();
    const match = registry.find({ capability: 'generate.text' })[0];
    expect(match?.estUnits).toBe(0);
    expect(match?.unpriced).toBe(false);
    expect(match?.capabilities[0]?.tier).toBe('placeholder');
  });

  it('is found by the media it produces, for any world', async () => {
    const registry = await routerIndex();
    const speech = registry.find({ produces: { mediaType: 'audio/wav' }, world: 'alderforest' });
    expect(speech.map((m) => m.identity)).toEqual([PROVIDER_ROUTER_IDENTITY]);
    expect(registry.find({ produces: { mediaType: 'video/mp4' } })).toHaveLength(1);
  });

  it('is a one-hop path from a prompt to narration', async () => {
    const registry = await routerIndex();
    const path = registry.path({
      from: { plane: 'knowledge', shape: 'prompt-text' },
      to: { mediaType: 'audio/wav' },
    });
    expect(path?.steps).toHaveLength(1);
    expect(path?.projectedUnits).toBe(0);
    expect(path?.steps[0]?.address.endpoints.openai).toBe('http://127.0.0.1:8000/v1');
  });
});
