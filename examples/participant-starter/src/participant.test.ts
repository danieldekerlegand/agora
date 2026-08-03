/**
 * The starter, driven exactly as a newcomer's peer would be: start it, fetch its AgentCard over
 * the wire, validate the KCB manifest inside it against `@agora/schemas`, project an ADDRESS out
 * of that manifest with the SDK, and dial *that address directly* for one answer.
 *
 * The dial is the two-leg A2A dance the console's `a2a` wire performs (agent-card GET → one
 * `message/send` POST), so what passes here is what a real client does — nothing in the middle,
 * because the SDK hands back an address and steps out of the way (ADR-0001 decisions 2-4).
 */
import { createRegistry, registerFromWellKnown } from '@agora/registry';
import { KCB_MANIFEST_EXTENSION_URI, parseManifest, SPEC_VERSIONS } from '@agora/schemas';
import { addressOf, endpointFor, isDialable, transportOf } from '@agora/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CAPABILITY,
  CARD_PATH,
  IDENTITY,
  MANIFEST_PATH,
  startParticipant,
  summarize,
  type StartedParticipant,
} from './participant.ts';

let peer: StartedParticipant;

beforeAll(async () => {
  // Port 0: an ephemeral port, so the gate never fights whatever is already bound.
  peer = await startParticipant(0);
});

afterAll(async () => {
  await peer.close();
});

/** GET a URL and read it as JSON — a newcomer's client, in one line. */
async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.ok, `GET ${url}`).toBe(true);
  return response.json();
}

describe('the participant starter', () => {
  it('serves an AgentCard carrying a readable KCB manifest extension', async () => {
    const card = await getJson(`${peer.url}${CARD_PATH}`);

    const manifest = parseManifest(card); // the schemas package is the judge, not this test
    expect(manifest.identity).toBe(IDENTITY);
    expect(manifest.kcb_version).toBe(SPEC_VERSIONS.kcb);
    expect(manifest.capabilities?.map((capability) => capability.name)).toEqual([CAPABILITY]);

    const extensions = (card as { capabilities?: { extensions?: { uri: string }[] } }).capabilities
      ?.extensions;
    expect(extensions?.map((extension) => extension.uri)).toEqual([KCB_MANIFEST_EXTENSION_URI]);
  });

  it('publishes an address the SDK projects and a caller dials directly', async () => {
    const manifest = parseManifest(await getJson(`${peer.url}${CARD_PATH}`));

    const address = addressOf(manifest);
    expect(isDialable(address)).toBe(true);
    expect(transportOf(address)).toBe('a2a');
    expect(endpointFor(address)).toBe(`${peer.url}${CARD_PATH}`);
  });

  it('answers one A2A message/send at the address its card advertises', async () => {
    // Leg 1 — the address the SDK handed back is where the card lives; its `url` is the target.
    const address = addressOf(parseManifest(await getJson(`${peer.url}${CARD_PATH}`)));
    const endpoint = endpointFor(address);
    expect(endpoint).toBeDefined();
    const card = (await getJson(endpoint as string)) as { url?: string };
    expect(card.url).toBe(peer.url);

    // Leg 2 — one task, sent straight to the peer. No registry, no console, no relay.
    const response = await fetch(card.url as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            messageId: 'starter-test-1',
            parts: [{ kind: 'text', text: 'A commons is a shared runtime. Everything else is detail.' }],
          },
        },
      }),
    });
    expect(response.ok).toBe(true);

    const envelope = (await response.json()) as {
      id: number;
      result: { status: { state: string; message: { parts: { kind: string; text: string }[] } } };
    };
    expect(envelope.id).toBe(7);
    expect(envelope.result.status.state).toBe('completed');
    expect(envelope.result.status.message.parts[0]?.text).toBe('A commons is a shared runtime.');
  });

  it('answers a request that carries no text without inventing one', () => {
    expect(summarize('')).toBe('nothing to summarize');
  });

  it('is discoverable: a registry crawls its manifest and hands callers its address', async () => {
    const registry = createRegistry();
    await registerFromWellKnown(registry, peer.url); // a real GET of MANIFEST_PATH

    const [match] = registry.find({ capability: CAPABILITY });
    expect(match?.identity).toBe(IDENTITY);
    // What discovery hands back is an ADDRESS. The caller dials it; the registry does not.
    expect(match?.address.endpoints.manifest).toBe(`${peer.url}${MANIFEST_PATH}`);
    expect(match?.address.endpoints.a2a).toBe(`${peer.url}${CARD_PATH}`);
    expect(match?.estUnits).toBe(0);
  });
});
