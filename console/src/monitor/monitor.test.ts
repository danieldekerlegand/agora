import { createRegistry } from '@agora/registry';
import type { CapabilityManifest, Json } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { monitorStandins, MONITOR_PROCESSOR, MONITOR_PRODUCER } from '../fixtures/standins.ts';
import type { HttpFetch } from '../kcs/http.ts';
import { describeMonitor, FabricMonitor, subscribeAddress, worldsIn } from './monitor.ts';

/** A provider that serves the subscribe verb — the only kind the monitor can watch live. */
const PRODUCER: CapabilityManifest = {
  kcb_version: '0.4.3',
  identity: 'processor:agent:live',
  endpoints: { subscribe: 'https://processor.example/subscribe' },
  capabilities: [
    {
      name: 'ingest.observe',
      outputs: [{ plane: 'knowledge', worlds: ['producer:world:sample'] }],
    },
  ],
};

/** A provider with no stream — an address it never published must never be invented. */
const SILENT: CapabilityManifest = {
  kcb_version: '0.4.3',
  identity: 'agora:agent:provider-router',
  endpoints: { openai: 'https://router.example/v1' },
  capabilities: [],
};

/** One NDJSON delta, served at the address the manifest published and nowhere else. */
function streamingFetch(dialed: string[]): HttpFetch {
  return (url, init) => {
    dialed.push(`${init?.method ?? 'GET'} ${url}`);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/x-ndjson' },
      json: () => Promise.resolve({}),
      text: () =>
        Promise.resolve(
          JSON.stringify({
            kind: 'delta',
            assertions: [
              {
                id: 'processor:claim:sha256-live',
                world: 'producer:world:sample',
                subject: 'processor:asset:blake3-live',
                relation: 'depicts',
                object: 'producer:world:sample:ent:item-alpha',
              },
            ],
          }),
        ),
    });
  };
}

function registryOf(...manifests: CapabilityManifest[]) {
  const registry = createRegistry();
  for (const manifest of manifests) registry.register(manifest, { source: 'pull' });
  return registry;
}

const at = () => '2026-07-22T11:05:00.000Z';

describe('what the monitor is', () => {
  it('has no verb that could originate work on the fabric', () => {
    // The passivity invariant, asserted rather than merely written down — the same shape as
    // the registry's "never proxies" (ADR-0001 decision 3 / decision 7).
    const methods = Object.getOwnPropertyNames(FabricMonitor.prototype).filter(
      (name) => name !== 'constructor',
    );
    for (const forbidden of ['invoke', 'emit', 'fetchAsset', 'proxy', 'relay', 'send']) {
      expect(methods).not.toContain(forbidden);
    }
    expect(describeMonitor()).toMatchObject({
      verbs: ['subscribe'],
      proxiesTraffic: false,
      originatesTraffic: false,
      controlPlane: 'emitted-telemetry-only',
    });
  });

  it('states the control-plane limitation it operates under', () => {
    expect(describeMonitor().limitation).toMatch(/emits none is absent at the invoke level/);
    expect(describeMonitor().limitation).toMatch(/koine emitted-telemetry contract/);
  });
});

describe('choosing what to watch', () => {
  it('watches a provider at the subscribe address it published, and dials no other', async () => {
    const dialed: string[] = [];
    const monitor = new FabricMonitor({
      registry: registryOf(PRODUCER),
      fetch: streamingFetch(dialed),
      now: at,
    });
    expect(monitor.sources()).toEqual([
      {
        identity: 'processor:agent:live',
        worlds: ['producer:world:sample'],
        endpoint: 'https://processor.example/subscribe',
        emitsTelemetry: false,
      },
    ]);
    await monitor.sweep();
    expect(dialed).toEqual(['POST https://processor.example/subscribe']);
  });

  it('reports a provider with no stream instead of guessing an address for it', () => {
    const monitor = new FabricMonitor({ registry: registryOf(SILENT), fetch: streamingFetch([]) });
    expect(monitor.sources()).toHaveLength(0);
    expect(monitor.unwatched()[0]).toMatch(/publishes no subscribe address/);
  });

  it('reads a live delta into the feed, linked to its ids', async () => {
    const monitor = new FabricMonitor({
      registry: registryOf(PRODUCER),
      fetch: streamingFetch([]),
      now: at,
    });
    const sweep = await monitor.sweep();
    expect(sweep.frames).toBeGreaterThan(0);
    const [claim] = monitor.events();
    expect(claim?.kind).toBe('claim');
    expect(claim?.participant).toBe('processor:agent:live');
    expect(claim?.standin).toBe(false);
    expect(claim?.ids).toContain('producer:world:sample:ent:item-alpha');
  });

  it('carries discovery’s own problems into the one panel that shows them', () => {
    const monitor = new FabricMonitor({
      registry: createRegistry(),
      fetch: streamingFetch([]),
      problems: ['provider-router at http://127.0.0.1:8080: fetch failed'],
    });
    expect(monitor.unwatched()).toEqual(['provider-router at http://127.0.0.1:8080: fetch failed']);
  });

  it('narrows the watch to the worlds it was configured with', () => {
    const monitor = new FabricMonitor({
      registry: registryOf(PRODUCER),
      fetch: streamingFetch([]),
      worlds: ['producer:world:elsewhere'],
    });
    expect(monitor.sources()[0]?.worlds).toEqual([]);
  });

  it('prefers a registration to a fixture of the same identity', () => {
    const live: CapabilityManifest = { ...PRODUCER, identity: 'processor:agent:ingest' };
    const monitor = new FabricMonitor({
      registry: registryOf(live),
      fetch: streamingFetch([]),
      standins: monitorStandins(),
    });
    const processor = monitor.sources().find((source) => source.identity === 'processor:agent:ingest');
    expect(processor?.standin).toBeUndefined();
    expect(processor?.endpoint).toBe('https://processor.example/subscribe');
  });
});

describe('a sweep over the peers that have not adopted the bus', () => {
  const watching = (): FabricMonitor =>
    new FabricMonitor({
      registry: createRegistry(),
      fetch: streamingFetch([]),
      standins: monitorStandins(),
      now: at,
    });

  it('shows events from platform-to-platform traffic the console never initiated', async () => {
    const monitor = watching();
    await monitor.sweep();
    const events = monitor.events();
    // An ingest claim + media event from Processor, an exchange Consumer had with Processor, and a
    // world delta from Producer — not one of which this console asked for.
    expect(events.map((event) => event.kind)).toEqual(['claim', 'asset', 'span', 'claim']);
    expect(new Set(events.map((event) => event.participant))).toEqual(
      new Set(['producer:agent:publisher', 'processor:agent:ingest']),
    );
    expect(events.every((event) => event.standin)).toBe(true);
  });

  it('renders an exchange between two other peers when the server emitted telemetry', async () => {
    const monitor = watching();
    await monitor.sweep();
    const span = monitor.events().find((event) => event.kind === 'span');
    expect(span?.summary).toContain('consumer:agent:composer → processor:agent:ingest');
    expect(span?.plane).toBe('control');
    expect(span?.world).toBe('producer:world:sample');
  });

  it('marks which peers emit telemetry and which are therefore invisible at the invoke level', async () => {
    const monitor = watching();
    await monitor.sweep();
    const emitting = Object.fromEntries(
      monitor.sources().map((source) => [source.standin, source.emitsTelemetry]),
    );
    expect(emitting[MONITOR_PROCESSOR]).toBe(true);
    // The documented limitation, visible: Producer publishes deltas and no telemetry, so its
    // invocations simply are not in the feed. That is the contract's gap, not a failure.
    expect(emitting[MONITOR_PRODUCER]).toBe(false);
  });

  it('accumulates across sweeps rather than replacing what is on screen', async () => {
    const monitor = watching();
    const first = await monitor.sweep();
    const second = await monitor.sweep();
    expect(second.events).toHaveLength(first.events.length);
    expect(monitor.events()).toHaveLength(first.events.length + second.events.length);
  });

  it('records a stream that will not open as a problem, and keeps watching the rest', async () => {
    const refusing: Record<string, Json> = {
      ...monitorStandins(),
      'fixtures/monitor/broken.json': { identity: 'consumer:agent:composer', subscribe: {} },
    };
    const monitor = new FabricMonitor({
      registry: createRegistry(),
      fetch: streamingFetch([]),
      standins: refusing,
      now: at,
    });
    // An empty `subscribe` section declares no world, so the sweep asks for the whole stream —
    // which the fixture does not cover, and an uncovered call is loud rather than empty.
    const sweep = await monitor.sweep();
    expect(sweep.problems.join(' ')).toMatch(/consumer:agent:composer/);
    expect(monitor.events().length).toBeGreaterThan(0);
  });
});

describe('reading a manifest for what to subscribe to', () => {
  it('takes the address the provider published, in the order KCB names it', () => {
    expect(subscribeAddress(PRODUCER)).toBe('https://processor.example/subscribe');
    expect(subscribeAddress(SILENT)).toBeUndefined();
  });

  it('collects concrete worlds and refuses to expand a pattern into one', () => {
    // KCB delta J: `world_pattern` is a pattern. `producer:world:*` names no world a consumer
    // can register for, and turning it into one would subscribe to a world that may not exist.
    const registry = registryOf({
      ...PRODUCER,
      capabilities: [
        {
          name: 'ingest.observe',
          inputs: [{ plane: 'media', media_types: ['video/mp4'], world_pattern: 'producer:world:*' }],
          outputs: [{ plane: 'knowledge', worlds: ['producer:world:sample'] }],
        },
      ],
    });
    const [registration] = registry.list();
    expect(registration && worldsIn(registration)).toEqual(['producer:world:sample']);
  });
});
