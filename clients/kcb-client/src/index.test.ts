import { describe, expect, it } from 'vitest';

import { SPEC_VERSIONS, type CapabilityManifest } from '@agora/schemas';

import { addressOf, endpointFor, isDialable, KCB_CLIENT_VERSION } from './index.ts';

const ROUTER: CapabilityManifest = {
  kcb_version: SPEC_VERSIONS.kcb,
  identity: 'agora:agent:provider-router',
  endpoints: { openai: 'https://router.example/v1', doctor: 'https://router.example/doctor' },
  capabilities: [{ name: 'generate.text', endpoint: 'https://router.example/v1/chat/completions' }],
};

describe('@agora/kcb-client', () => {
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
});
