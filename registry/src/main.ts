/**
 * The registry's standalone entry point — boot the HTTP surface from the process
 * environment, the same standalone-run pattern the provider-router uses (config parsed once
 * from an env mapping, the service built from it).
 *
 * The defaults are the point: with nothing set, {@link registryLaunchFromEnv} yields an
 * in-memory index with no peers on `127.0.0.1`, so `node src/main.ts` boots a working
 * discovery registry immediately. A deployment layers durability and clustering on with two
 * env vars — a store path and a comma-separated peer list — without touching code.
 *
 *   AGORA_REGISTRY_HOST   bind host       (default 127.0.0.1)
 *   AGORA_REGISTRY_PORT   bind port       (default 8787)
 *   AGORA_REGISTRY_STORE  durable JSON store path — file-backed when set, memory when not
 *   AGORA_REGISTRY_PEERS  comma-separated peer base URLs to replicate register/remove to
 *
 * Nothing here relaxes the invariant the service is built on: the routes are still the seven
 * discovery verbs, `proxiesTraffic` stays `false`, and a peer is a replication target, never
 * a data-plane hop (ADR-0001 decision 3).
 */
import { pathToFileURL } from 'node:url';

import { createRegistryServer, type RegistryServerOptions, type RegistryService } from './server.ts';
import { createFileStore } from './store.ts';

/** The environment slice the entry point reads — a plain mapping, so a test can pass its own. */
export type RegistryEnv = Record<string, string | undefined>;

/** Where the service binds with nothing configured — safe to run immediately. */
export const DEFAULT_REGISTRY_HOST = '127.0.0.1';
export const DEFAULT_REGISTRY_PORT = 8787;

/** A parsed launch: the server options plus the address to bind. */
export interface RegistryLaunch {
  options: RegistryServerOptions;
  host: string;
  port: number;
}

/**
 * Parse a launch out of an environment mapping. Zero-config: an empty env yields an in-memory
 * index with no peers on the default address, which is a working registry the moment it binds.
 */
export function registryLaunchFromEnv(env: RegistryEnv = {}): RegistryLaunch {
  const options: RegistryServerOptions = {};
  const storePath = env.AGORA_REGISTRY_STORE?.trim();
  if (storePath) options.store = createFileStore(storePath);
  const peers = parseList(env.AGORA_REGISTRY_PEERS);
  if (peers.length > 0) options.peers = peers;
  const host = env.AGORA_REGISTRY_HOST?.trim() || DEFAULT_REGISTRY_HOST;
  const port = parsePort(env.AGORA_REGISTRY_PORT, DEFAULT_REGISTRY_PORT, 'AGORA_REGISTRY_PORT');
  return { options, host, port };
}

/** A bound, running registry — what {@link startRegistry} resolves to. */
export interface StartedRegistry {
  service: RegistryService;
  host: string;
  port: number;
}

/** Build the service from the environment and start listening. */
export async function startRegistry(env: RegistryEnv = {}): Promise<StartedRegistry> {
  const { options, host, port } = registryLaunchFromEnv(env);
  const service = createRegistryServer(options);
  const address = await service.listen(port, host);
  return { service, host: address.host, port: address.port };
}

/** Split a comma-separated env value into trimmed, non-empty entries. */
function parseList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Read a port env var, falling back to a default; a non-port value is a loud error, not a guess. */
function parsePort(raw: string | undefined, fallback: number, name: string): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return fallback;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be a valid TCP port (0-65535), got ${JSON.stringify(raw)}`);
  }
  return port;
}

// When run directly (`node src/main.ts`), boot the service; when imported, do nothing but
// export the helpers above. Comparing import.meta.url to argv[1] is the ESM main-module idiom.
const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  startRegistry(process.env)
    .then(({ host, port }) => {
      console.log(`agora-registry listening on http://${host}:${port}`);
    })
    .catch((err: unknown) => {
      console.error('agora-registry failed to start:', err);
      process.exitCode = 1;
    });
}
