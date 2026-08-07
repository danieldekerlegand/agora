/**
 * The gateway projection, held against the **real** provider-router.
 *
 * `registry/src/fixtures/provider-router.manifest.json` is a capture of what the zero-spend
 * router actually publishes, and `provider-router/tests/` asserts that capture is still current
 * — the same cross-language pin the registry uses (US-AG4). Reading it here by path means this
 * projection is tested against the router's own document rather than against a manifest written
 * to make it pass: change the router's endpoints or its `auth.budget_units` block and the pin
 * fails first, then this does.
 */
import { readFileSync } from 'node:fs';

import { parseManifestBody, type CapabilityManifest } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { BUDGET_UNITS_HEADER, openAiConfigFor } from './openai.ts';

/** The repo root — `clients/sdk/src/` is three levels down from it. */
const ROOT = new URL('../../../', import.meta.url);
const ROUTER_FIXTURE = 'registry/src/fixtures/provider-router.manifest.json';

const router: CapabilityManifest = parseManifestBody(
  JSON.parse(readFileSync(new URL(ROUTER_FIXTURE, ROOT), 'utf8')),
);

describe('openAiConfigFor — against the real router manifest', () => {
  it('hands back the base URL an OpenAI client is constructed with', () => {
    const config = openAiConfigFor(router);

    expect(config?.baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(config?.headers, 'nothing is sent that the caller did not ask for').toEqual({});
    expect(config?.model).toBeUndefined();
  });

  it('reads the model and the ceiling the router itself publishes', () => {
    const config = openAiConfigFor(router, { capability: 'generate.text', budgetUnits: 0 });

    expect(config?.baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(config?.model).toBe('placeholder-text');
    expect(config?.honorsBudgetUnits).toBe(true);
    expect(config?.budgetUnitsKey).toBe('budget_units');
    // The header name comes off the manifest, not out of this module — the router names its own.
    expect(config?.headers).toEqual({ [BUDGET_UNITS_HEADER]: '0' });
    expect(router.auth?.budget_units).toMatchObject({ header: BUDGET_UNITS_HEADER });
  });

  it('serves every generation capability the router advertises', () => {
    for (const capability of router.capabilities ?? []) {
      const config = openAiConfigFor(router, { capability: capability.name });
      expect(config?.baseUrl, capability.name).toBe('http://127.0.0.1:8000/v1');
      expect(config?.model, capability.name).toBe(capability.model);
      // Each capability endpoint really is under the base URL the config hands back.
      expect(capability.endpoint?.startsWith(`${config?.baseUrl ?? ''}/`), capability.name).toBe(
        true,
      );
    }
  });
});

describe('openAiConfigFor — what it refuses to guess', () => {
  const a2aOnly: CapabilityManifest = {
    kcb_version: router.kcb_version,
    identity: 'example:agent:summarizer',
    endpoints: { a2a: 'https://provider.example/a2a' },
    capabilities: [{ name: 'summarize.text' }],
  };

  it('returns nothing for a provider that publishes no OpenAI endpoint', () => {
    expect(openAiConfigFor(a2aOnly)).toBeUndefined();
  });

  it('returns nothing for a capability the provider does not publish', () => {
    expect(openAiConfigFor(router, { capability: 'generate.hologram' })).toBeUndefined();
  });

  it('returns nothing for a capability its OpenAI base URL does not host', () => {
    // Pointing an OpenAI client at an A2A capability would dial a protocol it cannot speak.
    const mixed: CapabilityManifest = {
      ...a2aOnly,
      endpoints: { a2a: 'https://provider.example/a2a', openai: 'https://provider.example/v1' },
      capabilities: [{ name: 'summarize.text', endpoint: 'https://provider.example/a2a' }],
    };

    expect(openAiConfigFor(mixed, { capability: 'summarize.text' })).toBeUndefined();
    expect(openAiConfigFor(mixed)?.baseUrl, 'the gateway itself is still reachable').toBe(
      'https://provider.example/v1',
    );
  });
});

describe('openAiConfigFor — the spend ceiling', () => {
  const base: CapabilityManifest = {
    kcb_version: router.kcb_version,
    identity: 'example:agent:gateway',
    endpoints: { openai: 'https://gateway.example/v1/' },
  };

  it('normalizes a trailing slash off the base URL', () => {
    expect(openAiConfigFor(base)?.baseUrl).toBe('https://gateway.example/v1');
  });

  it('does not invent a ceiling header for a provider that declared no support', () => {
    const config = openAiConfigFor(base, { budgetUnits: 5 });

    expect(config?.honorsBudgetUnits).toBe(false);
    expect(config?.headers, 'a ceiling nobody promised to honor is not silently sent').toEqual({});
    expect(config?.budgetUnitsKey).toBeUndefined();
  });

  it('uses the header the provider named, not this module’s default', () => {
    const custom: CapabilityManifest = {
      ...base,
      auth: {
        scheme: 'capability-token',
        budget_units: { supported: true, header: 'X-Spend-Ceiling', request_key: 'ceiling' },
      },
    };

    const config = openAiConfigFor(custom, { budgetUnits: 12 });
    expect(config?.headers).toEqual({ 'X-Spend-Ceiling': '12' });
    expect(config?.budgetUnitsKey).toBe('ceiling');
  });

  it('sends no ceiling when the caller asked for none', () => {
    const config = openAiConfigFor(router, { capability: 'generate.text' });
    expect(config?.headers).toEqual({});
    expect(config?.honorsBudgetUnits).toBe(true);
  });
});
