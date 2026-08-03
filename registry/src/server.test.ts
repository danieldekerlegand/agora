import type { ProviderAddress } from '@agora/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRegistryServer,
  PROVIDER_ROUTER_IDENTITY,
  type Match,
  type RegistryDescription,
  type Registration,
  type RegistryService,
} from './index.ts';
import ROUTER_MANIFEST from './fixtures/provider-router.manifest.json';

/**
 * The HTTP surface is the same index over the wire: these boot a real server on an ephemeral
 * port and speak to it with `fetch`, mirroring `index.test.ts`'s in-process assertions —
 * proxiesTraffic:false, discovery verbs only, a malformed manifest refused before it indexes.
 */
describe('the registry HTTP service (route-by-lookup, never proxy)', () => {
  let service: RegistryService;
  let base: string;

  beforeEach(async () => {
    service = createRegistryServer();
    const { host, port } = await service.listen();
    base = `http://${host}:${port}`;
  });

  afterEach(() => service.close());

  async function register(manifest: unknown): Promise<Response> {
    return fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manifest),
    });
  }

  it('indexes a pushed manifest verbatim through CapabilityRegistry.register', async () => {
    const response = await register(ROUTER_MANIFEST);
    expect(response.status).toBe(201);
    const registration = (await response.json()) as Registration;
    expect(registration.identity).toBe(PROVIDER_ROUTER_IDENTITY);
    expect(registration.sequence).toBe(1);
    expect(registration.source).toBe('push');
  });

  it('answers find with the ranked Match and its address, to dial directly', async () => {
    await register(ROUTER_MANIFEST);
    const response = await fetch(`${base}/find?capability=generate.text`);
    expect(response.status).toBe(200);
    const matches = (await response.json()) as Match[];
    expect(matches[0]?.identity).toBe(PROVIDER_ROUTER_IDENTITY);
    expect(matches[0]?.estUnits).toBe(0);
    expect(matches[0]?.capabilities[0]?.endpoint).toBe('http://127.0.0.1:8000/v1/chat/completions');
    // The address is the whole point — the caller connects there, not through the registry.
    expect(matches[0]?.address.identity).toBe(PROVIDER_ROUTER_IDENTITY);
  });

  it('hands back an address by identity, and 404s an unknown provider', async () => {
    await register(ROUTER_MANIFEST);
    const found = await fetch(`${base}/address?identity=${PROVIDER_ROUTER_IDENTITY}`);
    expect(found.status).toBe(200);
    expect(((await found.json()) as ProviderAddress).endpoints.openai).toBe(
      'http://127.0.0.1:8000/v1',
    );
    const missing = await fetch(`${base}/address?identity=agora:agent:nobody`);
    expect(missing.status).toBe(404);
  });

  it('reports proxiesTraffic:false and discovery-only verbs at the description route', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    const description = (await response.json()) as RegistryDescription;
    expect(description.identity).toBe('agora:agent:registry');
    expect(description.proxiesTraffic).toBe(false);
    expect(description.verbs).not.toContain('invoke');
    expect(description.verbs).toContain('find');
  });

  it('refuses a malformed manifest with a 4xx and never indexes it', async () => {
    const response = await register({ hello: 'world' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('ManifestError');
    // Nothing entered the index.
    const list = (await (await fetch(`${base}/list`)).json()) as Registration[];
    expect(list).toEqual([]);
  });

  it('has no invoke/proxy route — an unknown path is a 404, not a relay', async () => {
    for (const path of ['/invoke', '/proxy', '/forward']) {
      const posted = await fetch(`${base}${path}`, { method: 'POST', body: '{}' });
      expect(posted.status).toBe(404);
      const got = await fetch(`${base}${path}`);
      expect(got.status).toBe(404);
    }
  });
});
