/**
 * The issuer's standalone entry point — boot the issuance surface from the process environment.
 *
 *   AGORA_GRANTS_KEY_ID       the `key_id` grants are minted under (default: `issuer-1`)
 *   AGORA_GRANTS_KEY          an ed25519 private key in PEM, if the host supplies its own material
 *   AGORA_GRANTS_LIFETIME     how long a minted grant counts for, in seconds (default: 3600)
 *   AGORA_GRANTS_PREVIOUS_KEY_ID  the key being rotated OUT, kept verifying through the overlap
 *   AGORA_GRANTS_PREVIOUS_KEY     that key's private PEM (only its public half is ever used)
 *   AGORA_GRANTS_OVERLAP      how long the outgoing key keeps verifying, in seconds (default: 86400)
 *   AGORA_GRANTS_CEILINGS     the operator's spend caps as JSON (default: no caps declared)
 *   AGORA_GRANTS_HOST/_PORT   bind address (default 127.0.0.1:8791)
 *
 * With no `AGORA_GRANTS_KEY` the process generates an ephemeral key pair at boot. That is right
 * for a demo and wrong for a deployment — an ephemeral key means every restart invalidates every
 * grant in flight — so the log line says which of the two happened.
 *
 * **Rotation without a rotation route.** A deployment rotates by restarting with the successor
 * as `AGORA_GRANTS_KEY` and the incumbent demoted to `AGORA_GRANTS_PREVIOUS_KEY`: new grants are
 * minted under the successor, the grants already in callers' hands keep verifying until the
 * overlap runs out, and the published key set says exactly when that is. The overlap therefore
 * belongs on the deploy, where the operator is, rather than on an open HTTP surface where
 * anybody who can ask for a grant could retire everybody else's key.
 */
import { pathToFileURL } from 'node:url';

import { createGrantIssuer, DEFAULT_GRANT_LIFETIME_MS } from './issuer.ts';
import {
  createSigningKey,
  DEFAULT_OVERLAP_MS,
  isoAt,
  signingKeyFrom,
  type RetiringKey,
  type SigningKey,
} from './keys.ts';
import { parseCeilingPolicy, UNCAPPED_POLICY, type CeilingPolicy } from './policy.ts';
import { createGrantServer, type GrantService } from './server.ts';

/** The environment slice the entry point reads — a plain mapping, so a test can pass its own. */
export type GrantsEnv = Record<string, string | undefined>;

export const DEFAULT_GRANTS_HOST = '127.0.0.1';
export const DEFAULT_GRANTS_PORT = 8791;
export const DEFAULT_KEY_ID = 'issuer-1';

/** The configuration a launch resolves to, before anything is bound. */
export interface GrantsLaunch {
  key: SigningKey;
  /** True when the key was generated at boot rather than supplied by the host. */
  ephemeralKey: boolean;
  /** The key being rotated out, if this boot is the second half of a rotation. */
  previousKeys: readonly RetiringKey[];
  /** How long a minted grant counts for. */
  lifetimeMs: number;
  /** The operator's spend caps, applied to every mint and every derivation. */
  ceilings: CeilingPolicy;
  host: string;
  port: number;
}

export function grantsLaunchFromEnv(env: GrantsEnv = {}, at = new Date().toISOString()): GrantsLaunch {
  const keyId = env.AGORA_GRANTS_KEY_ID?.trim() || DEFAULT_KEY_ID;
  const pem = env.AGORA_GRANTS_KEY?.trim();
  const supplied = pem !== undefined && pem !== '';
  const overlapMs = parseSeconds(env.AGORA_GRANTS_OVERLAP, DEFAULT_OVERLAP_MS, 'AGORA_GRANTS_OVERLAP');
  return {
    key: supplied ? signingKeyFrom(keyId, pem) : createSigningKey(keyId),
    ephemeralKey: !supplied,
    previousKeys: previousFromEnv(env, Date.parse(at) + overlapMs),
    lifetimeMs: parseSeconds(env.AGORA_GRANTS_LIFETIME, DEFAULT_GRANT_LIFETIME_MS, 'AGORA_GRANTS_LIFETIME'),
    ceilings: ceilingsFromEnv(env),
    host: env.AGORA_GRANTS_HOST?.trim() || DEFAULT_GRANTS_HOST,
    port: parsePort(env.AGORA_GRANTS_PORT, DEFAULT_GRANTS_PORT, 'AGORA_GRANTS_PORT'),
  };
}

/** The outgoing half of a rotation. Both halves or neither: a key id with no key verifies
 * nothing, and a key with no id cannot be named by the signature that needs it. */
function previousFromEnv(env: GrantsEnv, notAfterMs: number): readonly RetiringKey[] {
  const keyId = env.AGORA_GRANTS_PREVIOUS_KEY_ID?.trim();
  const pem = env.AGORA_GRANTS_PREVIOUS_KEY?.trim();
  if (!keyId && !pem) return [];
  if (!keyId || !pem) {
    throw new Error(
      'AGORA_GRANTS_PREVIOUS_KEY_ID and AGORA_GRANTS_PREVIOUS_KEY are set together or not at all',
    );
  }
  return [{ key: signingKeyFrom(keyId, pem), not_after: isoAt(notAfterMs) }];
}

/**
 * The operator's ceiling policy, as JSON: `{"mode":"clamp","caps":[{"scope":"*","max_units":100}]}`.
 *
 * Unset means no caps declared, which is not the same as a cap of zero: a host that has said
 * nothing about spend has not authorized a limit either, and inventing one here would refuse
 * work the operator never asked to have refused. Saying it *badly*, though, is a boot failure
 * rather than a silently ignored setting — a cap that does not parse is a cap that is not
 * applied, and a policy nobody notices is missing is the whole failure mode caps exist to close.
 */
function ceilingsFromEnv(env: GrantsEnv): CeilingPolicy {
  const raw = env.AGORA_GRANTS_CEILINGS?.trim();
  if (raw === undefined || raw === '') return UNCAPPED_POLICY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AGORA_GRANTS_CEILINGS must be a JSON ceiling policy');
  }
  return parseCeilingPolicy(parsed);
}

/** A bound, running issuer. */
export interface StartedGrantIssuer {
  service: GrantService;
  ephemeralKey: boolean;
  host: string;
  port: number;
}

export async function startGrantIssuer(env: GrantsEnv = {}): Promise<StartedGrantIssuer> {
  const launch = grantsLaunchFromEnv(env);
  const service = createGrantServer(
    createGrantIssuer({
      key: launch.key,
      previousKeys: launch.previousKeys,
      lifetimeMs: launch.lifetimeMs,
      ceilings: launch.ceilings,
    }),
  );
  const address = await service.listen(launch.port, launch.host);
  return { service, ephemeralKey: launch.ephemeralKey, host: address.host, port: address.port };
}

/** Seconds in the environment, milliseconds in the code — a duration on a wire is seconds
 * everywhere else in this tree, and a millisecond-denominated env var is a footgun. */
function parseSeconds(raw: string | undefined, fallbackMs: number, name: string): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return fallbackMs;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive number of seconds, got ${JSON.stringify(raw)}`);
  }
  return seconds * 1000;
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return fallback;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be a valid TCP port (0-65535), got ${JSON.stringify(raw)}`);
  }
  return port;
}

// When run directly (`node src/main.ts`), boot the service; when imported, export only.
const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  startGrantIssuer(process.env)
    .then(({ host, port, ephemeralKey }) => {
      console.log(`agora-grant-issuer listening on http://${host}:${port}`);
      if (ephemeralKey) {
        console.log('signing key generated at boot — set AGORA_GRANTS_KEY to survive a restart');
      }
    })
    .catch((err: unknown) => {
      console.error('agora-grant-issuer failed to start:', err);
      process.exitCode = 1;
    });
}
