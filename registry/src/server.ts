/**
 * The registry as an HTTP service — the same index, reachable over the wire instead of only
 * as an `import`.
 *
 * The invariant this file exists to preserve is the one the whole registry is built on
 * (ADR-0001 decision 3, capability-bus.md §3): **route-by-lookup, never proxy.** Every route
 * here is one of the seven discovery verbs {@link describeRegistry} already names — it hands
 * back a {@link ProviderAddress} / {@link Match} and the caller dials the provider *directly*.
 * There is deliberately no `invoke`, no `proxy`, no route that relays or transforms a peer's
 * payload; an unknown path is a 404, so the traffic-hub shape the ADR rejects cannot be added
 * by accident. `describeRegistry().proxiesTraffic` stays `false` and is asserted over the wire.
 *
 * `register` still flows through {@link CapabilityRegistry.register} (parseManifest, verbatim
 * freezeCopy, wholesale replace, `source:'push'`), so a malformed manifest is a 4xx and never
 * enters the index. The pull path — {@link registerFromWellKnown} — is reachable at `/crawl`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ManifestError, type Plane } from '@agora/schemas';

import { registerFromWellKnown, CrawlError, type ManifestFetch } from './crawl.ts';
import { describeRegistry } from './index.ts';
import { createRegistry, type CapabilityRegistry, type FindQuery } from './registry.ts';

export interface RegistryServerOptions {
  /** The index to serve. Defaults to a fresh in-memory {@link createRegistry}. */
  registry?: CapabilityRegistry;
  /** The `fetch` a `/crawl` uses; defaults to the global. Structural, so a test can stub it. */
  fetch?: ManifestFetch;
}

/** A bound address — what {@link RegistryService.listen} resolves to. */
export interface ServiceAddress {
  host: string;
  port: number;
}

/** A running registry HTTP surface. */
export interface RegistryService {
  /** The index behind the service — the same object across a restart when a store is shared. */
  readonly registry: CapabilityRegistry;
  /** The underlying Node server, for callers that need it (signals, keep-alive tuning). */
  readonly server: Server;
  /** Start listening. `port` 0 (the default) picks an ephemeral port for tests. */
  listen(port?: number, host?: string): Promise<ServiceAddress>;
  /** Stop listening and release the port. */
  close(): Promise<void>;
}

/** A 4xx the handler raises for a bad request; distinct from a bad *manifest*. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Build a service around one {@link CapabilityRegistry}. Nothing listens until
 * {@link RegistryService.listen} is called.
 */
export function createRegistryServer(options: RegistryServerOptions = {}): RegistryService {
  const registry = options.registry ?? createRegistry();
  const fetch = options.fetch;
  const server = createServer((req, res) => {
    void handle(req, res, registry, fetch);
  });

  return {
    registry,
    server,
    listen(port = 0, host = '127.0.0.1'): Promise<ServiceAddress> {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const address = server.address() as AddressInfo;
          resolve({ host, port: address.port });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  registry: CapabilityRegistry,
  fetch: ManifestFetch | undefined,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://registry.local');
    const method = req.method ?? 'GET';
    await route(method, url, req, res, registry, fetch);
  } catch (err) {
    if (err instanceof ManifestError) {
      // A malformed manifest never enters the index — it is the caller's error (§3).
      sendJson(res, 400, { error: err.name, message: err.message });
    } else if (err instanceof HttpError) {
      sendJson(res, err.status, { error: 'BadRequest', message: err.message });
    } else if (err instanceof CrawlError) {
      // The upstream provider's well-known manifest could not be fetched/read.
      sendJson(res, 502, { error: err.name, message: err.message, url: err.url });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'InternalError', message });
    }
  }
}

async function route(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  registry: CapabilityRegistry,
  fetch: ManifestFetch | undefined,
): Promise<void> {
  const path = url.pathname;

  // Description / health: identity + verbs + proxiesTraffic:false, over the wire.
  if (method === 'GET' && (path === '/' || path === '/describe')) {
    return sendJson(res, 200, describeRegistry());
  }

  // register (push): the manifest flows verbatim through CapabilityRegistry.register.
  if (method === 'POST' && path === '/register') {
    const manifest = await readJson(req);
    return sendJson(res, 201, registry.register(manifest, { source: 'push' }));
  }

  // The pull path: crawl a provider's well-known manifest (source:'pull'), never a payload.
  if (method === 'POST' && path === '/crawl') {
    const body = requireObject(await readJson(req));
    const baseUrl = body.baseUrl;
    if (typeof baseUrl !== 'string') throw new HttpError(400, 'crawl requires a string baseUrl');
    const registration = await registerFromWellKnown(registry, baseUrl, fetch ? { fetch } : {});
    return sendJson(res, 201, registration);
  }

  // remove: drop a provider from the index. The provider itself is untouched — this is a cache.
  if (method === 'POST' && path === '/remove') {
    const body = requireObject(await readJson(req));
    const identity = body.identity;
    if (typeof identity !== 'string') throw new HttpError(400, 'remove requires a string identity');
    return sendJson(res, 200, { removed: registry.remove(identity) });
  }

  if (method === 'GET' && path === '/list') {
    return sendJson(res, 200, registry.list());
  }

  if (method === 'GET' && path === '/get') {
    const registration = registry.get(requireIdentity(url));
    return registration
      ? sendJson(res, 200, registration)
      : sendJson(res, 404, { error: 'NotFound', message: 'no such provider' });
  }

  // address: where to dial a provider. The whole point — the caller connects there directly.
  if (method === 'GET' && path === '/address') {
    const address = registry.address(requireIdentity(url));
    return address
      ? sendJson(res, 200, address)
      : sendJson(res, 404, { error: 'NotFound', message: 'no such provider' });
  }

  // find: ranked Matches, each carrying the address to dial. GET params for the scalar
  // clauses; POST a full FindQuery for the port-shaped ones.
  if (method === 'GET' && path === '/find') {
    return sendJson(res, 200, registry.find(findQueryFromParams(url)));
  }
  if (method === 'POST' && path === '/find') {
    const body = await readJson(req);
    return sendJson(res, 200, registry.find((body ?? {}) as FindQuery));
  }

  // path: a capability plan across providers — addresses to dial in order, never a route here.
  if (method === 'POST' && path === '/path') {
    const body = await readJson(req);
    const plan = registry.path(requireObject(body) as never);
    return plan
      ? sendJson(res, 200, plan)
      : sendJson(res, 404, { error: 'NotFound', message: 'no capability path' });
  }

  // Anything else — including /invoke, /proxy, /forward — is not a verb this service has.
  sendJson(res, 404, { error: 'NotFound', message: `no route for ${method} ${path}` });
}

function findQueryFromParams(url: URL): FindQuery {
  const query: FindQuery = {};
  const capability = url.searchParams.get('capability');
  if (capability !== null) query.capability = capability;
  const plane = url.searchParams.get('plane');
  if (plane !== null) query.plane = plane as Plane;
  const world = url.searchParams.get('world');
  if (world !== null) query.world = world;
  return query;
}

function requireIdentity(url: URL): string {
  const identity = url.searchParams.get('identity');
  if (identity === null) throw new HttpError(400, 'identity query parameter is required');
  return identity;
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'expected a JSON object body');
  }
  return body as Record<string, unknown>;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}
