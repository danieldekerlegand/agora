import { describe, expect, it } from 'vitest';

import { createSigningKey, verifyGrantSignature, type IssuedGrant } from './issuer.ts';
import {
  DEFAULT_GRANTS_HOST,
  DEFAULT_GRANTS_PORT,
  DEFAULT_KEY_ID,
  grantsLaunchFromEnv,
  startGrantIssuer,
} from './main.ts';

describe('launching from the environment', () => {
  it('defaults to a loopback bind and an ephemeral key, and says which', () => {
    const launch = grantsLaunchFromEnv({});
    expect(launch.host).toBe(DEFAULT_GRANTS_HOST);
    expect(launch.port).toBe(DEFAULT_GRANTS_PORT);
    expect(launch.key.key_id).toBe(DEFAULT_KEY_ID);
    expect(launch.ephemeralKey).toBe(true);
  });

  it('adopts host-supplied key material, and stops calling it ephemeral', () => {
    const key = createSigningKey('host-key');
    const launch = grantsLaunchFromEnv({
      AGORA_GRANTS_KEY_ID: 'host-key',
      AGORA_GRANTS_KEY: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    expect(launch.ephemeralKey).toBe(false);
    expect(launch.key.key_id).toBe('host-key');
  });

  it('refuses a port that is not a port', () => {
    expect(() => grantsLaunchFromEnv({ AGORA_GRANTS_PORT: 'eight' })).toThrow(/AGORA_GRANTS_PORT/);
  });

  it('starts, mints over the wire, and stops', async () => {
    const key = createSigningKey('booted');
    const started = await startGrantIssuer({
      AGORA_GRANTS_KEY_ID: 'booted',
      AGORA_GRANTS_KEY: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      AGORA_GRANTS_PORT: '0',
    });
    try {
      const res = await fetch(`http://${started.host}:${started.port}/grants`, {
        method: 'POST',
        body: JSON.stringify({ grantee: 'example:agent:p', scope: 'invoke:finetune' }),
      });
      expect(res.status).toBe(201);
      expect(verifyGrantSignature((await res.json()) as IssuedGrant, key.publicKey)).toBe(true);
    } finally {
      await started.service.close();
    }
  });
});
