import { describe, expect, it } from 'vitest';

import { isDialable, KCB_CLIENT_VERSION } from './index.ts';

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
});
