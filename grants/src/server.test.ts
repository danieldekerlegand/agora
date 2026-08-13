import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseGrant, permits, type IssuedGrant } from './grant.ts';
import { createGrantIssuer } from './issuer.ts';
import { createSigningKey, publicKeyFrom, type PublishedKey } from './keys.ts';
import { createGrantVerifier } from './verify.ts';
import { verifyGrantSignature } from './verify.ts';
import { grantIssuerManifest, AGENT_CARD_PATH, KCB_MANIFEST_PATH } from './manifest.ts';
import {
  createGrantServer,
  describeGrantIssuer,
  KEYS_MAX_AGE_SECONDS,
  type GrantService,
} from './server.ts';

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
    const { keys } = (await res.json()) as { keys: PublishedKey[] };
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ key_id: 'server-test', alg: 'ed25519' });

    const { body } = await post({ grantee: 'example:agent:p', scope: 'fetch:asset' });
    const verifier = publicKeyFrom(keys[0] ?? { key_id: '', alg: '', public_key: '' });
    expect(verifyGrantSignature(body as IssuedGrant, verifier)).toBe(true);
  });
});

describe('GET /keys through a rotation', () => {
  it('says which key is on its way out, and verifies a grant minted before it', async () => {
    // A service of its own, so the rotation does not disturb the shared one above.
    const first = createSigningKey('rotating-1');
    const rotating = createGrantServer(createGrantIssuer({ key: first }));
    const address = await rotating.listen();
    const at = `http://${address.host}:${address.port}`;
    try {
      const held = await (
        await fetch(`${at}/grants`, {
          method: 'POST',
          body: JSON.stringify({ grantee: 'example:agent:p', scope: 'invoke:finetune' }),
        })
      ).json();

      rotating.issuer.rotate(createSigningKey('rotating-2'));

      const res = await fetch(`${at}/keys`);
      expect(res.headers.get('cache-control')).toBe(`max-age=${KEYS_MAX_AGE_SECONDS}`);
      const { keys } = (await res.json()) as { keys: PublishedKey[] };
      expect(keys.map((k) => k.key_id)).toEqual(['rotating-2', 'rotating-1']);
      expect(keys[0]).not.toHaveProperty('not_after');
      expect(typeof keys[1]?.not_after).toBe('string');

      // The whole point of publishing the outgoing key: a relying party holding only this JSON
      // still honors the grant it was handed before the rotation.
      expect(createGrantVerifier({ keys })(held)).toMatchObject({ verb: 'invoke' });
    } finally {
      await rotating.close();
    }
  });
});

describe('POST /grants/derive', () => {
  it('narrows a presented parent into a child a relying party reads the same way', async () => {
    const { body: parent } = await post({
      grantee: 'example:agent:principal',
      scope: 'subscribe:world/*',
      budget_units: 100,
    });
    const res = await fetch(`${base}/grants/derive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent,
        grantee: 'example:agent:next-hop',
        scope: 'world/consensus-reality',
        budget_units: 25,
      }),
    });
    expect(res.status).toBe(201);
    const child = (await res.json()) as IssuedGrant;
    expect(child).toMatchObject({ verb: 'subscribe', scope: 'world/consensus-reality', budget_units: 25 });
    expect(verifyGrantSignature(child, key.publicKey)).toBe(true);
    expect(permits(parseGrant(child), 'subscribe', 'world/consensus-reality')).toBe(true);
  });

  it('answers a widening derivation with the 403 the parent already implies', async () => {
    const { body: parent } = await post({ grantee: 'example:agent:principal', scope: 'fetch:asset' });
    const res = await fetch(`${base}/grants/derive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parent, scope: '*' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'GrantError' });
  });
});

describe('the well-known documents a registry crawls', () => {
  it('serves the KCB manifest and the AgentCard carrying it', async () => {
    const manifest = await (await fetch(`${base}${KCB_MANIFEST_PATH}`)).json();
    expect(manifest).toEqual(grantIssuerManifest(base));

    const card = (await (await fetch(`${base}${AGENT_CARD_PATH}`)).json()) as {
      capabilities?: { extensions?: unknown[] };
    };
    expect(card.capabilities?.extensions).toHaveLength(1);
    // Discovery is an address, never a route through anybody: what the crawl indexes is where
    // to dial this issuer, and the mint happens between the caller and it (ADR-0001 dec. 3).
    expect(describeGrantIssuer()).toMatchObject({ proxiesTraffic: false });
  });
});

describe('GET /describe', () => {
  it('states what the issuer is and what it will not do', async () => {
    const res = await fetch(`${base}/describe`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(describeGrantIssuer(service.issuer));
    expect(describeGrantIssuer()).toMatchObject({ retainsGrants: false, proxiesTraffic: false });
  });

  it('answers 404 for anything else — there is no relay surface here', async () => {
    const res = await fetch(`${base}/invoke`);
    expect(res.status).toBe(404);
  });

  it('states the operator ceiling policy it will apply, and that it only ever narrows', async () => {
    const capped = createGrantServer(
      createGrantIssuer({
        key,
        ceilings: { mode: 'refuse', caps: [{ scope: 'finetune', max_units: 50 }] },
      }),
    );
    const address = await capped.listen();
    try {
      const described = await (await fetch(`http://${address.host}:${address.port}/describe`)).json();
      expect(described).toMatchObject({
        attenuatesOnly: true,
        ceilings: { mode: 'refuse', caps: [{ scope: 'finetune', max_units: 50 }] },
      });
      // A caller that can read the cap does not have to discover it by being refused.
      const res = await fetch(`http://${address.host}:${address.port}/grants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grantee: 'example:agent:p', scope: 'invoke:finetune' }),
      });
      expect(res.status).toBe(403);
    } finally {
      await capped.close();
    }
  });

  it('offers no route that controls the keys — rotation is an operator action', async () => {
    expect(describeGrantIssuer()).toMatchObject({ grantsExpire: true, rotatesOverHttp: false });
    for (const path of ['/rotate', '/keys/retire']) {
      const res = await fetch(`${base}${path}`, { method: 'POST' });
      expect(res.status).toBe(404);
    }
    // …and every grant it does hand out carries the lifetime that says so.
    const { body } = await post({ grantee: 'example:agent:p', scope: 'fetch:asset' });
    expect(typeof (body as IssuedGrant).expires_at).toBe('string');
  });
});
