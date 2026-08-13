import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseGrant, permits } from './grant.ts';
import {
  createGrantIssuer,
  createSigningKey,
  publicKeyFrom,
  verifyGrantSignature,
  type IssuedGrant,
  type PublicKeyMaterial,
} from './issuer.ts';
import { createGrantServer, describeGrantIssuer, type GrantService } from './server.ts';

const key = createSigningKey('server-test');
let service: GrantService;
let base: string;

beforeAll(async () => {
  service = createGrantServer(createGrantIssuer({ key }));
  const address = await service.listen();
  base = `http://${address.host}:${address.port}`;
});

afterAll(async () => {
  await service.close();
});

async function post(body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /grants', () => {
  it('mints a signed grant a relying party can read straight off the wire', async () => {
    const { status, body } = await post({
      grantee: 'example:agent:principal',
      scope: 'subscribe:world/*',
      budget_units: 40,
    });
    expect(status).toBe(201);
    const grant = body as IssuedGrant;
    expect(grant.signature.key_id).toBe('server-test');

    const parsed = parseGrant(grant);
    expect(permits(parsed, 'subscribe', 'world/consensus-reality')).toBe(true);
    expect(parsed.budget_units).toBe(40);
    expect(verifyGrantSignature(grant, key.publicKey)).toBe(true);
  });

  it('refuses an unmintable verb with the 422 the router would answer with', async () => {
    const { status, body } = await post({ grantee: 'example:agent:p', scope: 'publish:world/x' });
    expect(status).toBe(422);
    expect(body).toMatchObject({ error: 'GrantError', message: expect.stringContaining('verb') });
  });

  it('refuses a malformed ceiling rather than minting an unbounded grant', async () => {
    const { status } = await post({
      grantee: 'example:agent:p',
      scope: 'invoke:finetune',
      budget_units: 'plenty',
    });
    expect(status).toBe(422);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await fetch(`${base}/grants`, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(422);
  });
});

describe('GET /keys', () => {
  it('publishes verification material a relying party can poll instead of dialing', async () => {
    const res = await fetch(`${base}/keys`);
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: PublicKeyMaterial[] };
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ key_id: 'server-test', alg: 'ed25519' });

    const { body } = await post({ grantee: 'example:agent:p', scope: 'fetch:asset' });
    const verifier = publicKeyFrom(keys[0] ?? { key_id: '', alg: '', public_key: '' });
    expect(verifyGrantSignature(body as IssuedGrant, verifier)).toBe(true);
  });
});

describe('GET /describe', () => {
  it('states what the issuer is and what it will not do', async () => {
    const res = await fetch(`${base}/describe`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(describeGrantIssuer());
    expect(describeGrantIssuer()).toMatchObject({ retainsGrants: false, proxiesTraffic: false });
  });

  it('answers 404 for anything else — there is no relay surface here', async () => {
    const res = await fetch(`${base}/invoke`);
    expect(res.status).toBe(404);
  });
});
