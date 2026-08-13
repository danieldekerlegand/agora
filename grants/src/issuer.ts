/**
 * The issuer — the half of KCB §5 that lives "in the control-plane host's infra".
 *
 * The router is a relying party and never an issuer (`apr_grant.erl`); the trainer reads a
 * presented ceiling and never mints one. Somebody still has to mint, and §5 says only where that
 * belongs, not what it is. This is that service, written as a capability rather than for a
 * caller: it knows about verbs, scopes and ceilings, and nothing at all about who is asking.
 * The **grantee is whatever principal the host names** — an opaque identity string the issuer
 * copies onto the grant, signs, and never interprets.
 *
 * What the issuer refuses to mint is the interesting part. An issuer must not mint what a relying
 * party would refuse — a token nobody can spend is worse than an error, because it fails at the
 * door of some third service with no way back to the mistake. So the mint gate is exactly the
 * relying parties' parse: an unknown verb is 422 here, as it is there.
 *
 * Signing uses the shared `{key_id, alg}` shape §5 gives manifests and KGP packs
 * (`ManifestSigning`), with the detached signature bytes alongside it. The algorithm is
 * asymmetric on purpose: a relying party must be able to verify a grant from published material
 * without dialing the issuer per request, which is what a shared secret would force.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

import type { ManifestSigning } from '@agora/schemas';

import { GrantError, parseGrant, type Grant } from './grant.ts';

/** KINP identity of the issuer itself — a control-plane service is a fabric entity too. */
export const GRANT_ISSUER_IDENTITY = 'agora:agent:grant-issuer';

/** The signing algorithm. Asymmetric, so verification needs public material and nothing else. */
export const GRANT_SIGNING_ALG = 'ed25519';

/** A signature in the §5 `{key_id, alg}` shape, plus the detached bytes it covers. */
export interface GrantSignature extends ManifestSigning {
  /** base64url over {@link canonicalGrantBytes}. */
  readonly value: string;
}

/** A signing key. The private half never leaves the issuer; the public half is publishable. */
export interface SigningKey {
  readonly key_id: string;
  readonly alg: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

/** The public half of a signing key, in the form a relying party can be handed. */
export interface PublicKeyMaterial {
  readonly key_id: string;
  readonly alg: string;
  /** The SPKI DER of the public key, base64url — self-describing, no key format to negotiate. */
  readonly public_key: string;
}

/** A minted grant: the §5 grant shape, the principal it was minted for, and the signature. */
export interface IssuedGrant extends Grant {
  /** Whatever principal the host names. Opaque to the issuer, covered by the signature. */
  readonly grantee: string;
  readonly signature: GrantSignature;
}

/** What a caller asks for. `scope` may carry the whole `<verb>:<scope>` token instead. */
export interface GrantRequest {
  readonly grantee: string;
  readonly verb?: string | undefined;
  readonly scope: string;
  readonly budget_units?: unknown;
}

export interface GrantIssuerOptions {
  readonly key: SigningKey;
}

export interface GrantIssuer {
  /** The key grants are currently minted under. */
  readonly key: SigningKey;
  /** Mint one grant, or refuse with a graded {@link GrantError}. */
  issue(request: unknown): IssuedGrant;
  /** The public material a relying party verifies with. */
  publicKeys(): readonly PublicKeyMaterial[];
}

/** Generate a fresh signing key under a host-chosen `key_id`. */
export function createSigningKey(key_id: string): SigningKey {
  const id = key_id.trim();
  if (id === '') throw new GrantError(422, 'a signing key needs a key_id');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { key_id: id, alg: GRANT_SIGNING_ALG, privateKey, publicKey };
}

/** Adopt an existing ed25519 key pair (PEM or DER), so a host can supply its own material. */
export function signingKeyFrom(key_id: string, privateKeyPem: string): SigningKey {
  const privateKey = createPrivateKey(privateKeyPem);
  return {
    key_id: key_id.trim(),
    alg: GRANT_SIGNING_ALG,
    privateKey,
    publicKey: createPublicKey(privateKey),
  };
}

/** The public half of `key`, as it is published. */
export function publicMaterial(key: SigningKey): PublicKeyMaterial {
  return {
    key_id: key.key_id,
    alg: key.alg,
    public_key: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  };
}

/** Rebuild a verifying key from published material. */
export function publicKeyFrom(material: PublicKeyMaterial): KeyObject {
  return createPublicKey({
    key: Buffer.from(material.public_key, 'base64url'),
    format: 'der',
    type: 'spki',
  });
}

/**
 * The bytes a signature covers: every claim of the grant plus the `{key_id, alg}` naming the key
 * itself, canonically serialized (keys sorted, absent claims absent). Signing over the key
 * identity too means a grant cannot be replayed under a substituted algorithm or key id.
 */
export function canonicalGrantBytes(grant: {
  readonly verb: string;
  readonly scope: string;
  readonly budget_units?: number | undefined;
  readonly grantee: string;
  readonly signature: { readonly key_id: string; readonly alg: string };
}): Buffer {
  return Buffer.from(
    canonicalJson({
      alg: grant.signature.alg,
      budget_units: grant.budget_units,
      grantee: grant.grantee,
      key_id: grant.signature.key_id,
      scope: grant.scope,
      verb: grant.verb,
    }),
    'utf8',
  );
}

/** Whether `grant`'s signature verifies under `key`. Shape errors are `false`, not throws — a
 * verifier is asked a question, and "this is not a grant I can verify" is an answer to it. */
export function verifyGrantSignature(grant: IssuedGrant, key: KeyObject): boolean {
  try {
    return verify(null, canonicalGrantBytes(grant), key, Buffer.from(grant.signature.value, 'base64url'));
  } catch {
    return false;
  }
}

/** Read a mint request off the wire, refusing anything the relying parties would refuse. */
export function parseGrantRequest(input: unknown): GrantRequest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new GrantError(422, 'a grant request must be an object naming a grantee and a scope');
  }
  const record = input as Record<string, unknown>;
  const grantee = record.grantee;
  if (typeof grantee !== 'string' || grantee.trim() === '') {
    throw new GrantError(422, 'a grant request must name the "grantee" principal it is minted for');
  }
  const scope = record.scope;
  if (typeof scope !== 'string' || scope === '') {
    throw new GrantError(422, 'a grant request must carry a "scope" like "subscribe:world/<world>"');
  }
  const verb = record.verb;
  if (verb !== undefined && (typeof verb !== 'string' || verb === '')) {
    throw new GrantError(422, 'a grant request\'s "verb" must be one of the KCB §4 verbs');
  }
  return {
    grantee: grantee.trim(),
    ...(verb === undefined ? {} : { verb }),
    scope,
    budget_units: record.budget_units,
  };
}

/** Build an issuer over one signing key. Rotation onto a second key is US-2's business. */
export function createGrantIssuer(options: GrantIssuerOptions): GrantIssuer {
  const { key } = options;
  return {
    key,
    issue(request: unknown): IssuedGrant {
      const parsed = parseGrantRequest(request);
      // The mint gate IS the relying parties' parse: verb membership, the `<verb>:<scope>` split
      // and the ceiling scalar, read exactly as `apr_grant:parse/1` reads a presented grant.
      const grant: Grant = parseGrant({
        ...(parsed.verb === undefined ? {} : { verb: parsed.verb }),
        scope: parsed.scope,
        budget_units: parsed.budget_units,
      });
      assertMintableScope(grant.scope);
      const unsigned = {
        verb: grant.verb,
        scope: grant.scope,
        ...(grant.budget_units === undefined ? {} : { budget_units: grant.budget_units }),
        grantee: parsed.grantee,
      };
      const signature = { key_id: key.key_id, alg: key.alg };
      const value = sign(
        null,
        canonicalGrantBytes({ ...unsigned, signature }),
        key.privateKey,
      ).toString('base64url');
      return { ...unsigned, signature: { ...signature, value } };
    },
    publicKeys() {
      return [publicMaterial(key)];
    },
  };
}

/**
 * A scope is minted verbatim, so it must survive the round trip through the token spelling.
 * A scope carrying its own colon would re-split at the wrong place when a relying party reads
 * `{verb, scope}` back as one token, handing the caller a grant on a scope it never asked for.
 */
function assertMintableScope(scope: string): void {
  if (scope.includes(':')) {
    throw new GrantError(422, `a grant scope may not contain ":" (got ${JSON.stringify(scope)})`);
  }
  if (scope.trim() !== scope) {
    throw new GrantError(422, `a grant scope may not be padded with whitespace (got ${JSON.stringify(scope)})`);
  }
}

/** Deterministic JSON: object keys sorted, absent values absent. Two issuers signing the same
 * grant sign the same bytes, which is what makes a signature checkable anywhere. */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
