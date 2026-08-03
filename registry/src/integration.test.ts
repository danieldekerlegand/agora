import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderAddress } from '@agora/sdk';
import { SPEC_VERSIONS } from '@agora/schemas';
import {
  createResolverServer,
  RESOLVER_IDENTITY,
  type ResolvedIdentity,
  type ResolverService,
} from '@agora/resolver';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createFileStore,
  createRegistryServer,
  PROVIDER_ROUTER_IDENTITY,
  type Match,
  type Registration,
  type RegistryDescription,
  type RegistryService,
} from './index.ts';
import ROUTER_MANIFEST from './fixtures/provider-router.manifest.json';

/**
 * The cross-service integration surface (US-6): the real direct-dial path ADR-0001 decision 7
 * describes. The registry indexes the provider-router and the resolver's own manifest; a peer
 * discovers the resolver *through* the registry (find / address) and then dials the resolver
 * *directly* — traffic never passes through the registry (`proxiesTraffic:false` end to end),
 * which we prove by showing the registry has no resolve/invoke route at all. Persistence and
 * replication are exercised in the same composed run.
 */
describe('cross-service: discover through the registry, dial the resolver directly', () => {
  const registries: RegistryService[] = [];
  const resolvers: ResolverService[] = [];
  let dir: string | undefined;

  afterEach(async () => {
    // A test may have already closed one (the restart case) — closing twice is not an error here.
    await Promise.all(registries.splice(0).map((s) => s.close().catch(() => undefined)));
    await Promise.all(resolvers.splice(0).map((s) => s.close().catch(() => undefined)));
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function bootResolver(): Promise<string> {
    const service = createResolverServer();
    resolvers.push(service);
    const { host, port } = await service.listen();
    return `http://${host}:${port}`;
  }

  async function bootRegistry(store?: string): Promise<{ base: string; service: RegistryService }> {
    const service = createRegistryServer(store ? { store: createFileStore(store) } : {});
    registries.push(service);
    const { host, port } = await service.listen();
    return { base: `http://${host}:${port}`, service };
  }

  /** The resolver's own KCB manifest — a provider is a fabric entity too (§2), published with
   * the live address of its running HTTP surface so a peer can dial it. */
  function resolverManifest(resolverBase: string): Record<string, unknown> {
    return {
      kcb_version: SPEC_VERSIONS.kcb,
      identity: RESOLVER_IDENTITY,
      version: '0.0.0',
      endpoints: { a2a: resolverBase },
      capabilities: [
        { name: 'resolve', cost: { tier: 'reference', est_units: 0 } },
        { name: 'reconcile', cost: { tier: 'reference', est_units: 0 } },
      ],
    };
  }

  function register(base: string, manifest: unknown): Promise<Response> {
    return fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manifest),
    });
  }

  it('finds the resolver in the registry, then resolves an id by dialing it directly', async () => {
    const resolverBase = await bootResolver();
    const { base: registryBase } = await bootRegistry();
    await register(registryBase, ROUTER_MANIFEST);
    expect((await register(registryBase, resolverManifest(resolverBase))).status).toBe(201);

    // Discover the resolver through the registry — find gives the ranked Match with its
    // address, and address gives the endpoints to dial.
    const matches = (await (await fetch(`${registryBase}/find?capability=resolve`)).json()) as Match[];
    expect(matches[0]?.identity).toBe(RESOLVER_IDENTITY);
    const address = (await (
      await fetch(`${registryBase}/address?identity=${encodeURIComponent(RESOLVER_IDENTITY)}`)
    ).json()) as ProviderAddress;
    const dialed = address.endpoints.a2a;
    expect(dialed).toBe(resolverBase);

    // Dial the resolver DIRECTLY at the address the registry handed back — the registry is not
    // in this request's path.
    const resolved = (await (
      await fetch(`${dialed}/resolve?id=${encodeURIComponent(PROVIDER_ROUTER_IDENTITY)}`)
    ).json()) as ResolvedIdentity;
    expect(resolved.id).toBe(PROVIDER_ROUTER_IDENTITY);
    expect(resolved.authority).toBe('local');

    // The registry itself never relays: it advertises proxiesTraffic:false and has no
    // resolve/invoke route — a data-plane verb is a 404 on it, end to end.
    const description = (await (await fetch(`${registryBase}/`)).json()) as RegistryDescription;
    expect(description.proxiesTraffic).toBe(false);
    expect((await fetch(`${registryBase}/resolve?id=${PROVIDER_ROUTER_IDENTITY}`)).status).toBe(404);
    expect(
      (await fetch(`${registryBase}/invoke`, { method: 'POST', body: '{}' })).status,
    ).toBe(404);
  });

  it('answers from its durable store after a restart, no re-crawl (composed run)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agora-integration-'));
    const storePath = join(dir, 'index.json');

    const first = await bootRegistry(storePath);
    await register(first.base, ROUTER_MANIFEST);
    const before = (await (await fetch(`${first.base}/list`)).json()) as Registration[];
    await first.service.close();

    const second = await bootRegistry(storePath);
    const after = (await (await fetch(`${second.base}/list`)).json()) as Registration[];
    expect(after).toEqual(before);
    expect(after[0]?.sequence).toBe(1);
  });

  it('converges a two-node registry: a register on A is answerable on B', async () => {
    const { base: nodeBBase } = await bootRegistry();
    const nodeA = createRegistryServer({ peers: [nodeBBase] });
    registries.push(nodeA);
    const a = await nodeA.listen();
    const nodeABase = `http://${a.host}:${a.port}`;

    await register(nodeABase, ROUTER_MANIFEST);

    // B learned it through replication — it answers address/find for a provider registered on A.
    const onB = (await (
      await fetch(`${nodeBBase}/address?identity=${PROVIDER_ROUTER_IDENTITY}`)
    ).json()) as ProviderAddress;
    expect(onB.identity).toBe(PROVIDER_ROUTER_IDENTITY);

    // Still a cache on every node — no data-plane path appeared.
    const descB = (await (await fetch(`${nodeBBase}/`)).json()) as RegistryDescription;
    expect(descB.proxiesTraffic).toBe(false);
  });
});
