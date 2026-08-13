/**
 * Verification — the half of the issuer that runs at the *relying party*, not at the issuer.
 *
 * This file exists because the alternative is worse. Every service that enforces a grant has to
 * answer the same four questions about it — is this a grant at all, was it signed by a key this
 * issuer published, does the signature cover these bytes, and is it still inside its lifetime —
 * and each service answering them for itself is four chances to answer one of them differently.
 * A verifier that reads expiry with `<=` where another reads `<` disagrees about exactly one
 * millisecond per grant, forever, and nobody finds out.
 *
 * So the check is one small function over one input a relying party already has: the JSON that
 * `GET /keys` served. {@link createGrantVerifier} takes that key set (or a getter, for a poller
 * that refreshes it) and hands back a `(presented) => IssuedGrant`. Nothing dials the issuer,
 * because a per-request round trip to the issuer is what asymmetric signing exists to avoid,
 * and because an issuer that must be reachable to authorize anything is a hub — which
 * ADR-0001 decision 3 rules out for the registry and which is no better here.
 *
 * **Refusals are graded the way `apr_grant:parse/1` grades them** — `403` you are not
 * authorized, `422` you sent something unreadable — so the refusal is one a caller can act on
 * rather than a generic failure:
 *
 * | Refusal | Status | Because |
 * |---|---|---|
 * | not a grant, unknown verb, malformed ceiling, no signature | `422` | the caller can fix the request |
 * | signed by a key that is not published, or one whose overlap ended | `403` | nothing to trust it against |
 * | signature does not cover these bytes | `403` | the claims were edited after issuance |
 * | past `expires_at` | `403` | it was a grant, and its lifetime ran out |
 *
 * An expiry is a refusal and not an error on purpose: "your grant expired at T, get another" is
 * a sentence the caller can act on, and a 500 is not.
 */
import { verify, type KeyObject } from 'node:crypto';

import {
  GrantError,
  parseGrant,
  type GrantSignature,
  type IssuedGrant,
} from './grant.ts';
import { instant, publicKeyFrom, type Clock, type PublishedKey } from './keys.ts';

/**
 * The bytes a signature covers: every claim of the grant plus the `{key_id, alg}` naming the key
 * itself, canonically serialized (keys sorted, absent claims absent). Signing over the key
 * identity too means a grant cannot be replayed under a substituted algorithm or key id, and
 * signing over `expires_at` means a lifetime cannot be extended by editing it.
 */
export function canonicalGrantBytes(grant: {
  readonly verb: string;
  readonly scope: string;
  readonly budget_units?: number | undefined;
  readonly grantee: string;
  readonly expires_at: string;
  readonly signature: { readonly key_id: string; readonly alg: string };
}): Buffer {
  return Buffer.from(
    canonicalJson({
      alg: grant.signature.alg,
      budget_units: grant.budget_units,
      expires_at: grant.expires_at,
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

/**
 * Read a presented grant back into {@link IssuedGrant} — the §5 claims via `parseGrant`, plus
 * the three an issued one carries. Every refusal here is a `422`: the caller sent something
 * that is not a grant, which is a different failure from holding one that does not authorize.
 */
export function parseIssuedGrant(input: unknown): IssuedGrant {
  const grant = parseGrant(input);
  if (typeof input !== 'object' || input === null) {
    // Unreachable via parseGrant (a token string carries no signature), but a token string is
    // a grant *reference*, not an issued grant — say so rather than crash on the fields.
    throw new GrantError(422, 'an issued grant is an object carrying a grantee, expires_at and signature');
  }
  const record = input as Record<string, unknown>;
  const grantee = record.grantee;
  if (typeof grantee !== 'string' || grantee.trim() === '') {
    throw new GrantError(422, 'an issued grant names the "grantee" principal it was minted for');
  }
  const expires_at = record.expires_at;
  if (typeof expires_at !== 'string') {
    throw new GrantError(422, 'an issued grant carries an ISO-8601 "expires_at"');
  }
  instant(expires_at);
  return {
    ...grant,
    grantee,
    expires_at,
    signature: parseGrantSignature(record.signature),
  };
}

function parseGrantSignature(input: unknown): GrantSignature {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new GrantError(422, 'an issued grant carries a {key_id, alg, value} signature');
  }
  const record = input as Record<string, unknown>;
  const { key_id, alg, value } = record;
  for (const [name, field] of Object.entries({ key_id, alg, value })) {
    if (typeof field !== 'string' || field === '') {
      throw new GrantError(422, `a grant signature's "${name}" must be a non-empty string`);
    }
  }
  return { key_id: key_id as string, alg: alg as string, value: value as string };
}

/** Whether `grant` has aged out at `at`. The instant `expires_at` names is the first one the
 * grant no longer covers, so a lifetime is half-open and two verifiers cannot disagree by a
 * millisecond over which side of it they are on. */
export function isExpired(grant: IssuedGrant, at: string): boolean {
  return instant(at) >= instant(grant.expires_at);
}

/** Where the verifying material comes from: the key set as fetched, or a getter over whatever a
 * poller most recently fetched — so a long-lived verifier follows a rotation without rebuilding. */
export type KeySource = readonly PublishedKey[] | (() => readonly PublishedKey[]);

export interface GrantVerifierOptions {
  /** Exactly what `GET /keys` served: `{key_id, alg, public_key, not_after?}` entries. */
  readonly keys: KeySource;
  readonly now?: Clock;
}

/** Verify one presented grant, or refuse with a graded {@link GrantError}. */
export type GrantVerifier = (presented: unknown) => IssuedGrant;

/**
 * Build a verifier over a published key set. This is the seam downstream enforcement consumes:
 * poll `/keys`, hold the answer, verify locally, and grade a refusal the way the router does.
 */
export function createGrantVerifier(options: GrantVerifierOptions): GrantVerifier {
  const now = options.now ?? (() => new Date().toISOString());
  const source = options.keys;
  const keysOf = typeof source === 'function' ? source : (): readonly PublishedKey[] => source;
  return (presented: unknown): IssuedGrant => {
    const grant = parseIssuedGrant(presented);
    const at = now();
    const material = keysOf().find((key) => key.key_id === grant.signature.key_id);
    if (material === undefined) {
      // Either it was never minted here, or its overlap window ended and it left the key set.
      // Both are the same answer to the caller: there is nothing here to trust this against.
      throw new GrantError(
        403,
        `no published key ${JSON.stringify(grant.signature.key_id)} to verify this grant against`,
      );
    }
    if (material.not_after !== undefined && instant(at) >= instant(material.not_after)) {
      throw new GrantError(
        403,
        `key ${JSON.stringify(material.key_id)} retired at ${material.not_after}`,
      );
    }
    if (material.alg !== grant.signature.alg) {
      throw new GrantError(
        403,
        `key ${JSON.stringify(material.key_id)} signs ${material.alg}, not ${JSON.stringify(grant.signature.alg)}`,
      );
    }
    if (!verifyGrantSignature(grant, publicKeyFrom(material))) {
      throw new GrantError(403, 'the grant signature does not cover these claims');
    }
    if (isExpired(grant, at)) {
      throw new GrantError(403, `the grant expired at ${grant.expires_at}`);
    }
    return grant;
  };
}

/** Verify one grant without keeping a verifier around. {@link createGrantVerifier} is the shape
 * to reach for when the key set is polled rather than passed once. */
export function verifyGrant(presented: unknown, options: GrantVerifierOptions): IssuedGrant {
  return createGrantVerifier(options)(presented);
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
