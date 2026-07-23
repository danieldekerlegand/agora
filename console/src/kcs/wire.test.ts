import { parseManifestBody, type CapabilityManifest, type JsonObject } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { CAPTURED_EXCHANGE, CAPTURED_MANIFEST } from '../fixtures/session.ts';
import {
  budgetHeaderName,
  openaiWire,
  UnsupportedWireError,
  wireFor,
  type ExchangeDetail,
  type WireCall,
  type WireIO,
} from './wire.ts';

const MANIFEST: CapabilityManifest = parseManifestBody(CAPTURED_MANIFEST);

function capability(name: string) {
  const found = (MANIFEST.capabilities ?? []).find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no ${name} in the captured manifest`);
  return found;
}

describe('the openai wire', () => {
  it('builds exactly the request the captured router was asked', () => {
    // If this drifts, the console is dialing something the fixture never proved the
    // router answers — and `provider-router/tests/test_conformance_fixture.py` is what
    // proves the other half.
    const call = openaiWire.request({
      manifest: MANIFEST,
      capability: capability('generate.text'),
      endpoint: 'http://127.0.0.1:8000/v1/chat/completions',
      inputs: [
        {
          shape: 'chat-messages',
          value: {
            messages: [{ role: 'user', content: 'In one sentence, what is the agora commons?' }],
          },
        },
      ],
      options: { max_tokens: 64 },
      budgetUnits: 0,
    });
    expect(call.body).toEqual(CAPTURED_EXCHANGE.request);
    expect(call.url).toBe('http://127.0.0.1:8000/v1/chat/completions');
  });

  it('echoes back the model the provider advertises, rather than choosing one', () => {
    // The ladder is the router's business (US-AG2); the console must not steer it.
    expect(capability('generate.text').model).toBe('placeholder-text');
  });

  it('puts the ceiling in the header the manifest advertises, not in the body', () => {
    const call = openaiWire.request({
      manifest: MANIFEST,
      capability: capability('generate.text'),
      endpoint: 'http://x/v1/chat/completions',
      inputs: [],
      options: {},
      budgetUnits: 12,
    });
    expect(budgetHeaderName(MANIFEST)).toBe('X-Agora-Budget-Units');
    expect(call.headers['X-Agora-Budget-Units']).toBe('12');
    expect(call.body.budget_units).toBeUndefined();
  });

  it('reads the routing report off the response body', () => {
    const result = openaiWire.read(CAPTURED_EXCHANGE.response);
    expect(result.tier).toBe('placeholder');
    expect(result.provider).toBe('placeholder');
    expect(result.cost).toEqual({
      currency: 'budget_units',
      budget_units: 0,
      projected_units: 0,
      actual_units: 0,
    });
    expect(result.text).toContain('[agora placeholder]');
  });

  it('reports no cost when the provider reported none — rather than inventing a zero', () => {
    expect(openaiWire.read({ agora: { tier: 'paid' } }).cost).toBeUndefined();
  });
});

describe('the generalised invoke seam', () => {
  /**
   * A one-shot stand-in for the console's exchange seam: it captures the call a wire made,
   * runs the wire's response-detail callback against a canned answer (as the live seam does
   * before recording the response leg), and hands the answer back. A multi-step wire would
   * drive several of these; the openai wire drives exactly one.
   */
  function fakeIo(answer: JsonObject): {
    io: WireIO;
    calls: { call: WireCall; detail?: ExchangeDetail | undefined }[];
    legDetails: Record<string, unknown>[];
  } {
    const calls: { call: WireCall; detail?: ExchangeDetail | undefined }[] = [];
    const legDetails: Record<string, unknown>[] = [];
    const io: WireIO = {
      exchange(call, detail) {
        calls.push({ call, detail });
        if (detail?.request !== undefined) legDetails.push(detail.request);
        if (detail?.response !== undefined) legDetails.push(detail.response(answer));
        return Promise.resolve(answer);
      },
    };
    return { io, calls, legDetails };
  }

  it('returns the openai InvocationResult verbatim through the handshake-capable path', async () => {
    const { io, calls } = fakeIo(CAPTURED_EXCHANGE.response);
    const result = await openaiWire.invoke(
      {
        manifest: MANIFEST,
        capability: capability('generate.text'),
        endpoint: 'http://127.0.0.1:8000/v1/chat/completions',
        inputs: [],
        options: { max_tokens: 64 },
        budgetUnits: 7,
      },
      io,
    );
    // The generalised path normalises to precisely what read() gives on the same body: the
    // single-shot wire is one round-trip of the multi-step contract, nothing more.
    expect(result).toEqual(openaiWire.read(CAPTURED_EXCHANGE.response));
    // One round-trip, dialing the resolved endpoint and carrying the ceiling into the leg.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.call.url).toBe('http://127.0.0.1:8000/v1/chat/completions');
    expect(calls[0]?.detail?.request).toMatchObject({ wire: 'openai', budget_units: 7 });
  });
});

describe('wireFor', () => {
  it('picks the openai wire when the provider serves an openai surface', () => {
    expect(wireFor(MANIFEST).name).toBe('openai');
  });

  it('picks the mcp wire for an mcp-only provider', () => {
    const mcpOnly: CapabilityManifest = {
      ...MANIFEST,
      endpoints: { mcp: 'https://peer.example/mcp' },
    };
    expect(wireFor(mcpOnly).name).toBe('mcp');
  });

  it('picks the a2a wire for an a2a-only provider', () => {
    const a2aOnly: CapabilityManifest = {
      ...MANIFEST,
      endpoints: { a2a: 'https://peer.example/.well-known/agent-card.json' },
    };
    expect(wireFor(a2aOnly).name).toBe('a2a');
  });

  it('follows the openai → mcp → a2a precedence when several are advertised', () => {
    const all: CapabilityManifest = {
      ...MANIFEST,
      endpoints: { openai: 'https://p/v1', mcp: 'https://p/mcp', a2a: 'https://p/card.json' },
    };
    expect(wireFor(all).name).toBe('openai');
    const mcpThenA2a: CapabilityManifest = {
      ...MANIFEST,
      endpoints: { mcp: 'https://p/mcp', a2a: 'https://p/card.json' },
    };
    expect(wireFor(mcpThenA2a).name).toBe('mcp');
  });

  it('refuses loudly when a provider advertises only a transport this build cannot speak', () => {
    // Named, not guessed at: a peer that publishes a fourth transport gets a failure that
    // says which wire to write instead of the console mis-dialing an endpoint it can't read.
    const unknownOnly: CapabilityManifest = {
      ...MANIFEST,
      endpoints: { carrierpigeon: 'https://peer.example/coop' },
    };
    expect(() => wireFor(unknownOnly)).toThrow(UnsupportedWireError);
    expect(() => wireFor(unknownOnly)).toThrow(/carrierpigeon/);
  });
});
