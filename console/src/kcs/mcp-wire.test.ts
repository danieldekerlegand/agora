/**
 * The MCP client wire, driven end to end against a fake `/mcp` endpoint.
 *
 * The fixture satisfies {@link HttpResponse} and nothing more — the same seam the live
 * console runs ({@link invokeIO}) drives the whole `initialize → tools/list → tools/call`
 * handshake through it, so this proves the real observed path, not a wire talking to itself.
 * A JSON-RPC error rides HTTP 200, so the last case proves it surfaces as a {@link RefusedError}
 * rather than an unhandled throw — "was correctly refused" is a KCS outcome (delta O).
 */
import { SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import type { HttpFetch, HttpResponse } from './http.ts';
import { invokeIO, RefusedError } from './link.ts';
import { ObservationLog } from './log.ts';
import { mcpWire } from './mcp-wire.ts';
import type { WireContext } from './wire.ts';

const ENDPOINT = 'https://processor.example/mcp';
const SESSION = 'sess-abc123';

const MANIFEST = {
  kcb_version: SPEC_VERSIONS.kcb,
  identity: 'processor:agent:filmstudio',
  endpoints: { mcp: ENDPOINT },
  auth: { budget_units: { header: 'X-Agora-Budget-Units' } },
  capabilities: [{ name: 'run_pipeline' }],
} as CapabilityManifest;

interface Spec {
  status?: number;
  envelope?: unknown;
  sse?: boolean;
  sessionId?: string;
}

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  params: unknown;
}

/** A fake MCP endpoint: it answers each JSON-RPC method from `specs` and records every call. */
function mcpEndpoint(specs: Record<string, Spec>): { fetch: HttpFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: HttpFetch = (url, init) => {
    const body = JSON.parse((init?.body ?? '{}') as string) as { method: string; params?: unknown };
    calls.push({ method: body.method, url, headers: { ...(init?.headers ?? {}) }, params: body.params });
    const spec = specs[body.method];
    if (spec === undefined) return Promise.reject(new Error(`unscripted MCP method ${body.method}`));
    const status = spec.status ?? 200;
    const envelope = spec.envelope ?? {};
    const headers: HttpResponse['headers'] = {
      get(name: string): string | null {
        const key = name.toLowerCase();
        if (key === 'mcp-session-id') return spec.sessionId ?? null;
        if (key === 'content-type') return spec.sse ? 'text/event-stream' : 'application/json';
        return null;
      },
    };
    if (spec.sse) {
      return Promise.resolve({
        ok: status < 400,
        status,
        headers,
        json: () => Promise.reject(new Error('an SSE body has no json()')),
        text: () => Promise.resolve(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`),
      });
    }
    return Promise.resolve({ ok: status < 400, status, headers, json: () => Promise.resolve(envelope) });
  };
  return { fetch, calls };
}

function ok(id: number, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result };
}

const INITIALIZE = ok(1, {
  protocolVersion: '2025-11-25',
  capabilities: {},
  serverInfo: { name: 'filmstudio', version: '0.1.0' },
});
const TOOLS = ok(2, { tools: [{ name: 'run_pipeline' }, { name: 'edit_timeline' }] });
const CALL = ok(3, {
  content: [
    { type: 'text', text: 'a one-minute film' },
    { type: 'resource', resource: { uri: 'processor:asset:sha256-abc123def456', mimeType: 'video/mp4' } },
    // A base64 image block — its media type is recorded, never its bytes (KMI §7).
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  ],
});

function context(over: Partial<WireContext> = {}): WireContext {
  return {
    manifest: MANIFEST,
    capability: { name: 'run_pipeline' },
    endpoint: ENDPOINT,
    inputs: [{ shape: 'prompt-text', value: 'a film about a lighthouse' }],
    options: {},
    budgetUnits: 5,
    ...over,
  };
}

function run(
  fetch: HttpFetch,
): { io: ReturnType<typeof invokeIO>; log: ObservationLog } {
  const log = new ObservationLog(() => '2026-07-23T00:00:00.000Z');
  const io = invokeIO({ fetch, log, identity: MANIFEST.identity }, 'compose', 'knowledge', undefined);
  return { io, log };
}

describe('the mcp wire', () => {
  it('drives initialize → tools/list → tools/call and normalises the result', async () => {
    const { fetch, calls } = mcpEndpoint({
      initialize: { envelope: INITIALIZE, sessionId: SESSION },
      'tools/list': { envelope: TOOLS },
      'tools/call': { envelope: CALL },
    });
    const { io, log } = run(fetch);

    const result = await mcpWire.invoke(context(), io);

    expect(calls.map((c) => c.method)).toEqual(['initialize', 'tools/list', 'tools/call']);
    expect(result.text).toBe('a one-minute film');
    expect(result.assets).toEqual([
      { media_type: 'video/mp4', digest: 'sha256:abc123def456' },
      { media_type: 'image/png' },
    ]);
    // No bytes crossed into the normalised result — assets are references only.
    expect(JSON.stringify(result.assets)).not.toContain('iVBORw0KGgo');
    // Both legs of every round-trip were observed — the observer contract across a handshake.
    expect(log.entries().map((e) => e.direction)).toEqual([
      'request',
      'response',
      'request',
      'response',
      'request',
      'response',
    ]);
  });

  it('echoes the Mcp-Session-Id from initialize on every later request', async () => {
    const { fetch, calls } = mcpEndpoint({
      initialize: { envelope: INITIALIZE, sessionId: SESSION },
      'tools/list': { envelope: TOOLS },
      'tools/call': { envelope: CALL },
    });
    const { io } = run(fetch);
    await mcpWire.invoke(context(), io);

    expect(calls[0]?.headers['mcp-session-id']).toBeUndefined();
    expect(calls[1]?.headers['mcp-session-id']).toBe(SESSION);
    expect(calls[2]?.headers['mcp-session-id']).toBe(SESSION);
    // The KCB §5 ceiling rides the MCP request headers, as it does on the openai wire.
    expect(calls[0]?.headers['X-Agora-Budget-Units']).toBe('5');
  });

  it('reads a tools/call answered as text/event-stream, MCP\'s other content type', async () => {
    const { fetch } = mcpEndpoint({
      initialize: { envelope: INITIALIZE },
      'tools/list': { envelope: TOOLS },
      'tools/call': { envelope: CALL, sse: true },
    });
    const { io } = run(fetch);
    const result = await mcpWire.invoke(context(), io);
    expect(result.text).toBe('a one-minute film');
    expect(result.assets?.[0]).toEqual({ media_type: 'video/mp4', digest: 'sha256:abc123def456' });
  });

  it('selects the tool from options.tool when a capability names another', async () => {
    const { fetch, calls } = mcpEndpoint({
      initialize: { envelope: INITIALIZE },
      'tools/list': { envelope: TOOLS },
      'tools/call': { envelope: CALL },
    });
    const { io } = run(fetch);
    await mcpWire.invoke(context({ options: { tool: 'edit_timeline' } }), io);
    expect((calls[2]?.params as { name: string }).name).toBe('edit_timeline');
  });

  it('refuses when the selected tool is not one the peer serves', async () => {
    const { fetch } = mcpEndpoint({
      initialize: { envelope: INITIALIZE },
      'tools/list': { envelope: TOOLS },
    });
    const { io } = run(fetch);
    await expect(
      mcpWire.invoke(context({ capability: { name: 'no_such_tool' } }), io),
    ).rejects.toBeInstanceOf(RefusedError);
  });

  it('surfaces a JSON-RPC error result as a RefusedError, not an unhandled throw', async () => {
    const { fetch } = mcpEndpoint({
      initialize: { envelope: INITIALIZE },
      'tools/list': { envelope: TOOLS },
      'tools/call': {
        envelope: { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'bad tool arguments' } },
      },
    });
    const { io } = run(fetch);
    const invocation = mcpWire.invoke(context(), io);
    await expect(invocation).rejects.toBeInstanceOf(RefusedError);
    await expect(invocation).rejects.toThrow(/bad tool arguments/);
  });

  it('surfaces a tool-level isError result as a RefusedError', async () => {
    const { fetch } = mcpEndpoint({
      initialize: { envelope: INITIALIZE },
      'tools/list': { envelope: TOOLS },
      'tools/call': {
        envelope: ok(3, { isError: true, content: [{ type: 'text', text: 'the pipeline failed' }] }),
      },
    });
    const { io } = run(fetch);
    await expect(mcpWire.invoke(context(), io)).rejects.toThrow(/pipeline failed/);
  });
});
