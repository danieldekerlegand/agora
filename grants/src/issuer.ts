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
 *
 * Two things the issuer deliberately does *not* keep: a ledger of what it minted, and a way to
 * mint something that never expires. It keeps no ledger because it is not in the enforcement
 * path and a list it never consults is only a liability; that in turn is why every grant carries
 * an {@link IssuedGrant.expires_at} — with nothing to revoke *from*, ageing out is how a
 * credential stops being one. Key rotation ({@link ./keys.ts}) is the coarse instrument beside
 * it: retiring a key ends every grant signed under it at once.
 */
import { sign } from 'node:crypto';

import { GrantError, parseGrant, type Grant, type IssuedGrant } from './grant.ts';
import {
  createKeyring,
  instant,
  isoAt,
  type Clock,
  type Keyring,
  type PublishedKey,
  type RetiringKey,
  type SigningKey,
} from './keys.ts';
import { canonicalGrantBytes, createGrantVerifier, type GrantVerifier } from './verify.ts';

/** KINP identity of the issuer itself — a control-plane service is a fabric entity too. */
export const GRANT_ISSUER_IDENTITY = 'agora:agent:grant-issuer';

/** How long a minted grant counts for, unless the host says otherwise: one hour. Short enough
 * that a retired key is not the only way a grant ever stops, long enough for a real chain of
 * invocations to complete under one credential. */
export const DEFAULT_GRANT_LIFETIME_MS = 60 * 60 * 1000;

/** What a caller asks for. `scope` may carry the whole `<verb>:<scope>` token instead. */
export interface GrantRequest {
  readonly grantee: string;
  readonly verb?: string | undefined;
  readonly scope: string;
  readonly budget_units?: unknown;
}

export interface GrantIssuerOptions {
  /** The key to mint under. A keyring is built around it; rotate onto the next one in place. */
  readonly key: SigningKey;
  /** Keys already on their way out — a redeploy that adopted the outgoing key mid-rotation. */
  readonly previousKeys?: readonly RetiringKey[];
  /** How long a minted grant counts for. Must be positive: there is no unexpiring grant. */
  readonly lifetimeMs?: number;
  readonly now?: Clock;
}

export interface GrantIssuer {
  /** The key grants are currently minted under. */
  readonly key: SigningKey;
  /** The keys this issuer signs and verifies with, over time. */
  readonly keyring: Keyring;
  /** How long a grant minted now will count for, in milliseconds. */
  readonly lifetimeMs: number;
  /** Mint one grant, or refuse with a graded {@link GrantError}. */
  issue(request: unknown): IssuedGrant;
  /** The public material a relying party verifies with — current key first, then any in overlap. */
  publicKeys(): readonly PublishedKey[];
  /** Mint under `next` from here on; the outgoing key keeps verifying for the overlap window. */
  rotate(next: SigningKey, options?: { readonly overlapMs?: number }): RetiringKey;
  /** End an overlap early — every grant still signed under `key_id` stops verifying. */
  retire(key_id: string): void;
  /** Verify a presented grant against this issuer's own published material. The reusable form
   * for everybody else is `createGrantVerifier` — this is the same function, keys pre-wired. */
  verify(presented: unknown): IssuedGrant;
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

/** Build an issuer over one signing key, rotatable in place. */
export function createGrantIssuer(options: GrantIssuerOptions): GrantIssuer {
  const now = options.now ?? (() => new Date().toISOString());
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_GRANT_LIFETIME_MS;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
    // A zero or absent lifetime is not "no expiry", it is a grant nobody could ever spend or
    // withdraw. The issuer keeps no revocation list, so the lifetime is the only clock there is.
    throw new GrantError(422, 'a grant lifetime must be a positive number of milliseconds');
  }
  const keyring = createKeyring({
    key: options.key,
    ...(options.previousKeys === undefined ? {} : { previous: options.previousKeys }),
    now,
  });
  const verifier: GrantVerifier = createGrantVerifier({ keys: () => keyring.published(), now });

  return {
    get key() {
      return keyring.current;
    },
    keyring,
    lifetimeMs,
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
      const key = keyring.current;
      const unsigned = {
        verb: grant.verb,
        scope: grant.scope,
        ...(grant.budget_units === undefined ? {} : { budget_units: grant.budget_units }),
        grantee: parsed.grantee,
        expires_at: isoAt(instant(now()) + lifetimeMs),
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
      return keyring.published();
    },
    rotate(next, rotateOptions) {
      return keyring.rotate(next, rotateOptions);
    },
    retire(key_id) {
      keyring.retire(key_id);
    },
    verify(presented) {
      return verifier(presented);
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
