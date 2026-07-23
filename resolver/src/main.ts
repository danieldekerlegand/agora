/**
 * The resolver's standalone entry point — boot the HTTP surface from the process
 * environment, the same standalone-run pattern the provider-router and registry use (config
 * parsed once from an env mapping, the service built from it).
 *
 * The defaults are the point: with nothing set, {@link resolverLaunchFromEnv} yields the
 * degraded-but-not-broken local resolver on `127.0.0.1`, so `node src/main.ts` boots a
 * working resolver immediately — it resolves well-formed KINP ids to themselves and refuses
 * a name loudly (§4). Pointing it at an authority and giving it durable paths is two env
 * vars each, no code change.
 *
 *   AGORA_RESOLVER_HOST      bind host        (default 127.0.0.1)
 *   AGORA_RESOLVER_PORT      bind port        (default 8788)
 *   AGORA_RESOLVER_AUTHORITY authority base URL — dials Pinakes when set, local when not
 *   AGORA_RESOLVER_IDENTITY  KINP identity of the authority (provenance / error messages)
 *   AGORA_RESOLVER_CACHE     durable cache path — offline replays come back authority:'cache'
 *   AGORA_RESOLVER_LINKS     durable same_as/based_on + review-queue store path
 *
 * Nothing here relaxes the invariant the service is built on: the routes are `resolve` and
 * `reconcile`, the service carries identity and never a payload, and a cache replay is
 * labelled `cache`, never `pinakes` (§8, §11 decision 1).
 */
import { pathToFileURL } from 'node:url';

import { createFileCache, createFileLinkStore } from './persistence.ts';
import { createResolverServer, type ResolverServerOptions, type ResolverService } from './server.ts';

/** The environment slice the entry point reads — a plain mapping, so a test can pass its own. */
export type ResolverEnv = Record<string, string | undefined>;

/** Where the service binds with nothing configured — safe to run immediately. */
export const DEFAULT_RESOLVER_HOST = '127.0.0.1';
export const DEFAULT_RESOLVER_PORT = 8788;

/** A parsed launch: the server options plus the address to bind. */
export interface ResolverLaunch {
  options: ResolverServerOptions;
  host: string;
  port: number;
}

/**
 * Parse a launch out of an environment mapping. Zero-config: an empty env yields the local
 * resolver on the default address, degraded (no authority) but immediately usable.
 */
export function resolverLaunchFromEnv(env: ResolverEnv = {}): ResolverLaunch {
  const options: ResolverServerOptions = {};
  const authority = env.AGORA_RESOLVER_AUTHORITY?.trim();
  if (authority) options.authority = authority;
  const identity = env.AGORA_RESOLVER_IDENTITY?.trim();
  if (identity) options.authorityIdentity = identity;
  const cachePath = env.AGORA_RESOLVER_CACHE?.trim();
  if (cachePath) options.cache = createFileCache(cachePath);
  const linksPath = env.AGORA_RESOLVER_LINKS?.trim();
  if (linksPath) options.links = createFileLinkStore(linksPath);
  const host = env.AGORA_RESOLVER_HOST?.trim() || DEFAULT_RESOLVER_HOST;
  const port = parsePort(env.AGORA_RESOLVER_PORT, DEFAULT_RESOLVER_PORT, 'AGORA_RESOLVER_PORT');
  return { options, host, port };
}

/** A bound, running resolver — what {@link startResolver} resolves to. */
export interface StartedResolver {
  service: ResolverService;
  host: string;
  port: number;
}

/** Build the service from the environment and start listening. */
export async function startResolver(env: ResolverEnv = {}): Promise<StartedResolver> {
  const { options, host, port } = resolverLaunchFromEnv(env);
  const service = createResolverServer(options);
  const address = await service.listen(port, host);
  return { service, host: address.host, port: address.port };
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
  startResolver(process.env)
    .then(({ host, port }) => {
      console.log(`agora-resolver listening on http://${host}:${port}`);
    })
    .catch((err: unknown) => {
      console.error('agora-resolver failed to start:', err);
      process.exitCode = 1;
    });
}
