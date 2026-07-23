import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_REGISTRY_HOST,
  DEFAULT_REGISTRY_PORT,
  PROVIDER_ROUTER_IDENTITY,
  registryLaunchFromEnv,
  startRegistry,
  type RegistryDescription,
  type Registration,
  type StartedRegistry,
} from './index.ts';
import ROUTER_MANIFEST from './fixtures/provider-router.manifest.json';

/**
 * The standalone entry point (US-6): a launch parsed from the process environment, with
 * zero-config defaults that boot a working registry immediately (in-memory, no peers), and
 * two env vars — a store path and a peer list — to layer durability and clustering on.
 */
describe('the registry entry point (env-configured, zero-config default)', () => {
  const started: StartedRegistry[] = [];
  let dir: string | undefined;

  afterEach(async () => {
    await Promise.all(started.splice(0).map((s) => s.service.close()));
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('defaults to an in-memory index with no peers on the default address', () => {
    const launch = registryLaunchFromEnv({});
    expect(launch.host).toBe(DEFAULT_REGISTRY_HOST);
    expect(launch.port).toBe(DEFAULT_REGISTRY_PORT);
    expect(launch.options.store).toBeUndefined();
    expect(launch.options.peers).toBeUndefined();
  });

  it('reads host, port, a durable store path and a peer list out of the environment', () => {
    dir = mkdtempSync(join(tmpdir(), 'agora-registry-main-'));
    const launch = registryLaunchFromEnv({
      AGORA_REGISTRY_HOST: '0.0.0.0',
      AGORA_REGISTRY_PORT: '9001',
      AGORA_REGISTRY_STORE: join(dir, 'index.json'),
      AGORA_REGISTRY_PEERS: 'http://a.local:8787, http://b.local:8787 ,',
    });
    expect(launch.host).toBe('0.0.0.0');
    expect(launch.port).toBe(9001);
    expect(launch.options.store).toBeDefined();
    expect(launch.options.peers).toEqual(['http://a.local:8787', 'http://b.local:8787']);
  });

  it('refuses a non-port PORT loudly rather than guessing', () => {
    expect(() => registryLaunchFromEnv({ AGORA_REGISTRY_PORT: 'http' })).toThrow(/valid TCP port/);
  });

  it('boots a working discovery registry with an empty environment', async () => {
    const start = await startRegistry({});
    started.push(start);
    expect(start.host).toBe(DEFAULT_REGISTRY_HOST);
    expect(start.port).toBeGreaterThan(0);
    const base = `http://${start.host}:${start.port}`;

    const description = (await (await fetch(`${base}/`)).json()) as RegistryDescription;
    expect(description.identity).toBe('agora:agent:registry');
    expect(description.proxiesTraffic).toBe(false);
    expect(description.verbs).not.toContain('invoke');
  });

  it('binds a durable store path from the environment, persisted to disk', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agora-registry-main-'));
    const storePath = join(dir, 'index.json');
    const start = await startRegistry({
      AGORA_REGISTRY_PORT: '0',
      AGORA_REGISTRY_STORE: storePath,
    });
    started.push(start);
    const base = `http://${start.host}:${start.port}`;
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ROUTER_MANIFEST),
    });

    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as Registration[];
    expect(persisted.map((r) => r.identity)).toEqual([PROVIDER_ROUTER_IDENTITY]);
  });
});
