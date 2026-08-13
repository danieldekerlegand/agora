import { describe, expect, it } from 'vitest';

import { GrantError, parseGrant, permits, type IssuedGrant } from './grant.ts';
import { createGrantIssuer, parseGrantRequest } from './issuer.ts';
import {
  createSigningKey,
  GRANT_SIGNING_ALG,
  publicKeyFrom,
  publicMaterial,
  signingKeyFrom,
} from './keys.ts';
import { canonicalGrantBytes, verifyGrantSignature } from './verify.ts';

const key = createSigningKey('issuer-test-1');
const issuer = createGrantIssuer({ key });

/** Whatever principal the host names — an opaque string, and the issuer never reads it. */
const GRANTEE = 'example:agent:some-principal';

function issue(request: Record<string, unknown>): IssuedGrant {
  return issuer.issue({ grantee: GRANTEE, ...request });
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof GrantError ? err.status : -1;
  }
}

describe('minting', () => {
  it('mints the §5 shape: verb, scope, optional ceiling, {key_id, alg} signature', () => {
    const grant = issue({ scope: 'invoke:finetune', budget_units: 250 });
    expect(grant).toMatchObject({
      verb: 'invoke',
      scope: 'finetune',
      budget_units: 250,
      grantee: GRANTEE,
      signature: { key_id: 'issuer-test-1', alg: GRANT_SIGNING_ALG },
    });
    expect(typeof grant.signature.value).toBe('string');
  });

  it('accepts the split spelling and the token spelling as the same grant', () => {
    // One clock for both mints: the expiry is signed, so two mints a millisecond apart are two
    // different grants — which is the point of signing it, and would hide the equality here.
    const fixed = createGrantIssuer({ key, now: () => '2026-08-13T12:00:00.000Z' });
    const at = { grantee: GRANTEE };
    const split = fixed.issue({ ...at, verb: 'subscribe', scope: 'world/consensus-reality' });
    const token = fixed.issue({ ...at, scope: 'subscribe:world/consensus-reality' });
    expect(split.verb).toBe(token.verb);
    expect(split.scope).toBe(token.scope);
    expect(split.signature.value).toBe(token.signature.value);
  });

  it('mints without a ceiling as unbounded, and omits the key rather than nulling it', () => {
    const grant = issue({ scope: 'fetch:asset' });
    expect(grant.budget_units).toBeUndefined();
    expect(Object.keys(JSON.parse(JSON.stringify(grant)) as object)).not.toContain('budget_units');
  });

  it('reads the ceiling as the relying parties do — numeric strings in, clamped at zero', () => {
    expect(issue({ scope: 'invoke:compose', budget_units: '12.5' }).budget_units).toBe(12.5);
    expect(issue({ scope: 'invoke:compose', budget_units: -4 }).budget_units).toBe(0);
  });
});

describe('what an issuer must not mint', () => {
  it('refuses a verb outside §4 — an issuer must not mint what a relying party would 422', () => {
    expect(statusOf(() => issue({ scope: 'publish:world/x' }))).toBe(422);
    expect(statusOf(() => issue({ verb: 'publish', scope: 'world/x' }))).toBe(422);
  });

  it('refuses a malformed ceiling rather than minting an unbounded grant', () => {
    expect(statusOf(() => issue({ scope: 'invoke:finetune', budget_units: 'plenty' }))).toBe(422);
    expect(statusOf(() => issue({ scope: 'invoke:finetune', budget_units: true }))).toBe(422);
  });

  it('refuses a scope that would re-split at the wrong colon', () => {
    expect(statusOf(() => issue({ verb: 'invoke', scope: 'invoke:finetune' }))).toBe(422);
  });

  it('refuses a request with no grantee — a grant is always minted FOR a principal', () => {
    expect(statusOf(() => issuer.issue({ scope: 'invoke:finetune' }))).toBe(422);
    expect(statusOf(() => issuer.issue({ grantee: '  ', scope: 'invoke:finetune' }))).toBe(422);
    expect(statusOf(() => issuer.issue('invoke:finetune'))).toBe(422);
  });

  it('refuses a request that is not a request', () => {
    for (const bad of [undefined, null, 42, ['invoke:finetune'], {}]) {
      expect(statusOf(() => parseGrantRequest(bad))).toBe(422);
    }
  });
});

describe('the signature', () => {
  it('verifies under the issuer’s published public material', () => {
    const grant = issue({ scope: 'invoke:finetune', budget_units: 100 });
    expect(issuer.publicKeys()).toEqual([publicMaterial(key)]);
    // Verified the way a relying party would: rebuild the key from what /keys published.
    expect(verifyGrantSignature(grant, publicKeyFrom(publicMaterial(key)))).toBe(true);
  });

  it('does not verify once any claim is edited', () => {
    const grant = issue({ scope: 'invoke:finetune', budget_units: 100 });
    const verifier = publicKeyFrom(publicMaterial(key));
    const tampered: IssuedGrant[] = [
      { ...grant, budget_units: 10_000 },
      { ...grant, scope: '*' },
      { ...grant, verb: 'subscribe' },
      { ...grant, grantee: 'example:agent:someone-else' },
      { ...grant, signature: { ...grant.signature, key_id: 'issuer-test-2' } },
      { ...grant, signature: { ...grant.signature, alg: 'none' } },
      { ...grant, signature: { ...grant.signature, value: 'not-a-signature' } },
    ];
    for (const edited of tampered) {
      expect(verifyGrantSignature(edited, verifier)).toBe(false);
    }
    expect(verifyGrantSignature(grant, verifier)).toBe(true);
  });

  it('does not verify under a different key', () => {
    const grant = issue({ scope: 'invoke:finetune' });
    const other = createSigningKey('issuer-test-other');
    expect(verifyGrantSignature(grant, other.publicKey)).toBe(false);
  });

  it('covers canonical bytes — key order on the wire cannot change what was signed', () => {
    const grant = issue({ scope: 'invoke:finetune', budget_units: 5 });
    const reordered = JSON.parse(
      JSON.stringify({
        signature: grant.signature,
        expires_at: grant.expires_at,
        grantee: grant.grantee,
        budget_units: grant.budget_units,
        scope: grant.scope,
        verb: grant.verb,
      }),
    ) as IssuedGrant;
    expect(canonicalGrantBytes(reordered).toString('utf8')).toBe(
      canonicalGrantBytes(grant).toString('utf8'),
    );
    expect(verifyGrantSignature(reordered, key.publicKey)).toBe(true);
  });
});

describe('host-supplied key material', () => {
  it('adopts an existing private key and mints verifiable grants under it', () => {
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const adopted = signingKeyFrom('issuer-test-1', pem);
    const grant = createGrantIssuer({ key: adopted }).issue({
      grantee: GRANTEE,
      scope: 'invoke:finetune',
    });
    expect(verifyGrantSignature(grant, key.publicKey)).toBe(true);
  });
});

describe('the issuer is capability-scoped, not caller-scoped', () => {
  it('treats the grantee as opaque — any principal spelling mints', () => {
    for (const grantee of ['kinp:agent:a', 'urn:example:b', 'anything at all']) {
      const grant = issuer.issue({ grantee, scope: 'invoke:finetune' });
      expect(grant.grantee).toBe(grantee);
      expect(verifyGrantSignature(grant, key.publicKey)).toBe(true);
    }
  });

  it('mints a wildcard scope the relying parties then read as subtree coverage', () => {
    const grant = parseGrant(JSON.parse(JSON.stringify(issue({ scope: 'subscribe:world/*' }))));
    expect(permits(grant, 'subscribe', 'world/consensus-reality')).toBe(true);
    expect(permits(grant, 'subscribe', 'elsewhere/x')).toBe(false);
  });
});
