/**
 * Onboarding, end to end: a producer joins the fabric with nothing but the published SDK.
 *
 * `participant.test.ts` proves the starter is dial-able and that an *in-process* registry can
 * crawl it. This proves the part a producer outside this repo actually lives: it **pushes** its
 * manifest to a registry over the wire, is **found** by capability, dials the peer it found
 * **directly**, and points its own OpenAI client at the model gateway it discovered — using
 * `@agora/sdk` for every step, because the registry's in-process API is a workspace package no
 * consumer installs.
 *
 * Nothing here is reimplemented. The registry is the real `createRegistryServer`; the crawl is
 * the real `registerProviderRouter`; the gateway is the recorded session in
 * `console/src/fixtures/provider-router.session.json` — a capture of the real zero-spend router
 * that `provider-router/tests/` asserts is still current — replayed strictly, so a request the
 * SDK's configuration built wrong is refused with a 409 rather than answered.
 *
 * The invariant under all of it (ADR-0001 decisions 2–4): every registry exchange is a lookup,
 * and every payload goes straight to the peer. `registryCalls` records the first, so the test
 * can assert the second is true by what is *absent*.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';

import { createRegistryServer, registerProviderRouter, type RegistryService } from '@agora/registry';
import { canonicalJson, type Json } from '@agora/schemas';
import {
  createDiscoveryClient,
  openAiConfigFor,
  parseManifest,
  type DiscoveredProvider,
  type DiscoveryClient,
  type DiscoveryFetch,
} from '@agora/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CAPABILITY, CARD_PATH, IDENTITY, startParticipant, type StartedParticipant } from './participant.ts';

/** The repo root — `examples/participant-starter/src/` is three levels down from it. */
const ROOT = new URL('../../../', import.meta.url);

/** The captured session with the real router: its manifest, and the one exchange it answered. */
const SESSION = JSON.parse(
  readFileSync(new URL('console/src/fixtures/provider-router.session.json', ROOT), 'utf8'),
) as {
  captured_from: string;
  manifest: { identity: string };
  exchange: {
    path: string;
    headers: Record<string, string>;
    request: Record<string, unknown>;
    status: number;
    response: { agora: { tier: string; cost: { actual_units: number } } };
  };
};

let peer: StartedParticipant;
let registry: RegistryService;
let registryUrl: string;
let discovery: DiscoveryClient;
let router: StartedRouterReplay;

/** Every registry URL the producer dialed, in order — the control-plane side of the ledger. */
const registryCalls: string[] = [];

const recordingFetch: DiscoveryFetch = (url, init) => {
  registryCalls.push(url);
  return fetch(url, init as RequestInit);
};

beforeAll(async () => {
  peer = await startParticipant(0);
  registry = createRegistryServer();
  const bound = await registry.listen(0);
  registryUrl = `http://${bound.host}:${String(bound.port)}`;
  discovery = createDiscoveryClient(registryUrl, { fetch: recordingFetch });
  router = await startRouterReplay();
});

afterAll(async () => {
  await Promise.all([peer.close(), registry.close(), router.close()]);
});

describe('a producer publishes itself and is dialed directly', () => {
  it('checks what the registry is before publishing anything to it', async () => {
    const described = await discovery.describe();

    expect(described.identity).toBe('agora:agent:registry');
    // The producer can verify the topology it is joining — it does not have to take it on trust.
    expect(described.proxiesTraffic).toBe(false);
    expect(described.verbs).toContain('find');
  });

  it('pushes the manifest it serves and gets back the address callers will be handed', async () => {
    const card = await (await fetch(`${peer.url}${CARD_PATH}`)).json();
    const manifest = parseManifest(card);

    const published = await discovery.publish(manifest);

    expect(published.identity).toBe(IDENTITY);
    expect(published.source).toBe('push');
    expect(published.address.endpoints.a2a).toBe(`${peer.url}${CARD_PATH}`);
    // The real registry indexed it — same object the in-process API would have returned.
    expect(registry.registry.get(IDENTITY)?.source).toBe('push');
  });

  it('is then found by capability, and answers a call that never touches the registry', async () => {
    const [found] = await discovery.find({ capability: CAPABILITY });
    expect(found?.identity).toBe(IDENTITY);
    expect(found?.estUnits).toBe(0);

    const target = found?.address.endpoints.a2a;
    expect(target).toBe(`${peer.url}${CARD_PATH}`);
    const card = (await (await fetch(target as string)).json()) as { url: string };

    // The dial: straight at the peer, with the registry nowhere in the path.
    const before = registryCalls.length;
    const reply = (await (
      await fetch(card.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              messageId: 'onboarding-1',
              parts: [{ kind: 'text', text: 'A commons is a shared runtime. Everything else is detail.' }],
            },
          },
        }),
      })
    ).json()) as { result: { status: { message: { parts: { text: string }[] } } } };

    expect(reply.result.status.message.parts[0]?.text).toBe('A commons is a shared runtime.');
    expect(registryCalls.length, 'the payload leg dialed the registry zero times').toBe(before);
    expect(card.url.startsWith(peer.url)).toBe(true);
  });

  it('answers where an identity is dialed, and nothing for one it never indexed', async () => {
    expect((await discovery.address(IDENTITY))?.endpoints.a2a).toBe(`${peer.url}${CARD_PATH}`);
    expect(await discovery.address('example:agent:nobody')).toBeUndefined();
  });

  it('never dialed the registry for anything but a lookup', () => {
    const routes = [...new Set(registryCalls.map((url) => new URL(url).pathname))].sort();
    expect(routes).toEqual(['/address', '/describe', '/find', '/register']);
  });
});

describe('a producer routes its model calls through the gateway it discovered', () => {
  beforeAll(async () => {
    // The pull path, run by the registry itself against the replayed router's well-known
    // manifest — the existing crawl, not a second implementation of one.
    await registerProviderRouter(registry.registry, router.url);
  });

  it('finds the gateway by capability and configures an OpenAI client from its manifest', async () => {
    const found = await findOne('generate.text');
    expect(found.identity).toBe(SESSION.manifest.identity);

    const config = openAiConfigFor(found.manifest, { capability: 'generate.text', budgetUnits: 0 });

    expect(config?.baseUrl).toBe(`${router.url}/v1`);
    expect(config?.model).toBe(SESSION.exchange.request.model);
    expect(config?.honorsBudgetUnits).toBe(true);
    expect(config?.headers).toEqual(SESSION.exchange.headers);
    // The discovered capability's own endpoint and this base URL agree on where to dial.
    expect(found.capabilities.find((c) => c.name === 'generate.text')?.endpoint).toBe(
      `${config?.baseUrl ?? ''}${SESSION.exchange.path.replace('/v1', '')}`,
    );
  });

  it('makes the call itself, against that base URL, under a zero-unit ceiling', async () => {
    const found = await findOne('generate.text');
    const config = openAiConfigFor(found.manifest, { capability: 'generate.text', budgetUnits: 0 });

    // Exactly what an OpenAI client constructed from `config` sends. The replay refuses with a
    // 409 if the body or the ceiling header is not the one the real router was asked.
    const response = await fetch(`${config?.baseUrl ?? ''}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...config?.headers },
      body: JSON.stringify(SESSION.exchange.request),
    });

    expect(response.status).toBe(SESSION.exchange.status);
    const completion = (await response.json()) as typeof SESSION.exchange.response;
    expect(completion.agora.tier).toBe('placeholder');
    expect(completion.agora.cost.actual_units).toBe(0);
  });

  it('configures nothing for a capability the gateway does not publish', async () => {
    const found = await findOne('generate.text');
    expect(openAiConfigFor(found.manifest, { capability: CAPABILITY })).toBeUndefined();
  });

  it('was dialed only for its manifest and for the call the producer made', () => {
    expect(router.served).toEqual([
      'GET /.well-known/kcb-manifest.json', // the registry's crawl
      `POST ${SESSION.exchange.path}`, // the producer's own call, straight at the gateway
    ]);
  });
});

/** The one provider that answers a capability query — a match, or a failed expectation. */
async function findOne(capability: string): Promise<DiscoveredProvider> {
  const [found] = await discovery.find({ capability });
  expect(found, `nothing in the index serves ${capability}`).toBeDefined();
  return found as DiscoveredProvider;
}

/** A replay of the captured router, bound on an ephemeral port. */
interface StartedRouterReplay {
  url: string;
  /** Every request it was handed, as `METHOD path`. */
  readonly served: string[];
  close(): Promise<void>;
}

/**
 * Serve the captured session at this process's own address.
 *
 * The capture was taken from `127.0.0.1:8000`; a deployed router publishes whatever
 * `AGORA_PUBLIC_BASE_URL` says, so re-pointing the captured manifest at the bound port is the
 * substitution the router itself performs — every other byte of it is the router's.
 */
async function startRouterReplay(): Promise<StartedRouterReplay> {
  const served: string[] = [];
  const server: Server = createServer((req, res) => {
    void replay(req, res, served, () => manifest);
  });
  const bound = await listen(server);
  const url = `http://127.0.0.1:${String(bound.port)}`;
  const manifest: unknown = JSON.parse(
    JSON.stringify(SESSION.manifest).split(SESSION.captured_from).join(url),
  );
  return {
    url,
    served,
    close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
  };
}

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address() as AddressInfo));
  });
}

/** The captured exchange, answered only for the request that was actually captured. */
async function replay(
  req: IncomingMessage,
  res: ServerResponse,
  served: string[],
  manifest: () => unknown,
): Promise<void> {
  const path = req.url ?? '/';
  served.push(`${req.method ?? 'GET'} ${path}`);
  if (path === '/.well-known/kcb-manifest.json') return json(res, 200, manifest());

  if (req.method === 'POST' && path === SESSION.exchange.path) {
    const [header, expected] = Object.entries(SESSION.exchange.headers)[0] as [string, string];
    if (req.headers[header.toLowerCase()] !== expected) {
      return json(res, 409, { detail: `the capture carries ${header}: ${expected}` });
    }
    const body = await read(req);
    if (canonicalJson(JSON.parse(body) as Json) !== canonicalJson(SESSION.exchange.request as Json)) {
      return json(res, 409, { detail: `the capture does not cover this request: ${body}` });
    }
    return json(res, SESSION.exchange.status, SESSION.exchange.response);
  }

  json(res, 404, { detail: `nothing captured at ${path}` });
}

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
