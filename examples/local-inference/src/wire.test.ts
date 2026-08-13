/**
 * Every thin example, driven the way a peer drives it: over the wire, from the manifest out.
 *
 * Nothing here reaches inside a participant. Each one is started on an ephemeral port, its KCB
 * manifest is fetched and validated by `@agora/schemas` (the judge, not this test), the SDK
 * projects an ADDRESS out of it, and that address is dialed *directly* over whichever transport
 * it advertised — A2A's `message/send`, MCP's `initialize` → `tools/list` → `tools/call`, or
 * both. That is the entire contract an example is claiming to satisfy (ADR-0001 decisions 2-4).
 */
import { parseManifest, parseManifestBody, SPEC_VERSIONS } from '@agora/schemas';
import { addressOf, endpointFor, isDialable, transportOf } from '@agora/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeApps, EXAMPLE_APPS, startApps } from './apps.ts';
import {
  A2A_PATH,
  CARD_PATH,
  MANIFEST_PATH,
  MCP_PATH,
  MCP_PROTOCOL_VERSION,
  type StartedApp,
} from './wire.ts';

let running: StartedApp[];

beforeAll(async () => {
  // Port 0 for all of them: an ephemeral port each, so the gate never fights whatever is bound.
  running = await startApps(EXAMPLE_APPS, 0);
});

afterAll(async () => {
  await closeApps(running);
});

/** GET a URL and read it as JSON — a newcomer's client, in one line. */
async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.ok, `GET ${url}`).toBe(true);
  return response.json();
}

/** POST one JSON-RPC call and read the envelope back. */
async function rpc(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `POST ${url}`).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

describe.each(EXAMPLE_APPS.map((app) => [app.identity, app] as const))(
  '%s — a thin local-inference participant',
  (_identity, app) => {
    const started = (): StartedApp => {
      const one = running.find((candidate) => candidate.app.identity === app.identity);
      expect(one, `${app.identity} was started`).toBeDefined();
      return one as StartedApp;
    };

    it('publishes a KCB manifest a registry crawl can read', async () => {
      const manifest = parseManifestBody(await getJson(`${started().url}${MANIFEST_PATH}`));

      expect(manifest.identity).toBe(app.identity);
      expect(manifest.kcb_version).toBe(SPEC_VERSIONS.kcb);
      expect(manifest.capabilities?.map((capability) => capability.name)).toEqual([app.capability]);
      // Local inference on hardware the operator already owns: nothing is spent per call.
      expect(manifest.capabilities?.[0]?.cost?.est_units).toBe(0);
      expect(manifest.capabilities?.[0]?.outputs?.[0]).toEqual({
        plane: 'knowledge',
        shape: app.shape ?? 'text',
      });
    });

    it('advertises the endpoints it actually serves, and no others', async () => {
      const manifest = parseManifestBody(await getJson(`${started().url}${MANIFEST_PATH}`));
      const address = addressOf(manifest);

      expect(isDialable(address)).toBe(true);
      expect(Object.keys(address.endpoints).sort()).toEqual(
        ['manifest', ...app.transports].sort(),
      );
      expect(endpointFor(address)).toBeDefined();
      expect(transportOf(address)).toBe(app.transports.includes('mcp') ? 'mcp' : 'a2a');
    });

    it(
      app.transports.includes('a2a')
        ? 'serves an AgentCard carrying that manifest, and answers one A2A message/send'
        : 'serves no AgentCard, because it published no A2A endpoint',
      async () => {
        const url = started().url;
        if (!app.transports.includes('a2a')) {
          expect((await fetch(`${url}${CARD_PATH}`)).status).toBe(404);
          expect((await fetch(`${url}${A2A_PATH}`, { method: 'POST' })).status).toBe(404);
          return;
        }

        // Leg 1 — the card, and the manifest inside it, read by the schemas package.
        const card = (await getJson(`${url}${CARD_PATH}`)) as { url?: string };
        expect(parseManifest(card).identity).toBe(app.identity);
        expect(card.url).toBe(`${url}${A2A_PATH}`);

        // Leg 2 — one task, sent straight to the peer. No registry, no console, no relay.
        const envelope = await rpc(card.url as string, {
          jsonrpc: '2.0',
          id: 11,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              messageId: 'example-test-1',
              parts: [{ kind: 'text', text: 'The gate is green. Ship it.' }],
            },
          },
        });

        const result = envelope.result as {
          status: { state: string; message: { parts: { kind: string; text: string }[] } };
        };
        expect(envelope.id).toBe(11);
        expect(result.status.state).toBe('completed');
        expect(result.status.message.parts[0]?.text).toBe(app.infer('The gate is green. Ship it.'));
      },
    );

    it(
      app.transports.includes('mcp')
        ? 'answers the MCP handshake and serves its capability as the tool of that name'
        : 'serves no MCP surface, because it published no MCP endpoint',
      async () => {
        const endpoint = `${started().url}${MCP_PATH}`;
        if (!app.transports.includes('mcp')) {
          expect((await fetch(endpoint, { method: 'POST' })).status).toBe(404);
          return;
        }

        const init = await rpc(endpoint, {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'example-test', version: '0.0.0' },
          },
        });
        expect((init.result as { protocolVersion: string }).protocolVersion).toBe(
          MCP_PROTOCOL_VERSION,
        );

        // The tool a caller asks for is the capability the manifest named — nothing else to learn.
        const listed = await rpc(endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        const tools = (listed.result as { tools: { name: string }[] }).tools;
        expect(tools.map((tool) => tool.name)).toEqual([app.capability]);

        const called = await rpc(endpoint, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: app.capability, arguments: { text: 'The gate is green. Ship it.' } },
        });
        const result = called.result as { content: { type: string; text: string }[]; isError: boolean };
        expect(result.isError).toBe(false);
        expect(result.content[0]?.text).toBe(app.infer('The gate is green. Ship it.'));
      },
    );
  },
);

describe('the wire refuses what it was not asked for', () => {
  const mcpPeer = (): StartedApp => {
    const one = running.find((candidate) => candidate.app.transports.includes('mcp'));
    return one as StartedApp;
  };

  it('reports an unknown MCP tool as a tool error, not a protocol error', async () => {
    const answer = await rpc(`${mcpPeer().url}${MCP_PATH}`, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'invent.something', arguments: {} },
    });

    const result = answer.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('invent.something');
  });

  it('answers an unknown MCP method with a JSON-RPC error', async () => {
    const answer = await rpc(`${mcpPeer().url}${MCP_PATH}`, {
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/list',
    });

    expect((answer.error as { code: number }).code).toBe(-32601);
  });

  it('takes a notification without answering it (MCP notifications/initialized)', async () => {
    const response = await fetch(`${mcpPeer().url}${MCP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('404s a route no example serves', async () => {
    expect((await fetch(`${running[0]?.url}/anything`)).status).toBe(404);
  });
});
