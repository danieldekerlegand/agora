/**
 * The A2A client wire, driven end to end against a fake agent-card + `message/send` endpoint.
 *
 * The fixture satisfies {@link HttpResponse} and nothing more — the same seam the live console
 * runs ({@link invokeIO}) drives both legs (agent-card GET → `message/send` POST) through it,
 * so this proves the real observed path. The Task it returns round-trips Orchestrator's exact wire
 * shape (`protocol.rs`): camelCase keys, `kind`-tagged Parts, and a kebab-case `status.state`.
 */
import { SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { a2aWire, InputRequiredError } from './a2a-wire.ts';
import type { HttpFetch } from './http.ts';
import { invokeIO, RefusedError } from './link.ts';
import { ObservationLog } from './log.ts';
import type { WireContext } from './wire.ts';

const CARD_ENDPOINT = 'https://orchestrator.example/.well-known/agent-card.json';
const SEND_TARGET = 'https://orchestrator.example/a2a';

const MANIFEST = {
  kcb_version: SPEC_VERSIONS.kcb,
  identity: 'orchestrator:agent:writer',
  endpoints: { a2a: CARD_ENDPOINT },
  auth: { budget_units: { header: 'X-Agora-Budget-Units' } },
  capabilities: [{ name: 'draft' }],
} as CapabilityManifest;

/** The Agent Card in Orchestrator's `/.well-known` shape (`protocol.rs` `AgentCard`). */
const CARD = {
  name: 'writer',
  description: 'Drafts copy',
  url: SEND_TARGET,
  version: '1.1',
  capabilities: { streaming: true },
  skills: [{ id: 'summarize', name: 'summarize', outputModes: ['text/plain'] }],
};

/** A completed Task in Orchestrator's exact wire shape — camelCase, kind-tagged Parts, kebab state. */
const COMPLETED = {
  id: 't-1',
  contextId: 'ctx-1',
  status: {
    state: 'completed',
    message: {
      role: 'agent',
      parts: [
        { kind: 'text', text: 'drafted the brief' },
        // A file by reference (digest read from the uri) and a base64 file (bytes never logged).
        { kind: 'file', file: { mimeType: 'video/mp4', uri: 'orchestrator:asset:sha256-abc123def456' } },
        { kind: 'file', file: { mimeType: 'image/png', bytes: 'iVBORw0KGgo=' } },
      ],
      messageId: 'm-2',
      contextId: 'ctx-1',
    },
    timestamp: '2026-07-23T00:00:00.000Z',
  },
  artifacts: [{ kind: 'text', name: 'draft', text: 'the full draft' }],
};

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake A2A host: a GET serves the card, a POST answers `message/send` with `result`. */
function a2aEndpoint(result: unknown, card: unknown = CARD): { fetch: HttpFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: HttpFetch = (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(init.body as string);
    calls.push({ method, url, headers: { ...(init?.headers ?? {}) }, body });
    const answer = method === 'GET' ? card : result;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: () => Promise.resolve(answer),
    });
  };
  return { fetch, calls };
}

function rpc(result: unknown): unknown {
  return { jsonrpc: '2.0', id: 1, result };
}

function context(over: Partial<WireContext> = {}): WireContext {
  return {
    manifest: MANIFEST,
    capability: { name: 'draft' },
    endpoint: CARD_ENDPOINT,
    inputs: [{ shape: 'prompt-text', value: 'draft the brief' }],
    options: {},
    budgetUnits: 5,
    ...over,
  };
}

function run(fetch: HttpFetch): { io: ReturnType<typeof invokeIO>; log: ObservationLog } {
  const log = new ObservationLog(() => '2026-07-23T00:00:00.000Z');
  const io = invokeIO({ fetch, log, identity: MANIFEST.identity }, 'draft', 'knowledge', undefined);
  return { io, log };
}

describe('the a2a wire', () => {
  it('fetches the agent card then sends message/send, normalising the completed Task', async () => {
    const { fetch, calls } = a2aEndpoint(rpc(COMPLETED));
    const { io, log } = run(fetch);

    const result = await a2aWire.invoke(context(), io);

    // Two observed legs: the agent-card GET, then the message/send POST to the card's url.
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls[0]?.url).toBe(CARD_ENDPOINT);
    expect(calls[0]?.body).toBeUndefined(); // a GET carries no body
    expect(calls[1]?.url).toBe(SEND_TARGET);

    // The request round-trips Orchestrator's shape: JSON-RPC message/send, camelCase, kind-tagged.
    const send = calls[1]?.body as { method: string; params: { message: Record<string, unknown> } };
    expect(send.method).toBe('message/send');
    expect(send.params.message.protocolVersion).toBe('1.1');
    expect(send.params.message.messageId).toEqual(expect.any(String));
    expect((send.params.message.parts as { kind: string; text: string }[])[0]).toEqual({
      kind: 'text',
      text: 'draft the brief',
    });

    // The terminal task's status.message text + artifact text; media by reference only.
    expect(result.text).toBe('drafted the brief\nthe full draft');
    expect(result.assets).toEqual([{ media_type: 'video/mp4', digest: 'sha256:abc123def456' }, { media_type: 'image/png' }]);
    expect(JSON.stringify(result.assets)).not.toContain('iVBORw0KGgo');

    // Both directions of both legs reached the ObservationLog — the observer contract.
    expect(log.entries().map((e) => e.direction)).toEqual(['request', 'response', 'request', 'response']);
  });

  it('carries the KCB §5 spend ceiling in the A2A message metadata', async () => {
    const { fetch, calls } = a2aEndpoint(rpc(COMPLETED));
    const { io } = run(fetch);
    await a2aWire.invoke(context({ budgetUnits: 12 }), io);
    const send = calls[1]?.body as { params: { message: { metadata: Record<string, unknown> } } };
    expect(send.params.message.metadata['X-Agora-Budget-Units']).toBe(12);
  });

  it('finds the JSON-RPC target from an interface when the card names no top-level url', async () => {
    const card = { name: 'writer', version: '1.1', capabilities: {}, skills: [],
      additionalInterfaces: [{ transport: 'JSONRPC', url: 'https://orchestrator.example/rpc' }] };
    const { fetch, calls } = a2aEndpoint(rpc(COMPLETED), card);
    const { io } = run(fetch);
    await a2aWire.invoke(context(), io);
    expect(calls[1]?.url).toBe('https://orchestrator.example/rpc');
  });

  it('refuses a failed task with the provider\'s own reason, not an unhandled throw', async () => {
    const failed = { ...COMPLETED, status: { state: 'failed',
      message: { role: 'agent', parts: [{ kind: 'text', text: 'the provider is unreachable' }], messageId: 'm-3' } } };
    const { fetch } = a2aEndpoint(rpc(failed));
    const { io } = run(fetch);
    const invocation = a2aWire.invoke(context(), io);
    await expect(invocation).rejects.toBeInstanceOf(RefusedError);
    await expect(invocation).rejects.toThrow(/unreachable/);
  });

  it('refuses a rejected task', async () => {
    const rejected = { ...COMPLETED, status: { state: 'rejected', message: { role: 'agent', parts: [], messageId: 'm-4' } } };
    const { fetch } = a2aEndpoint(rpc(rejected));
    const { io } = run(fetch);
    await expect(a2aWire.invoke(context(), io)).rejects.toBeInstanceOf(RefusedError);
  });

  it('surfaces an input-required task honestly rather than reporting success', async () => {
    const paused = { ...COMPLETED, status: { state: 'input-required',
      message: { role: 'agent', parts: [{ kind: 'text', text: 'which aspect ratio?' }], messageId: 'm-5' } } };
    const { fetch } = a2aEndpoint(rpc(paused));
    const { io } = run(fetch);
    const invocation = a2aWire.invoke(context(), io);
    await expect(invocation).rejects.toBeInstanceOf(InputRequiredError);
    await expect(invocation).rejects.toThrow(/which aspect ratio/);
  });

  it('surfaces a JSON-RPC error as a RefusedError', async () => {
    const { fetch } = a2aEndpoint({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad message' } });
    const { io } = run(fetch);
    const invocation = a2aWire.invoke(context(), io);
    await expect(invocation).rejects.toBeInstanceOf(RefusedError);
    await expect(invocation).rejects.toThrow(/bad message/);
  });
});
