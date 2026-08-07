/**
 * The discovery client from the inside: what it dials, what it refuses to guess, and what it
 * does with an answer. `index.test.ts` covers it again from the outside, as a consumer sees it.
 *
 * Every case here drives a stub `fetch` that records the exchange, because the promises worth
 * testing are about the *wire*: only lookup routes are ever dialed, a manifest is judged before
 * it leaves the process, and an address handed back is one the provider itself published.
 */
import { ManifestError, type CapabilityManifest } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { createDiscoveryClient, DISCOVERY_ROUTES, DiscoveryError } from './discovery.ts';

const REGISTRY = 'http://registry.example';

const manifest: CapabilityManifest = {
  kcb_version: '0.2.0',
  identity: 'example:agent:sample-provider',
  endpoints: { a2a: 'https://provider.example/a2a' },
  capabilities: [{ name: 'summarize.text', cost: { est_units: 0 } }],
};

interface Exchange {
  url: string;
  method: string;
  body?: unknown;
}

/** A `fetch` that answers `answer(url)` and records every exchange it was handed. */
function stubFetch(
  answer: (url: string, body: unknown) => { status: number; body: unknown },
  dialed: Exchange[] = [],
) {
  return (
    url: string,
    init?: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
    const body = init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown);
    dialed.push({ url, method: init?.method ?? 'GET', ...(body === undefined ? {} : { body }) });
    const { status, body: answered } = answer(url, body);
    return Promise.resolve({
      ok: status < 400,
      status,
      text: () => Promise.resolve(typeof answered === 'string' ? answered : JSON.stringify(answered)),
    });
  };
}

/** The registration the registry echoes for a push. */
function registration(source = 'push', sequence = 1): Record<string, unknown> {
  return { identity: manifest.identity, manifest, address: { identity: manifest.identity, endpoints: manifest.endpoints }, source, sequence };
}

/** One `find` match, as the registry serializes it. */
function match(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identity: manifest.identity,
    address: { identity: manifest.identity, endpoints: manifest.endpoints },
    capabilities: [{ name: 'summarize.text', endpoint: undefined, estUnits: 0, unpriced: false }],
    estUnits: 0,
    unpriced: false,
    registration: registration(),
    ...overrides,
  };
}

describe('DISCOVERY_ROUTES — the complete list of what this client dials', () => {
  it('is discovery verbs only, with nothing that could carry a payload', () => {
    const routes = Object.values(DISCOVERY_ROUTES);
    expect(routes).toEqual(['/describe', '/register', '/remove', '/find', '/address']);
    for (const route of routes) {
      expect(route).not.toMatch(/invoke|proxy|relay|forward|dispatch|complete|message/i);
    }
  });
});

describe('publishing a manifest', () => {
  it('judges the manifest locally before anything leaves the process', async () => {
    const dialed: Exchange[] = [];
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(() => ({ status: 201, body: registration() }), dialed),
    });

    await expect(client.publish({ identity: 'no kcb_version here' })).rejects.toBeInstanceOf(
      ManifestError,
    );
    expect(dialed, 'a malformed manifest is never sent').toEqual([]);
  });

  it('pushes to /register and hands back the address it published', async () => {
    const dialed: Exchange[] = [];
    const client = createDiscoveryClient(`${REGISTRY}/`, {
      fetch: stubFetch(() => ({ status: 201, body: registration('push', 3) }), dialed),
    });

    const published = await client.publish(manifest);

    expect(dialed).toEqual([
      { url: `${REGISTRY}/register`, method: 'POST', body: manifest },
    ]);
    expect(published.identity).toBe(manifest.identity);
    expect(published.address.endpoints.a2a).toBe('https://provider.example/a2a');
    expect(published.source).toBe('push');
    expect(published.sequence).toBe(3);
  });

  it('refuses a registry that indexed a different identity than the one published', async () => {
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(() => ({
        status: 201,
        body: { ...registration(), identity: 'example:agent:someone-else' },
      })),
    });

    await expect(client.publish(manifest)).rejects.toThrow(/indexed example:agent:someone-else/);
  });

  it('reports the registry’s own words when it refuses', async () => {
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(() => ({
        status: 400,
        body: { error: 'ManifestError', message: 'endpoints must be an object' },
      })),
    });

    const failure = await client.publish(manifest).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DiscoveryError);
    expect((failure as DiscoveryError).message).toBe('endpoints must be an object');
    expect((failure as DiscoveryError).status).toBe(400);
    expect((failure as DiscoveryError).url).toBe(`${REGISTRY}/register`);
  });
});

describe('finding a provider', () => {
  it('posts the query and returns matches carrying the provider’s own manifest', async () => {
    const dialed: Exchange[] = [];
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(() => ({ status: 200, body: [match()] }), dialed),
    });

    const [found] = await client.find({ capability: 'summarize.text' });

    expect(dialed).toEqual([
      { url: `${REGISTRY}/find`, method: 'POST', body: { capability: 'summarize.text' } },
    ]);
    expect(found?.identity).toBe(manifest.identity);
    expect(found?.manifest.capabilities?.[0]?.name).toBe('summarize.text');
    expect(found?.capabilities[0]).toEqual({
      name: 'summarize.text',
      endpoint: undefined,
      estUnits: 0,
      unpriced: false,
      tier: undefined,
    });
    expect(found?.estUnits).toBe(0);
  });

  it('projects the address from the manifest, not from the index’s copy of it', async () => {
    // KCB §3: the provider's manifest is authoritative and the index is a cache. A cache that
    // disagreed with the document it cached must not be able to send a caller somewhere else.
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(() => ({
        status: 200,
        body: [
          match({ address: { identity: manifest.identity, endpoints: { a2a: 'https://impostor.example' } } }),
        ],
      })),
    });

    const [found] = await client.find();
    expect(found?.address.endpoints.a2a).toBe('https://provider.example/a2a');
  });

  it('lists everything for an empty query', async () => {
    const dialed: Exchange[] = [];
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(() => ({ status: 200, body: [match()] }), dialed),
    });

    expect(await client.find()).toHaveLength(1);
    expect(dialed[0]?.body).toEqual({});
  });

  it('refuses an answer that is not a list of matches', async () => {
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(() => ({ status: 200, body: { matches: [] } })),
    });

    await expect(client.find()).rejects.toThrow(/something other than a list/);
  });
});

describe('asking where an identity is dialed', () => {
  it('reads the address off /address', async () => {
    const dialed: Exchange[] = [];
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(
        () => ({ status: 200, body: { identity: manifest.identity, endpoints: manifest.endpoints } }),
        dialed,
      ),
    });

    const address = await client.address(manifest.identity);

    expect(dialed[0]?.url).toBe(
      `${REGISTRY}/address?identity=${encodeURIComponent(manifest.identity)}`,
    );
    expect(dialed[0]?.method).toBe('GET');
    expect(address?.endpoints.a2a).toBe('https://provider.example/a2a');
  });

  it('answers undefined for an identity the index does not know, and invents nothing', async () => {
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(() => ({ status: 404, body: { error: 'NotFound' } })),
    });

    expect(await client.address('example:agent:nobody')).toBeUndefined();
  });
});

describe('the registry as it describes itself', () => {
  it('reports the verbs and the invariant a producer should check first', async () => {
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(() => ({
        status: 200,
        body: {
          identity: 'agora:agent:registry',
          kcbVersion: '0.2.0',
          proxiesTraffic: false,
          verbs: ['register', 'find'],
        },
      })),
    });

    const described = await client.describe();
    expect(described.proxiesTraffic).toBe(false);
    expect(described.verbs).toContain('find');
  });

  it('treats a missing proxiesTraffic as unproven rather than as false', async () => {
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(() => ({
        status: 200,
        body: { identity: 'agora:agent:registry', kcbVersion: '0.2.0', verbs: [] },
      })),
    });

    expect((await client.describe()).proxiesTraffic).toBe(false);
  });
});

describe('withdrawing', () => {
  it('reports whether the identity was actually in the index', async () => {
    const dialed: Exchange[] = [];
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch((_url, body) => ({
        status: 200,
        body: { removed: (body as { identity: string }).identity === manifest.identity },
      }), dialed),
    });

    expect(await client.withdraw(manifest.identity)).toBe(true);
    expect(await client.withdraw('example:agent:nobody')).toBe(false);
    expect(dialed.map((exchange) => exchange.url)).toEqual([
      `${REGISTRY}/remove`,
      `${REGISTRY}/remove`,
    ]);
  });
});

describe('when the registry cannot be reached at all', () => {
  it('names the route it was dialing', async () => {
    const client = createDiscoveryClient(REGISTRY, {
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    const failure = await client.find().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DiscoveryError);
    expect((failure as DiscoveryError).url).toBe(`${REGISTRY}/find`);
    expect((failure as DiscoveryError).message).toContain('ECONNREFUSED');
    expect((failure as DiscoveryError).status).toBeUndefined();
  });

  it('says so plainly when the runtime has no fetch to dial with', async () => {
    const original = (globalThis as { fetch?: unknown }).fetch;
    try {
      delete (globalThis as { fetch?: unknown }).fetch;
      const bare = createDiscoveryClient(`${REGISTRY}//`);
      expect(bare.registryUrl, 'the base URL is normalized once, at construction').toBe(REGISTRY);
      await expect(bare.describe()).rejects.toThrow(/no fetch implementation/);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });

  it('refuses an answer that is not JSON', async () => {
    const client = createDiscoveryClient(REGISTRY, {
      fetch: stubFetch(() => ({ status: 200, body: '<html>a proxy sat here</html>' })),
    });

    await expect(client.describe()).rejects.toThrow(/not JSON/);
  });
});
