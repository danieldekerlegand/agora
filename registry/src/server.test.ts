import type { ProviderAddress } from '@agora/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRegistryServer,
  PROVIDER_ROUTER_IDENTITY,
  TRAINER_IDENTITY,
  type Match,
  type ProviderSelection,
  type RegistryDescription,
  type Registration,
  type RegistryService,
} from './index.ts';
import { SPECIALIZED_FINETUNE } from './fixtures/providers.ts';
import ROUTER_MANIFEST from './fixtures/provider-router.manifest.json';
import TRAINER_MANIFEST from './fixtures/trainer.manifest.json';

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

  /**
   * `describeRegistry` has always named `selectFinetune`; without a route it was reachable only
   * by importing the package, which the Python trainer's dataset bridge — or any non-TypeScript
   * producer — cannot do. The FT-K precedence stays in `select.ts`: this is the same verdict,
   * over the wire.
   */
  describe('selectFinetune over the wire (KFT §8/FT-K)', () => {
    async function select(job: unknown): Promise<Response> {
      return fetch(`${base}/finetune/select`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job),
      });
    }

    beforeEach(async () => {
      await register(TRAINER_MANIFEST);
      await register(SPECIALIZED_FINETUNE);
    });

    it('prefers the specialized provider and hands back its dialable address', async () => {
      const response = await select({ modality: 'text-generation', method: 'lora' });
      expect(response.status).toBe(200);
      const selection = (await response.json()) as Extract<
        ProviderSelection,
        { outcome: 'selected' }
      >;
      expect(selection.outcome).toBe('selected');
      expect(selection.reason).toBe('specialized');
      expect(selection.provider.identity).toBe('pinakes:agent:finetune');
      // Discovery, not routing — the caller dials this, the registry never relays.
      expect(selection.provider.capabilities[0]?.endpoint).toBeTruthy();
    });

    it('falls through to the general trainer for a method the specialist does not serve', async () => {
      const selection = (await (
        await select({ modality: 'text-generation', method: 'dpo' })
      ).json()) as ProviderSelection;
      expect(selection.outcome).toBe('selected');
      if (selection.outcome !== 'selected') return;
      expect(selection.provider.identity).toBe(TRAINER_IDENTITY);
    });

    it('honors an explicit target, and answers `none` when nothing serves the job', async () => {
      const explicit = (await (
        await select({ modality: 'text-generation', method: 'lora', provider: TRAINER_IDENTITY })
      ).json()) as ProviderSelection;
      expect(explicit.outcome).toBe('selected');
      if (explicit.outcome === 'selected') expect(explicit.reason).toBe('explicit');

      const none = (await (
        await select({ modality: 'speech-to-speech' })
      ).json()) as ProviderSelection;
      expect(none.outcome).toBe('none');
    });

    it('reads an empty body as an unconstrained query rather than erroring', async () => {
      const response = await fetch(`${base}/finetune/select`, { method: 'POST' });
      expect(response.status).toBe(200);
    });
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
