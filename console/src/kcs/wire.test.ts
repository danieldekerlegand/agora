import { parseManifest, type CapabilityManifest } from '@agora/schemas';
import { describe, expect, it } from 'vitest';

import { CAPTURED_EXCHANGE, CAPTURED_MANIFEST } from '../fixtures/session.ts';
import { budgetHeaderName, openaiWire, UnsupportedWireError, wireFor } from './wire.ts';

const MANIFEST: CapabilityManifest = parseManifest(CAPTURED_MANIFEST);

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

describe('wireFor', () => {
  it('picks the wire from what the provider says it serves', () => {
    expect(wireFor(MANIFEST).name).toBe('openai');
  });

  it('refuses loudly when a provider advertises a transport this build cannot speak', () => {
    // Named, not guessed at: the day a peer publishes `mcp`, the failure says which wire
    // to write instead of the console mis-dialing an endpoint it does not understand.
    const mcpOnly: CapabilityManifest = {
      ...MANIFEST,
      endpoints: { mcp: 'https://peer.example/mcp' },
    };
    expect(() => wireFor(mcpOnly)).toThrow(UnsupportedWireError);
    expect(() => wireFor(mcpOnly)).toThrow(/advertises mcp/);
  });
});
