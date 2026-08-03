import { describe, expect, it } from 'vitest';

import { SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';

import { addressOf, endpointFor, isDialable, KCB_CLIENT_VERSION, transportOf } from './kcb.ts';

const ROUTER: CapabilityManifest = {
  kcb_version: SPEC_VERSIONS.kcb,
  identity: 'agora:agent:provider-router',
  endpoints: { openai: 'https://router.example/v1', doctor: 'https://router.example/doctor' },
  capabilities: [{ name: 'generate.text', endpoint: 'https://router.example/v1/chat/completions' }],
};

describe('@agora/sdk — KCB addressing', () => {
  it('speaks the KCB version the schemas package pins', () => {
    expect(KCB_CLIENT_VERSION).toBe('0.2.0');
  });

  it('treats a provider with no endpoint as undialable', () => {
    expect(isDialable({ identity: 'agora:agent:provider-router', endpoints: {} })).toBe(false);
    expect(
      isDialable({
        identity: 'agora:agent:provider-router',
        endpoints: { mcp: 'http://127.0.0.1:8080/mcp' },
      }),
    ).toBe(true);
  });

  it('counts any published transport as dialable, not just mcp/a2a', () => {
    // The provider-router serves an OpenAI surface and no MCP server yet; a peer can
    // still reach it, so a lookup that returned "undialable" would be wrong.
    expect(isDialable(addressOf(ROUTER))).toBe(true);
  });

  it('projects a manifest to an address and nothing else', () => {
    expect(addressOf(ROUTER)).toEqual({
      identity: 'agora:agent:provider-router',
      endpoints: ROUTER.endpoints,
    });
  });

  it('prefers a capability’s own endpoint over the provider’s', () => {
    const address = addressOf(ROUTER);
    expect(endpointFor(address, ROUTER.capabilities?.[0])).toBe(
      'https://router.example/v1/chat/completions',
    );
    expect(endpointFor({ identity: 'x:agent:y', endpoints: {} })).toBeUndefined();
  });

  it('names the transport an mcp-only address is dialed over', () => {
    expect(
      transportOf({ identity: 'agora:agent:analyzer', endpoints: { mcp: 'http://analyzer/mcp' } }),
    ).toBe('mcp');
  });

  it('names the transport an a2a-only address is dialed over', () => {
    expect(
      transportOf({
        identity: 'agora:agent:orchestrator',
        endpoints: { a2a: 'http://orchestrator/.well-known/agent-card.json' },
      }),
    ).toBe('a2a');
  });

  it('names the transport a capability’s own endpoint is hosted on', () => {
    // The router capability dials `/v1/chat/completions`, which lives under `endpoints.openai`
    // (`/v1`) — so the caller learns WHERE (endpointFor) and OVER WHAT (transportOf) agree.
    const address = addressOf(ROUTER);
    expect(transportOf(address, ROUTER.capabilities?.[0])).toBe('openai');
  });

  it('honors endpointFor’s precedence: mcp before a2a, capability endpoint first', () => {
    const both = { identity: 'x:agent:y', endpoints: { mcp: 'http://y/mcp', a2a: 'http://y/card' } };
    expect(transportOf(both)).toBe('mcp');
    // A capability endpoint under the a2a surface wins over the provider's mcp default.
    expect(transportOf(both, { endpoint: 'http://y/card/tasks' })).toBe('a2a');
  });

  it('invents no transport when nothing dialable — or nothing hosts the endpoint', () => {
    expect(transportOf({ identity: 'x:agent:y', endpoints: {} })).toBeUndefined();
    // A capability endpoint no published transport hosts is honestly unknown, not guessed.
    expect(transportOf(addressOf(ROUTER), { endpoint: 'https://elsewhere.example/rpc' })).toBeUndefined();
  });
});
