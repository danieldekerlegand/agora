import { describe, expect, it } from 'vitest';

import type { IssuedGrant } from './grant.ts';
import { createSigningKey } from './keys.ts';
import { verifyGrantSignature } from './verify.ts';
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

  it('carries the outgoing key through a rotating redeploy', () => {
    const outgoing = createSigningKey('retiring');
    const pem = (key: ReturnType<typeof createSigningKey>): string =>
      key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const launch = grantsLaunchFromEnv(
      {
        AGORA_GRANTS_KEY_ID: 'successor',
        AGORA_GRANTS_KEY: pem(createSigningKey('successor')),
        AGORA_GRANTS_PREVIOUS_KEY_ID: 'retiring',
        AGORA_GRANTS_PREVIOUS_KEY: pem(outgoing),
        AGORA_GRANTS_OVERLAP: '3600',
        AGORA_GRANTS_LIFETIME: '900',
      },
      '2026-08-13T12:00:00.000Z',
    );
    expect(launch.key.key_id).toBe('successor');
    expect(launch.lifetimeMs).toBe(900_000);
    expect(launch.previousKeys).toEqual([
      { key: expect.objectContaining({ key_id: 'retiring' }), not_after: '2026-08-13T13:00:00.000Z' },
    ]);
  });

  it('refuses half a rotation — an id with no key verifies nothing', () => {
    expect(() => grantsLaunchFromEnv({ AGORA_GRANTS_PREVIOUS_KEY_ID: 'retiring' })).toThrow(
      /PREVIOUS_KEY/,
    );
  });

  it('refuses a lifetime or an overlap that is not a duration', () => {
    expect(() => grantsLaunchFromEnv({ AGORA_GRANTS_LIFETIME: '0' })).toThrow(/LIFETIME/);
    expect(() => grantsLaunchFromEnv({ AGORA_GRANTS_OVERLAP: 'a while' })).toThrow(/OVERLAP/);
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
      const grant = (await res.json()) as IssuedGrant;
      expect(verifyGrantSignature(grant, key.publicKey)).toBe(true);
      // Default lifetime, applied by the launch: a booted issuer mints expiring grants too.
      expect(Date.parse(grant.expires_at)).toBeGreaterThan(Date.now());
    } finally {
      await started.service.close();
    }
  });
});
