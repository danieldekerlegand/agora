/**
 * Signing keys, and the keyring that rotates them — the other half of what KCB §5 leaves to
 * "the control-plane host's infra": *"full auth mechanics (token issuance, rotation, identity
 * providers) live in the control-plane host's infra"*.
 *
 * Rotation is the part a single key cannot express. A grant is a bearer credential already in
 * somebody else's hands when the key under it changes, so a rotation that took effect instantly
 * would refuse every grant in flight — the relying party would read a valid signature under a
 * key it no longer has. So a rotation is two events, not one:
 *
 *   **rotate**  the new key becomes the minting key; the outgoing key keeps *verifying* for a
 *               declared overlap window, and keeps being published while it does.
 *   **retire**  the overlap ends (by reaching `not_after`, or by an operator ending it early);
 *               the key stops verifying and disappears from the published set.
 *
 * The overlap window is therefore the longest a grant may outlive its key, and a host sets it
 * against the lifetime of the grants it mints — not the other way round.
 *
 * The published material is what a relying party polls (`GET /keys`) and hands to
 * {@link ./verify.ts}, `not_after` included: a poller that fetched mid-overlap can still tell
 * *when* the key it holds stops counting, without dialing back to ask.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

import { GrantError } from './grant.ts';

/** The signing algorithm. Asymmetric, so verification needs public material and nothing else. */
export const GRANT_SIGNING_ALG = 'ed25519';

/** How long an outgoing key keeps verifying by default: one day, comfortably longer than the
 * default grant lifetime, so no grant minted before a rotation dies of it. */
export const DEFAULT_OVERLAP_MS = 24 * 60 * 60 * 1000;

/** A signing key. The private half never leaves the issuer; the public half is publishable. */
export interface SigningKey {
  readonly key_id: string;
  readonly alg: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

/** A key that no longer mints, still verifying until `not_after`. */
export interface RetiringKey {
  readonly key: SigningKey;
  /** ISO-8601 UTC. The instant the key stops verifying — the end of its overlap window. */
  readonly not_after: string;
}

/** The public half of a signing key, in the form a relying party can be handed. */
export interface PublicKeyMaterial {
  readonly key_id: string;
  readonly alg: string;
  /** The SPKI DER of the public key, base64url — self-describing, no key format to negotiate. */
  readonly public_key: string;
}

/** Published material: the public half, plus when it stops counting if it is on its way out. */
export interface PublishedKey extends PublicKeyMaterial {
  /** ISO-8601 UTC, present only while the key is inside its overlap window. */
  readonly not_after?: string;
}

/** A clock, so a test can drive rotation without waiting for one. ISO-8601 UTC, as in
 * `knowledge/src/sync.ts` — a timestamp that travels is a timestamp that reads the same. */
export type Clock = () => string;

export interface KeyringOptions {
  /** The key grants are minted under. */
  readonly key: SigningKey;
  /** Keys already on their way out — a redeploy adopting the outgoing key mid-rotation. */
  readonly previous?: readonly RetiringKey[];
  readonly now?: Clock;
}

/** The keys an issuer signs and verifies with, over time. */
export interface Keyring {
  /** The key grants are minted under right now. */
  readonly current: SigningKey;
  /** The keys still inside their overlap window — verifying, no longer minting. */
  readonly previous: readonly RetiringKey[];
  /**
   * Mint under `next` from now on, keeping the outgoing key verifying for `overlapMs`
   * (default {@link DEFAULT_OVERLAP_MS}). Returns the outgoing key and its retirement instant.
   */
  rotate(next: SigningKey, options?: { readonly overlapMs?: number }): RetiringKey;
  /** End an overlap early: the key stops verifying and stops being published, now. */
  retire(key_id: string): void;
  /** The key that verifies `key_id` at `at`, or nothing if it is unknown or retired. */
  verifying(key_id: string, at?: string): SigningKey | undefined;
  /** The material to publish at `at`: the current key, then whatever is still in overlap. */
  published(at?: string): readonly PublishedKey[];
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

/** Read an ISO-8601 instant, refusing one that is not one — a clock a verifier cannot read is
 * an authorization input it must not guess at. */
export function instant(iso: string): number {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    throw new GrantError(422, `${JSON.stringify(iso)} is not an ISO-8601 instant`);
  }
  return at;
}

/** The keyring's own spelling of an instant: ISO-8601 UTC, millisecond precision. */
export function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function createKeyring(options: KeyringOptions): Keyring {
  const now = options.now ?? (() => new Date().toISOString());
  let current = options.key;
  let previous: readonly RetiringKey[] = [...(options.previous ?? [])];
  assertDistinct(current, previous);

  /** The previous keys still inside their window at `at`. A key at exactly `not_after` is out:
   * the window is the time the key verifies, and it has just stopped. */
  const live = (at: string): readonly RetiringKey[] => {
    const cutoff = instant(at);
    return previous.filter((entry) => instant(entry.not_after) > cutoff);
  };

  return {
    get current() {
      return current;
    },
    get previous() {
      return live(now());
    },
    rotate(next, rotateOptions): RetiringKey {
      const overlapMs = rotateOptions?.overlapMs ?? DEFAULT_OVERLAP_MS;
      if (!Number.isFinite(overlapMs) || overlapMs < 0) {
        throw new GrantError(422, 'a rotation overlap is a non-negative number of milliseconds');
      }
      const at = now();
      const outgoing = live(at);
      if (next.key_id === current.key_id || outgoing.some((e) => e.key.key_id === next.key_id)) {
        // Two keys under one key_id is not a rotation, it is an ambiguity: a relying party
        // resolving a signature by key_id would have no way to say which one signed.
        throw new GrantError(422, `key_id ${JSON.stringify(next.key_id)} is already in the keyring`);
      }
      const retiring: RetiringKey = { key: current, not_after: isoAt(instant(at) + overlapMs) };
      previous = [retiring, ...outgoing];
      current = next;
      return retiring;
    },
    retire(key_id): void {
      if (key_id === current.key_id) {
        // An issuer with no minting key cannot mint; rotate onto the successor first.
        throw new GrantError(422, `${JSON.stringify(key_id)} is the current key — rotate first`);
      }
      const at = now();
      const remaining = live(at).filter((entry) => entry.key.key_id !== key_id);
      if (remaining.length === live(at).length) {
        throw new GrantError(422, `no key ${JSON.stringify(key_id)} to retire`);
      }
      previous = remaining;
    },
    verifying(key_id, at = now()): SigningKey | undefined {
      if (key_id === current.key_id) return current;
      return live(at).find((entry) => entry.key.key_id === key_id)?.key;
    },
    published(at = now()): readonly PublishedKey[] {
      return [
        publicMaterial(current),
        ...live(at).map((entry) => ({ ...publicMaterial(entry.key), not_after: entry.not_after })),
      ];
    },
  };
}

function assertDistinct(current: SigningKey, previous: readonly RetiringKey[]): void {
  const ids = new Set([current.key_id]);
  for (const entry of previous) {
    instant(entry.not_after);
    if (ids.has(entry.key.key_id)) {
      throw new GrantError(422, `key_id ${JSON.stringify(entry.key.key_id)} appears twice`);
    }
    ids.add(entry.key.key_id);
  }
}
