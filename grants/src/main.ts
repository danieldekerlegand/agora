/**
 * The issuer's standalone entry point — boot the issuance surface from the process environment.
 *
 *   AGORA_GRANTS_KEY_ID     the `key_id` grants are minted under (default: `issuer-1`)
 *   AGORA_GRANTS_KEY        an ed25519 private key in PEM, if the host supplies its own material
 *   AGORA_GRANTS_HOST/_PORT bind address (default 127.0.0.1:8791)
 *
 * With no `AGORA_GRANTS_KEY` the process generates an ephemeral key pair at boot. That is right
 * for a demo and wrong for a deployment — an ephemeral key means every restart invalidates every
 * grant in flight — so the log line says which of the two happened.
 */
import { pathToFileURL } from 'node:url';

import { createGrantIssuer, createSigningKey, signingKeyFrom, type SigningKey } from './issuer.ts';
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
  host: string;
  port: number;
}

export function grantsLaunchFromEnv(env: GrantsEnv = {}): GrantsLaunch {
  const keyId = env.AGORA_GRANTS_KEY_ID?.trim() || DEFAULT_KEY_ID;
  const pem = env.AGORA_GRANTS_KEY?.trim();
  const supplied = pem !== undefined && pem !== '';
  return {
    key: supplied ? signingKeyFrom(keyId, pem) : createSigningKey(keyId),
    ephemeralKey: !supplied,
    host: env.AGORA_GRANTS_HOST?.trim() || DEFAULT_GRANTS_HOST,
    port: parsePort(env.AGORA_GRANTS_PORT, DEFAULT_GRANTS_PORT, 'AGORA_GRANTS_PORT'),
  };
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
  const service = createGrantServer(createGrantIssuer({ key: launch.key }));
  const address = await service.listen(launch.port, launch.host);
  return { service, ephemeralKey: launch.ephemeralKey, host: address.host, port: address.port };
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
