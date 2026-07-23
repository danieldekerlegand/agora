import { isCapabilityManifest, parseManifest } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import {
  CrawlError,
  createRegistry,
  PROVIDER_ROUTER_IDENTITY,
  registerProviderRouter,
  registerTrainer,
  TRAINER_IDENTITY,
  type ManifestFetch,
} from './index.ts';
import ROUTER_MANIFEST from './fixtures/provider-router.manifest.json';
import TRAINER_MANIFEST from './fixtures/trainer.manifest.json';

/**
 * `trainer.manifest.json` is the manifest the general finetune trainer publishes — captured
 * verbatim, and re-asserted against the running Python by `trainer/tests/test_manifest.py`. So
 * these tests index the trainer the registry will actually meet, not a hand-written idea of it.
 *
 * The trainer is agora's KFT `finetune` provider (KFT §2), a **distinct** leaf capability from
 * the provider-router (ADR-0001 decision 1): its own package, its own manifest, its own address.
 */
function serving(body: unknown, { ok = true, status = 200 } = {}): [ManifestFetch, string[]] {
  const urls: string[] = [];
  const fetch: ManifestFetch = (url) => {
    urls.push(url);
    return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
  };
  return [fetch, urls];
}

describe('the trainer manifest is a valid KCB manifest (schemas narrower)', () => {
  it('parses and narrows without throwing', () => {
    expect(() => parseManifest(TRAINER_MANIFEST)).not.toThrow();
    expect(isCapabilityManifest(TRAINER_MANIFEST)).toBe(true);
  });

  it('declares the finetune capability once per modality, cost metered in gpu-seconds', () => {
    const manifest = parseManifest(TRAINER_MANIFEST);
    const finetune = manifest.capabilities?.filter((c) => c.name === 'finetune') ?? [];
    expect(finetune.length).toBeGreaterThan(0);
    expect(finetune.every((c) => c.cost?.est_units !== undefined)).toBe(true);
    // `meter` rides through the narrower untouched (KFT §2 uses it in place of `unit`).
    expect(finetune.every((c) => (c.cost as { meter?: string }).meter === 'gpu-seconds')).toBe(true);
  });
});

describe('crawling the trainer’s well-known manifest (KCB §3 pull)', () => {
  it('indexes the trainer under its KINP identity', async () => {
    const registry = createRegistry();
    const [fetch] = serving(TRAINER_MANIFEST);
    const registration = await registerTrainer(registry, 'https://trainer.example', { fetch });
    expect(registration.identity).toBe(TRAINER_IDENTITY);
    expect(registration.source).toBe('pull');
    expect(registry.list().map((r) => r.identity)).toEqual([TRAINER_IDENTITY]);
  });

  it('defaults to the trainer’s own bind address — one port above the router', async () => {
    const [fetch, urls] = serving(TRAINER_MANIFEST);
    await registerTrainer(createRegistry(), undefined, { fetch });
    expect(urls[0]).toBe('http://127.0.0.1:8001/.well-known/kcb-manifest.json');
  });

  it('refuses — and does not index — a different provider at the trainer’s address', async () => {
    const registry = createRegistry();
    const [fetch] = serving(ROUTER_MANIFEST);
    await expect(
      registerTrainer(registry, 'https://trainer.example', { fetch }),
    ).rejects.toThrow(CrawlError);
    expect(registry.list()).toEqual([]);
  });
});

describe('the indexed trainer', () => {
  async function trainerIndex() {
    const registry = createRegistry();
    const [fetch] = serving(TRAINER_MANIFEST);
    await registerTrainer(registry, 'https://trainer.example', { fetch });
    return registry;
  }

  it('is discoverable by capability name `finetune`', async () => {
    const registry = await trainerIndex();
    const match = registry.find({ capability: 'finetune' })[0];
    expect(match?.identity).toBe(TRAINER_IDENTITY);
    expect(match?.capabilities.every((c) => c.name === 'finetune')).toBe(true);
  });

  it('is discoverable by modality — the §5.1 model-entity refinement on its ports', async () => {
    const registry = await trainerIndex();
    // A finetuned `model` of modality `text-generation` — what a caller routes a job to.
    const byText = registry.find({ produces: { entityType: 'text-generation' } });
    expect(byText.map((m) => m.identity)).toEqual([TRAINER_IDENTITY]);
    // Every advertised modality is findable this way.
    for (const modality of ['image-text-to-text', 'text-to-image', 'text-to-video']) {
      expect(registry.find({ produces: { entityType: modality } })).toHaveLength(1);
    }
    // A modality it does not serve finds nothing.
    expect(registry.find({ produces: { entityType: 'text-to-speech' } })).toHaveLength(0);
  });

  it('produces model weights as a media port (KFT §5.3)', async () => {
    const registry = await trainerIndex();
    const byWeights = registry.find({
      produces: { mediaType: 'application/vnd.koine.model+safetensors' },
    });
    expect(byWeights.map((m) => m.identity)).toEqual([TRAINER_IDENTITY]);
  });
});

describe('the trainer and the provider-router are separate leaf capabilities (ADR-0001 §1)', () => {
  async function bothIndexed() {
    const registry = createRegistry();
    const [routerFetch] = serving(ROUTER_MANIFEST);
    const [trainerFetch] = serving(TRAINER_MANIFEST);
    await registerProviderRouter(registry, 'https://router.example', { fetch: routerFetch });
    await registerTrainer(registry, 'https://trainer.example', { fetch: trainerFetch });
    return registry;
  }

  it('indexes both under distinct identities and distinct addresses', async () => {
    const registry = await bothIndexed();
    expect(registry.list().map((r) => r.identity).sort()).toEqual(
      [PROVIDER_ROUTER_IDENTITY, TRAINER_IDENTITY].sort(),
    );
    const routerAddress = registry.address(PROVIDER_ROUTER_IDENTITY);
    const trainerAddress = registry.address(TRAINER_IDENTITY);
    expect(routerAddress).toBeDefined();
    expect(trainerAddress).toBeDefined();
    expect(trainerAddress).not.toEqual(routerAddress);
    // Each is dialable at its own base URL — 8000 vs 8001.
    expect(trainerAddress?.endpoints.manifest).toContain('127.0.0.1:8001');
    expect(routerAddress?.endpoints.manifest).toContain('127.0.0.1:8000');
  });

  it('routes `finetune` to the trainer and `generate.text` to the router, never crossed', async () => {
    const registry = await bothIndexed();
    expect(registry.find({ capability: 'finetune' }).map((m) => m.identity)).toEqual([
      TRAINER_IDENTITY,
    ]);
    expect(registry.find({ capability: 'generate.text' }).map((m) => m.identity)).toEqual([
      PROVIDER_ROUTER_IDENTITY,
    ]);
  });
});
