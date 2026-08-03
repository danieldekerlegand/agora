import type { ProviderAddress } from '@agora/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRegistryServer,
  PROVIDER_ROUTER_IDENTITY,
  REPLICATION_HEADER,
  type Match,
  type RegistryDescription,
  type Registration,
  type RegistryService,
} from './index.ts';
import ROUTER_MANIFEST from './fixtures/provider-router.manifest.json';
import { NARRATOR } from './fixtures/providers.ts';

/**
 * Basic clustering (capability-bus.md §3; ADR-0001 "the registry is a cache/index"): a push to
 * one node propagates to its configured peers so every node's index converges — carrying only
 * the manifest/address, never a data-plane path, and staying loop-free, idempotent, and
 * tolerant of a downed peer.
 */
describe('registry replication across peer nodes (never a traffic hub)', () => {
  const services: RegistryService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  async function boot(peers: string[] = []): Promise<{ service: RegistryService; base: string }> {
    const service = createRegistryServer({ peers });
    services.push(service);
    const { host, port } = await service.listen();
    return { service, base: `http://${host}:${port}` };
  }

  function register(base: string, manifest: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(manifest),
    });
  }

  function remove(base: string, identity: string): Promise<Response> {
    return fetch(`${base}/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity }),
    });
  }

  it('converges node B on a push to node A — identical Match and address', async () => {
    // A knows about B; a push to A ripples to B and both answer find/address the same way.
    const b = await boot();
    const a = await boot([b.base]);

    await register(a.base, ROUTER_MANIFEST);

    const onA = (await (await fetch(`${a.base}/find?capability=generate.text`)).json()) as Match[];
    const onB = (await (await fetch(`${b.base}/find?capability=generate.text`)).json()) as Match[];
    expect(onB[0]?.identity).toBe(PROVIDER_ROUTER_IDENTITY);
    expect(onB).toEqual(onA);

    const addrA = (await (
      await fetch(`${a.base}/address?identity=${PROVIDER_ROUTER_IDENTITY}`)
    ).json()) as ProviderAddress;
    const addrB = (await (
      await fetch(`${b.base}/address?identity=${PROVIDER_ROUTER_IDENTITY}`)
    ).json()) as ProviderAddress;
    expect(addrB).toEqual(addrA);
  });

  it('replicates a manifest/address only — proxiesTraffic stays false on the peer', async () => {
    const b = await boot();
    const a = await boot([b.base]);
    await register(a.base, ROUTER_MANIFEST);

    const description = (await (await fetch(`${b.base}/`)).json()) as RegistryDescription;
    expect(description.proxiesTraffic).toBe(false);
    expect(description.verbs).not.toContain('invoke');
    // No route relays traffic on either node — replication rode the discovery routes alone.
    expect((await fetch(`${b.base}/invoke`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('propagates a remove on A to B', async () => {
    const b = await boot();
    const a = await boot([b.base]);
    await register(a.base, ROUTER_MANIFEST);
    expect((await fetch(`${b.base}/address?identity=${PROVIDER_ROUTER_IDENTITY}`)).status).toBe(200);

    await remove(a.base, PROVIDER_ROUTER_IDENTITY);
    expect((await fetch(`${b.base}/address?identity=${PROVIDER_ROUTER_IDENTITY}`)).status).toBe(404);
  });

  it('is idempotent — re-pushing an already-current manifest converges to one entry', async () => {
    const b = await boot();
    const a = await boot([b.base]);

    // The same manifest three times: a redeploy is not a new provider, on any node.
    await register(a.base, ROUTER_MANIFEST);
    await register(a.base, ROUTER_MANIFEST);
    await register(a.base, ROUTER_MANIFEST);

    const onA = (await (await fetch(`${a.base}/list`)).json()) as Registration[];
    const onB = (await (await fetch(`${b.base}/list`)).json()) as Registration[];
    expect(onA.map((r) => r.identity)).toEqual([PROVIDER_ROUTER_IDENTITY]);
    expect(onB.map((r) => r.identity)).toEqual([PROVIDER_ROUTER_IDENTITY]);
    expect(onB[0]?.sequence).toBe(1);
    expect(onB).toEqual(onA);
  });

  it('a replicated delivery is applied but not re-fanned to this node’s own peers', async () => {
    // C is A's peer; a delivery marked replicated must NOT reach C through A.
    const c = await boot();
    const a = await boot([c.base]);

    await register(a.base, NARRATOR, { [REPLICATION_HEADER]: '1' });
    expect((await fetch(`${a.base}/address?identity=${NARRATOR.identity}`)).status).toBe(200);
    expect((await fetch(`${c.base}/address?identity=${NARRATOR.identity}`)).status).toBe(404);
  });

  it('a downed peer does not break the local register — the node still answers', async () => {
    // A peer URL nothing is listening on: fetch rejects, propagation swallows it.
    const a = await boot(['http://127.0.0.1:1']);
    const response = await register(a.base, ROUTER_MANIFEST);
    expect(response.status).toBe(201);
    const list = (await (await fetch(`${a.base}/list`)).json()) as Registration[];
    expect(list.map((r) => r.identity)).toEqual([PROVIDER_ROUTER_IDENTITY]);
  });
});
