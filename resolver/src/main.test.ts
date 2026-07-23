import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RESOLVER_HOST,
  DEFAULT_RESOLVER_PORT,
  resolverLaunchFromEnv,
  startResolver,
  type ResolvedIdentity,
  type ResolverDescription,
  type StartedResolver,
} from './index.ts';

/**
 * The standalone entry point (US-6): a launch parsed from the process environment, with
 * zero-config defaults that boot the degraded-but-not-broken local resolver immediately, and
 * env vars to point it at an authority and give it durable cache / link stores.
 */
describe('the resolver entry point (env-configured, zero-config default)', () => {
  const started: StartedResolver[] = [];
  let dir: string | undefined;

  afterEach(async () => {
    await Promise.all(started.splice(0).map((s) => s.service.close()));
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('defaults to the local resolver (no authority, no durable stores) on the default address', () => {
    const launch = resolverLaunchFromEnv({});
    expect(launch.host).toBe(DEFAULT_RESOLVER_HOST);
    expect(launch.port).toBe(DEFAULT_RESOLVER_PORT);
    expect(launch.options.authority).toBeUndefined();
    expect(launch.options.cache).toBeUndefined();
    expect(launch.options.links).toBeUndefined();
  });

  it('reads host, port, authority, identity and durable paths out of the environment', () => {
    dir = mkdtempSync(join(tmpdir(), 'agora-resolver-main-'));
    const launch = resolverLaunchFromEnv({
      AGORA_RESOLVER_HOST: '0.0.0.0',
      AGORA_RESOLVER_PORT: '9101',
      AGORA_RESOLVER_AUTHORITY: 'http://pinakes.local:8080',
      AGORA_RESOLVER_IDENTITY: 'pinakes:agent:resolver',
      AGORA_RESOLVER_CACHE: join(dir, 'cache.json'),
      AGORA_RESOLVER_LINKS: join(dir, 'links.json'),
    });
    expect(launch.host).toBe('0.0.0.0');
    expect(launch.port).toBe(9101);
    expect(launch.options.authority).toBe('http://pinakes.local:8080');
    expect(launch.options.authorityIdentity).toBe('pinakes:agent:resolver');
    expect(launch.options.cache).toBeDefined();
    expect(launch.options.links).toBeDefined();
  });

  it('refuses a non-port PORT loudly rather than guessing', () => {
    expect(() => resolverLaunchFromEnv({ AGORA_RESOLVER_PORT: 'http' })).toThrow(/valid TCP port/);
  });

  it('boots a working local resolver with an empty environment', async () => {
    const start = await startResolver({});
    started.push(start);
    expect(start.host).toBe(DEFAULT_RESOLVER_HOST);
    expect(start.port).toBeGreaterThan(0);
    const base = `http://${start.host}:${start.port}`;

    const description = (await (await fetch(`${base}/`)).json()) as ResolverDescription;
    expect(description.identity).toBe('agora:agent:resolver');
    expect(description.verbs).toEqual(['resolve', 'reconcile']);

    // Degraded, not broken: a well-formed id resolves to itself; a name is refused loudly.
    const resolved = (await (
      await fetch(`${base}/resolve?id=agora:agent:provider-router`)
    ).json()) as ResolvedIdentity;
    expect(resolved.authority).toBe('local');
    expect((await fetch(`${base}/resolve?name=Napoleon`)).status).toBe(400);
  });
});
