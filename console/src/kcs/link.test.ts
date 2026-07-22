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

const IDENTITY = 'analyzer:agent:pipeline';
const CAS = 'https://analyzer.example/cas';
const FOOTAGE = 'insimul:asset:blake3-a1b2c3';

const MANIFEST = {
  kcb_version: SPEC_VERSIONS.kcb,
  identity: IDENTITY,
  endpoints: {
    cas: CAS,
    subscribe: 'https://analyzer.example/subscribe',
    emit: 'https://analyzer.example/packs',
  },
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
    id: FOOTAGE,
    media_type: 'video/mp4',
    bytes: 104857600,
    source_world: 'insimul:world:alderforest',
    attaches_to: ['insimul:world:alderforest:ent:npc-renaud'],
  };

  it('gets the asset at its own id, on the address the manifest published', async () => {
    const { fetch, calls } = scripted(() => ({ body: envelope }));
    const asset = await link(fetch).fetchAsset({ step: 'footage', asset: FOOTAGE });
    expect(calls[0]?.url).toBe(`${CAS}/${encodeURIComponent(FOOTAGE)}`);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(asset).toMatchObject({ id: FOOTAGE, bytes: 104857600, present: true });
  });

  it('refuses a store that answered with a different asset — the id is the hash', async () => {
    const { fetch } = scripted(() => ({ body: { ...envelope, id: 'analyzer:asset:blake3-999' } }));
    await expect(link(fetch).fetchAsset({ step: 'footage', asset: FOOTAGE })).rejects.toThrow(
      /answered a fetch of .* with analyzer:asset:blake3-999/,
    );
  });

  it('reads a 404 as a dangling reference, not as a broken peer (delta L)', async () => {
    const { fetch } = scripted(() => ({ status: 404, body: { detail: 'not propagated yet' } }));
    const dialed = link(fetch);
    await expect(dialed.fetchAsset({ step: 'lazy', asset: FOOTAGE })).rejects.toBeInstanceOf(
      RefusedError,
    );
  });

  it('will not invent a CAS address for a provider that publishes none', async () => {
    const { fetch } = scripted(() => ({ body: {} }));
    const noCas = link(fetch, { ...MANIFEST, endpoints: { openai: 'https://analyzer.example/v1' } });
    await expect(noCas.fetchAsset({ step: 'footage', asset: FOOTAGE })).rejects.toBeInstanceOf(
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
        id: 'insimul:claim:sha256-9f3c1a',
        world: 'insimul:world:alderforest',
        subject: 'insimul:world:alderforest:ent:npc-renaud',
        relation: 'commands',
        object: 'insimul:world:alderforest:ent:army-of-ash',
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
      world: 'insimul:world:alderforest',
    });
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toEqual({
      world: 'insimul:world:alderforest',
    });
    expect(summary.frames).toBe(2);
    expect(summary.claims).toEqual(['insimul:claim:sha256-9f3c1a']);
    expect(summary.worlds).toEqual(['insimul:world:alderforest']);
  });

  it('reads SSE `data:` lines the same way', async () => {
    const { fetch } = scripted(() => ({
      headers: { get: () => 'text/event-stream' },
      text: () => Promise.resolve(`: keep-alive\ndata: ${JSON.stringify(frame)}\n\n`),
    }));
    const summary = await link(fetch).subscribe({ step: 'stream', world: 'insimul:world:alderforest' });
    expect(summary.frames).toBe(1);
  });

  it('reads a producer that answers one body with a frames array', async () => {
    const { fetch } = scripted(() => ({ body: { subscription: 'sub-7f', frames: [frame] } }));
    const summary = await link(fetch).subscribe({ step: 'stream', world: 'insimul:world:alderforest' });
    expect(summary).toMatchObject({ subscription: 'sub-7f', frames: 1 });
  });

  it('surfaces a refused subscription with the producer’s own reason (KCB §5)', async () => {
    const { fetch } = scripted(() => ({ status: 403, body: { detail: 'no subscribe:world grant' } }));
    await expect(
      link(fetch).subscribe({ step: 'stream', world: 'insimul:world:alderforest' }),
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
            id: 'insimul:claim:sha256-9f3c1a',
            world: 'insimul:world:alderforest',
            subject: 'insimul:world:alderforest:ent:npc-renaud',
            relation: 'commands',
          },
        ],
      },
    }));
    const receipt = await link(fetch).emit({
      step: 'upstream',
      pack: { kind: 'delta', worlds: ['insimul:world:alderforest'] },
    });
    expect(calls[0]?.url).toBe('https://analyzer.example/packs');
    expect(receipt).toEqual({ pack_id: 'sha256-7b1e44', claims: ['insimul:claim:sha256-9f3c1a'] });
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
