/**
 * The live data-plane verbs, at the socket.
 *
 * The stand-in suite proves the runner and the assertions; this one proves the half that
 * only exists against a real peer: the URL a CAS GET is built from, the integrity check
 * that the id *is* the hash, a dangling reference read as dangling rather than as an
 * outage, and a delta stream read whichever way the producer frames it.
 *
 * Nothing is dialed that the registry did not hand back — the manifest below is the only
 * source of an address anywhere in this file, which is ADR-0001 decision 3 stated as a
 * test rather than as a comment.
 */
import { createRegistry, type Registration } from '@agora/registry';
import { SPEC_VERSIONS } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import type { HttpFetch, HttpRequestInit, HttpResponse } from './http.ts';
import { NoAddressError, openLink, RefusedError } from './link.ts';
import { ObservationLog } from './log.ts';

const IDENTITY = 'processor:agent:pipeline';
const CAS = 'https://processor.example/cas';
const RECORDING = 'producer:asset:blake3-a1b2c3';

const MANIFEST = {
  kcb_version: SPEC_VERSIONS.kcb,
  identity: IDENTITY,
  endpoints: {
    cas: CAS,
    subscribe: 'https://processor.example/subscribe',
    emit: 'https://processor.example/packs',
  },
};

/** An mcp-only provider — the console must open the mcp wire, not throw (US-4). */
const MCP_MANIFEST = {
  kcb_version: SPEC_VERSIONS.kcb,
  identity: 'processor:agent:filmstudio',
  endpoints: { mcp: 'https://processor.example/mcp' },
  capabilities: [{ name: 'run_pipeline' }],
};

/** An a2a-only provider — the console must open the a2a wire, not throw (US-4). */
const A2A_MANIFEST = {
  kcb_version: SPEC_VERSIONS.kcb,
  identity: 'orchestrator:agent:writer',
  endpoints: { a2a: 'https://orchestrator.example/.well-known/agent-card.json' },
  capabilities: [{ name: 'draft' }],
};

interface Call {
  url: string;
  init?: HttpRequestInit | undefined;
}

function scripted(
  answer: (url: string, init?: HttpRequestInit) => Partial<HttpResponse> & { body?: unknown },
): { fetch: HttpFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: HttpFetch = (url, init) => {
    calls.push({ url, init });
    const { body, ...rest } = answer(url, init);
    const status = rest.status ?? 200;
    return Promise.resolve({
      ok: rest.ok ?? status < 400,
      status,
      headers: rest.headers ?? { get: () => null },
      json: () => Promise.resolve(body),
      ...(rest.text === undefined ? {} : { text: rest.text }),
    });
  };
  return { fetch, calls };
}

function link(fetch: HttpFetch, manifest: unknown = MANIFEST): ReturnType<typeof openLink> {
  const registration: Registration = createRegistry().register(manifest);
  return openLink(registration, { fetch, log: new ObservationLog(() => '2026-07-22T00:00:00.000Z') });
}

describe('fetch — a CAS GET by asset id (KCB §4 delta G)', () => {
  const envelope = {
    id: RECORDING,
    media_type: 'video/mp4',
    bytes: 104857600,
    source_world: 'producer:world:sample',
    attaches_to: ['producer:world:sample:ent:item-alpha'],
  };

  it('gets the asset at its own id, on the address the manifest published', async () => {
    const { fetch, calls } = scripted(() => ({ body: envelope }));
    const asset = await link(fetch).fetchAsset({ step: 'recording', asset: RECORDING });
    expect(calls[0]?.url).toBe(`${CAS}/${encodeURIComponent(RECORDING)}`);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(asset).toMatchObject({ id: RECORDING, bytes: 104857600, present: true });
  });

  it('refuses a store that answered with a different asset — the id is the hash', async () => {
    const { fetch } = scripted(() => ({ body: { ...envelope, id: 'processor:asset:blake3-999' } }));
    await expect(link(fetch).fetchAsset({ step: 'recording', asset: RECORDING })).rejects.toThrow(
      /answered a fetch of .* with processor:asset:blake3-999/,
    );
  });

  it('reads a 404 as a dangling reference, not as a broken peer (delta L)', async () => {
    const { fetch } = scripted(() => ({ status: 404, body: { detail: 'not propagated yet' } }));
    const dialed = link(fetch);
    await expect(dialed.fetchAsset({ step: 'lazy', asset: RECORDING })).rejects.toBeInstanceOf(
      RefusedError,
    );
  });

  it('will not invent a CAS address for a provider that publishes none', async () => {
    const { fetch } = scripted(() => ({ body: {} }));
    const noCas = link(fetch, { ...MANIFEST, endpoints: { openai: 'https://processor.example/v1' } });
    await expect(noCas.fetchAsset({ step: 'recording', asset: RECORDING })).rejects.toBeInstanceOf(
      NoAddressError,
    );
  });
});

describe('subscribe — collecting the delta stream (KCB §4, KGP §6)', () => {
  const frame = {
    pack_id: 'sha256-de17a0',
    kind: 'delta',
    assertions: [
      {
        id: 'producer:claim:sha256-9f3c1a',
        world: 'producer:world:sample',
        subject: 'producer:world:sample:ent:item-alpha',
        relation: 'contains',
        object: 'producer:world:sample:ent:assembly-alpha',
      },
    ],
  };

  it('reads NDJSON frames, which `json()` could never parse', async () => {
    const { fetch, calls } = scripted(() => ({
      headers: { get: (name) => (name === 'content-type' ? 'application/x-ndjson' : null) },
      text: () => Promise.resolve(`${JSON.stringify(frame)}\n${JSON.stringify(frame)}\n`),
    }));
    const summary = await link(fetch).subscribe({
      step: 'stream',
      world: 'producer:world:sample',
    });
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toEqual({
      world: 'producer:world:sample',
    });
    expect(summary.frames).toBe(2);
    expect(summary.claims).toEqual(['producer:claim:sha256-9f3c1a']);
    expect(summary.worlds).toEqual(['producer:world:sample']);
  });

  it('reads SSE `data:` lines the same way', async () => {
    const { fetch } = scripted(() => ({
      headers: { get: () => 'text/event-stream' },
      text: () => Promise.resolve(`: keep-alive\ndata: ${JSON.stringify(frame)}\n\n`),
    }));
    const summary = await link(fetch).subscribe({ step: 'stream', world: 'producer:world:sample' });
    expect(summary.frames).toBe(1);
  });

  it('reads a producer that answers one body with a frames array', async () => {
    const { fetch } = scripted(() => ({ body: { subscription: 'sub-7f', frames: [frame] } }));
    const summary = await link(fetch).subscribe({ step: 'stream', world: 'producer:world:sample' });
    expect(summary).toMatchObject({ subscription: 'sub-7f', frames: 1 });
  });

  it('surfaces a refused subscription with the producer’s own reason (KCB §5)', async () => {
    const { fetch } = scripted(() => ({ status: 403, body: { detail: 'no subscribe:world grant' } }));
    await expect(
      link(fetch).subscribe({ step: 'stream', world: 'producer:world:sample' }),
    ).rejects.toThrow(/no subscribe:world grant/);
  });
});

describe('emit — writing knowledge into the fabric (KGP §2)', () => {
  it('posts the pack and reports what the producer minted', async () => {
    const { fetch, calls } = scripted(() => ({
      body: {
        pack_id: 'sha256-7b1e44',
        assertions: [
          {
            id: 'producer:claim:sha256-9f3c1a',
            world: 'producer:world:sample',
            subject: 'producer:world:sample:ent:item-alpha',
            relation: 'contains',
          },
        ],
      },
    }));
    const receipt = await link(fetch).emit({
      step: 'upstream',
      pack: { kind: 'delta', worlds: ['producer:world:sample'] },
    });
    expect(calls[0]?.url).toBe('https://processor.example/packs');
    expect(receipt).toEqual({ pack_id: 'sha256-7b1e44', claims: ['producer:claim:sha256-9f3c1a'] });
  });
});

describe('invoke — opening the mcp/a2a wires a peer advertises (US-4)', () => {
  function dialed(
    manifest: unknown,
    fetch: HttpFetch,
  ): { peer: ReturnType<typeof openLink>; log: ObservationLog } {
    const log = new ObservationLog(() => '2026-07-22T00:00:00.000Z');
    const registration: Registration = createRegistry().register(manifest);
    return { peer: openLink(registration, { fetch, log }), log };
  }

  it('opens the mcp wire for an mcp-only provider and records every leg', async () => {
    // A fake `/mcp` answering the JSON-RPC handshake initialize → tools/list → tools/call.
    const { fetch } = scripted((_url, init) => {
      const body = JSON.parse((init?.body ?? '{}') as string) as { id: number; method: string };
      switch (body.method) {
        case 'initialize':
          return { body: { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'filmstudio' } } } };
        case 'tools/list':
          return { body: { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'run_pipeline' }] } } };
        default:
          return { body: { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'a one-minute film' }] } } };
      }
    });
    const { peer, log } = dialed(MCP_MANIFEST, fetch);
    const result = await peer.invoke({
      step: 'compose',
      capability: 'run_pipeline',
      inputs: [{ plane: 'knowledge', shape: 'prompt-text', value: 'a film about a lighthouse' }],
      options: {},
    });
    expect(peer.note).toMatch(/dialed directly over the mcp wire/);
    expect(result.text).toBe('a one-minute film');
    // initialize → tools/list → tools/call, both directions each — six observed legs.
    expect(log.entries().map((e) => e.direction)).toEqual([
      'request', 'response', 'request', 'response', 'request', 'response',
    ]);
  });

  it('opens the a2a wire for an a2a-only provider and records every leg', async () => {
    // A fake A2A host: a GET serves the card, a POST answers message/send with a completed Task.
    const { fetch } = scripted((_url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return { body: { name: 'writer', version: '1.1', url: 'https://orchestrator.example/a2a' } };
      }
      return { body: { jsonrpc: '2.0', id: 1, result: { id: 't-1', status: { state: 'completed', message: { role: 'agent', parts: [{ kind: 'text', text: 'drafted the brief' }], messageId: 'm-1' } } } } };
    });
    const { peer, log } = dialed(A2A_MANIFEST, fetch);
    const result = await peer.invoke({
      step: 'draft',
      capability: 'draft',
      inputs: [{ plane: 'knowledge', shape: 'prompt-text', value: 'draft the brief' }],
      options: {},
    });
    expect(peer.note).toMatch(/dialed directly over the a2a wire/);
    expect(result.text).toBe('drafted the brief');
    // agent-card GET → message/send POST, both directions each — four observed legs.
    expect(log.entries().map((e) => e.direction)).toEqual([
      'request', 'response', 'request', 'response',
    ]);
  });
});

describe('what a link will not do', () => {
  it('opens against a provider with no invocable wire, because a CAS is a participant too', () => {
    // Eagerly resolving the wire would refuse to open a link to a data-plane-only peer —
    // which would make `fetch` unreachable for exactly the providers that serve it.
    const { fetch } = scripted(() => ({ body: {} }));
    expect(link(fetch).wire).toBeUndefined();
    expect(link(fetch).note).toMatch(/dialed directly at cas, subscribe, emit/);
  });
});
