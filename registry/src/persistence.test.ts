import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderAddress } from '@agora/kcb-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDurableRegistry,
  createFileStore,
  createRegistryServer,
  PROVIDER_ROUTER_IDENTITY,
  type Match,
  type Registration,
  type RegistryService,
} from './index.ts';
import ROUTER_MANIFEST from './fixtures/provider-router.manifest.json';
import { NARRATOR } from './fixtures/providers.ts';

/**
 * Durable persistence behind the index (capability-bus.md §3): a registration survives a
 * process restart byte-for-byte, so a rehydrated index is the same records — same sequence,
 * same frozen manifest — with no re-crawl, and `remove` deletes from the store too.
 */
describe('durable manifest persistence behind the index', () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agora-registry-'));
    storePath = join(dir, 'index.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot(): Promise<{ service: RegistryService; base: string }> {
    const service = createRegistryServer({ store: createFileStore(storePath) });
    const { host, port } = await service.listen();
    return { service, base: `http://${host}:${port}` };
  }

  function register(base: string, manifest: unknown): Promise<Response> {
    return fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manifest),
    });
  }

  it('rehydrates two providers across a restart — same records, no re-crawl', async () => {
    const first = await boot();
    await register(first.base, ROUTER_MANIFEST);
    await register(first.base, NARRATOR);
    const before = (await (await fetch(`${first.base}/list`)).json()) as Registration[];
    await first.service.close();

    // A brand-new service against the same path — nothing re-registered, nothing crawled.
    const second = await boot();
    const after = (await (await fetch(`${second.base}/list`)).json()) as Registration[];
    expect(after).toEqual(before);
    expect(after.map((r) => r.sequence)).toEqual([1, 2]);
    expect(after.every((r) => r.source === 'push')).toBe(true);

    const matches = (await (
      await fetch(`${second.base}/find?capability=generate.text`)
    ).json()) as Match[];
    expect(matches[0]?.identity).toBe(PROVIDER_ROUTER_IDENTITY);
    expect(matches[0]?.registration.sequence).toBe(1);

    const address = (await (
      await fetch(`${second.base}/address?identity=${PROVIDER_ROUTER_IDENTITY}`)
    ).json()) as ProviderAddress;
    expect(address.identity).toBe(PROVIDER_ROUTER_IDENTITY);
    await second.service.close();
  });

  it('re-registers in place after restart, keeping the original sequence', async () => {
    const first = await boot();
    await register(first.base, ROUTER_MANIFEST);
    await register(first.base, NARRATOR);
    await first.service.close();

    const second = await boot();
    // Re-push the first provider — a redeploy is not a new provider (sequence stays 1).
    const re = (await (await register(second.base, ROUTER_MANIFEST)).json()) as Registration;
    expect(re.sequence).toBe(1);
    const list = (await (await fetch(`${second.base}/list`)).json()) as Registration[];
    expect(list.map((r) => r.sequence)).toEqual([1, 2]);
    await second.service.close();
  });

  it('remove() deletes from the durable store — gone after restart', async () => {
    const first = await boot();
    await register(first.base, ROUTER_MANIFEST);
    await register(first.base, NARRATOR);
    await fetch(`${first.base}/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: PROVIDER_ROUTER_IDENTITY }),
    });
    await first.service.close();

    const second = await boot();
    const list = (await (await fetch(`${second.base}/list`)).json()) as Registration[];
    expect(list.map((r) => r.identity)).toEqual([NARRATOR.identity]);
    expect((await fetch(`${second.base}/address?identity=${PROVIDER_ROUTER_IDENTITY}`)).status).toBe(
      404,
    );
    await second.service.close();
  });

  it('a rehydrated record is still frozen against mutation', () => {
    createDurableRegistry(createFileStore(storePath)).register(ROUTER_MANIFEST, { source: 'push' });

    const reloaded = createDurableRegistry(createFileStore(storePath));
    const record = reloaded.get(PROVIDER_ROUTER_IDENTITY);
    expect(record).toBeDefined();
    expect(Object.isFrozen(record?.manifest)).toBe(true);
    expect(() => {
      (record?.manifest as unknown as { identity: string }).identity = 'agora:agent:impostor';
    }).toThrow(TypeError);
  });
});
