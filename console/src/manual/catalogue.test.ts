import { createRegistry } from '@agora/registry';
import type { Json } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import routerSession from '../fixtures/provider-router.session.json';
import { bundledStandins } from '../fixtures/standins.ts';
import { SAMPLE_PROVIDER } from '../fixtures/standins.ts';
import { catalogue, describePort, fieldsFor } from './catalogue.ts';

const ROUTER = (routerSession as { manifest: unknown }).manifest;

function indexed(): ReturnType<typeof createRegistry> {
  const registry = createRegistry();
  registry.register(ROUTER, { source: 'pull' });
  return registry;
}

describe('the capability catalogue', () => {
  it('lists what a registered provider advertises, with the address the caller dials', () => {
    const [provider] = catalogue({ registry: indexed() });
    expect(provider?.identity).toBe('agora:agent:provider-router');
    expect(provider?.verbs).toContain('invoke');
    const text = provider?.capabilities.find((entry) => entry.name === 'generate.text');
    // The manifest's own address, handed straight through: the registry answers with an
    // address and the caller dials it (ADR-0001 decision 3).
    expect(text?.endpoint).toBe('http://127.0.0.1:8000/v1/chat/completions');
    expect(text?.planes).toEqual(['knowledge']);
    expect(text?.estUnits).toBe(0);
    expect(text?.unpriced).toBe(false);
  });

  it('spans planes on one capability — a knowledge input with a media output (§2.1)', () => {
    const [provider] = catalogue({ registry: indexed() });
    const image = provider?.capabilities.find((entry) => entry.name === 'generate.image');
    expect(image?.planes).toEqual(['knowledge', 'media']);
  });

  it('offers no fetch verb to a provider that publishes no CAS address', () => {
    // Offering it would compose a request whose only possible answer is NoAddressError.
    const [provider] = catalogue({ registry: indexed() });
    expect(provider?.verbs).not.toContain('fetch');
  });

  it('catalogues a peer that has not adopted the bus, and stamps it as a stand-in', () => {
    const providers = catalogue({ registry: createRegistry(), standins: bundledStandins() });
    const consumer = providers.find((entry) => entry.identity === 'consumer:agent:composer');
    expect(consumer?.standin).toBe(SAMPLE_PROVIDER);
    expect(consumer?.capabilities.map((entry) => entry.name)).toEqual(['compose']);
  });

  it('prefers the registration over a fixture of the same identity', () => {
    // The runner makes the same choice (`kcs/runner.ts`). Browsing a fixture for a provider
    // that is on the network would read its canned answer as the fabric's.
    const registry = createRegistry();
    registry.register(
      { kcb_version: '0.4.3', identity: 'consumer:agent:composer', endpoints: {}, capabilities: [] },
      { source: 'push' },
    );
    const providers = catalogue({ registry, standins: bundledStandins() });
    const consumer = providers.filter((entry) => entry.identity === 'consumer:agent:composer');
    expect(consumer).toHaveLength(1);
    expect(consumer[0]?.standin).toBeUndefined();
  });

  it('skips a fixture that publishes no manifest rather than failing the catalogue', () => {
    const standins: Record<string, Json> = { 'fixtures/nothing.json': { invoke: {} } };
    expect(catalogue({ registry: createRegistry(), standins })).toEqual([]);
  });
});

describe('the form a port schema generates', () => {
  it('makes one field per declared input port, labelled with the port’s own type', () => {
    const [provider] = catalogue({ registry: indexed() });
    const text = provider?.capabilities.find((entry) => entry.name === 'generate.text');
    const fields = fieldsFor(text!);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.label).toBe('knowledge · shape chat-messages');
  });

  it('asks for a KINP id on the planes that reference rather than inline (§3)', () => {
    expect(
      fieldsFor({
        provider: 'x:agent:y',
        name: 'c',
        inputs: [
          { plane: 'media', media_types: ['video/mp4'] },
          { plane: 'entity', types: ['person'] },
          { plane: 'knowledge', shape: 'chat-messages' },
        ],
        outputs: [],
        planes: ['media', 'entity', 'knowledge'],
        unpriced: true,
      }).map((field) => field.entry),
    ).toEqual(['ref', 'ref', 'value']);
  });

  it('prefills nothing — a skeleton payload would be the console authoring the traffic', () => {
    const [provider] = catalogue({ registry: indexed() });
    for (const field of fieldsFor(provider!.capabilities[0]!)) {
      expect(field.placeholder).not.toBe('');
      expect(Object.keys(field)).not.toContain('value');
    }
  });

  it('describes each plane by what that plane types by', () => {
    expect(describePort({ plane: 'media', media_types: ['audio/wav'], world_pattern: '*' })).toBe(
      'media · audio/wav · worlds *',
    );
    expect(describePort({ plane: 'entity', types: ['person', 'work'] })).toBe(
      'entity · person, work',
    );
    expect(describePort({ plane: 'knowledge' })).toBe('knowledge');
  });
});
