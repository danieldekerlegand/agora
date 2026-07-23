/**
 * The resolver as an HTTP service — the same seam over the wire instead of only as an
 * `import`. It exposes identity.md §8's two verbs, `resolve` and `reconcile`, delegating to
 * the existing {@link Resolver}: {@link createLocalResolver} by default, and
 * {@link createPinakesResolver} when an authority endpoint is configured — the same wiring
 * the console does in-process.
 *
 * The invariant here is the resolver's, and it is the registry's too (ADR-0001 decision 3):
 * **the service carries identity, never a payload.** `resolve` hands back a
 * {@link ResolvedIdentity} and `reconcile` a {@link ReconciliationResult}; the caller then
 * dials whoever that turns out to be. There is deliberately no `invoke`, no `link`, no route
 * that relays or transforms a payload; an unknown path is a 404, so the transform-gateway
 * shape §8 rejects ("a thin service over the fabric … not a transform gateway") cannot be
 * added by accident.
 *
 * Degradation is preserved on the wire, because it lives in the {@link Resolver} the routes
 * delegate to: with no authority, an un-mintable name and `reconcile` are refused loudly as
 * {@link ResolverUnavailableError} (a 400 — like the registry's malformed-manifest refusal);
 * with an authority configured but unreachable, `resolve` replays the cache labelled
 * `authority:'cache'` (never `'pinakes'`) and, with nothing cached, surfaces
 * {@link AuthorityUnreachableError} as a 502 — the upstream-authority analogue of the
 * registry's `CrawlError`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { KinpKind } from '@agora/schemas';

import { createMemoryCache, type ResolverCache } from './cache.ts';
import { createLocalResolver, describeResolver } from './index.ts';
import { createPinakesResolver, type AuthorityFetch } from './pinakes.ts';
import type { MergePolicy } from './policy.ts';
import {
  AuthorityUnreachableError,
  ResolverUnavailableError,
  type EntityRef,
  type ReconciliationQuery,
  type Resolver,
} from './types.ts';

export interface ResolverServerOptions {
  /** The resolver to serve. Takes precedence over {@link ResolverServerOptions.authority};
   * defaults to {@link createLocalResolver} (or a Pinakes one when an authority is given). */
  resolver?: Resolver;
  /** The authority's base URL, as the registry would hand it back. When set (and no explicit
   * `resolver` is passed) the service dials it via {@link createPinakesResolver}; when unset
   * the service is the degraded, authority-free local resolver. */
  authority?: string;
  /** The `fetch` the authority client uses; defaults to the global. Structural, so a test can
   * stub it. Ignored unless {@link ResolverServerOptions.authority} builds the resolver. */
  fetch?: AuthorityFetch;
  /** The cache that offline resolves replay from (§8). Ignored unless an authority resolver is
   * built here. */
  cache?: ResolverCache;
  /** Merge-policy overrides (§11 decision 2). Ignored unless an authority resolver is built. */
  policy?: Partial<MergePolicy>;
  /** KINP identity of the authority, for error messages and provenance. */
  authorityIdentity?: string;
}

/** A bound address — what {@link ResolverService.listen} resolves to. */
export interface ServiceAddress {
  host: string;
  port: number;
}

/** A running resolver HTTP surface. */
export interface ResolverService {
  /** The resolver behind the service — the same seam the routes delegate to. */
  readonly resolver: Resolver;
  /** The underlying Node server, for callers that need it (signals, keep-alive tuning). */
  readonly server: Server;
  /** Start listening. `port` 0 (the default) picks an ephemeral port for tests. */
  listen(port?: number, host?: string): Promise<ServiceAddress>;
  /** Stop listening and release the port. */
  close(): Promise<void>;
}

/** A 4xx the handler raises for a malformed request; distinct from a resolver refusal. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Build the resolver an {@link ResolverServerOptions} describes. */
function resolverFor(options: ResolverServerOptions): Resolver {
  if (options.resolver) return options.resolver;
  if (options.authority === undefined) return createLocalResolver();
  const pinakes: Parameters<typeof createPinakesResolver>[0] = { endpoint: options.authority };
  if (options.fetch !== undefined) pinakes.fetch = options.fetch;
  if (options.cache !== undefined) pinakes.cache = options.cache;
  else pinakes.cache = createMemoryCache();
  if (options.policy !== undefined) pinakes.policy = options.policy;
  if (options.authorityIdentity !== undefined) pinakes.identity = options.authorityIdentity;
  return createPinakesResolver(pinakes);
}

/**
 * Build a service around one {@link Resolver}. Nothing listens until
 * {@link ResolverService.listen} is called.
 */
export function createResolverServer(options: ResolverServerOptions = {}): ResolverService {
  const resolver = resolverFor(options);
  const server = createServer((req, res) => {
    void handle(req, res, resolver);
  });

  return {
    resolver,
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
  resolver: Resolver,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://resolver.local');
    const method = req.method ?? 'GET';
    await route(method, url, req, res, resolver);
  } catch (err) {
    if (err instanceof AuthorityUnreachableError) {
      // The upstream authority was dialed and could not answer, and nothing was cached — the
      // resolver's analogue of the registry's CrawlError (a 502, not the caller's fault).
      sendJson(res, 502, {
        error: err.name,
        message: err.message,
        authority: err.authorityIdentity,
      });
    } else if (err instanceof ResolverUnavailableError) {
      // A refusal: this resolver structurally cannot answer (no authority, or a name to
      // reconcile). Loud and 4xx, never a guessed id (§4).
      sendJson(res, 400, { error: err.name, message: err.message });
    } else if (err instanceof HttpError) {
      sendJson(res, err.status, { error: 'BadRequest', message: err.message });
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
  resolver: Resolver,
): Promise<void> {
  const path = url.pathname;

  // Description / health: identity + kinpVersion + verbs, over the wire.
  if (method === 'GET' && (path === '/' || path === '/describe')) {
    return sendJson(res, 200, describeResolver());
  }

  // resolve(id[,world]): dereference an identifier into the merged view. GET carries the
  // scalar (id, world) params; POST a full EntityRef so a caller can send name/kind too — and
  // be refused loudly, which is the point (a name is a descriptor, match it with reconcile).
  if (method === 'GET' && path === '/resolve') {
    return sendJson(res, 200, await resolver.resolve(entityRefFromParams(url)));
  }
  if (method === 'POST' && path === '/resolve') {
    const ref = entityRefFromBody(await readJson(req));
    return sendJson(res, 200, await resolver.resolve(ref));
  }

  // reconcile(descriptor): fuzzy-match a descriptor to candidates. POST-only — the descriptor
  // is a structured OpenRefine/Wikidata query, not a scalar.
  if (method === 'POST' && path === '/reconcile') {
    const query = reconciliationQueryFromBody(await readJson(req));
    return sendJson(res, 200, await resolver.reconcile(query));
  }

  // Anything else — including /invoke, /link, /forward — is not a verb this service has.
  sendJson(res, 404, { error: 'NotFound', message: `no route for ${method} ${path}` });
}

function entityRefFromParams(url: URL): EntityRef {
  const ref: EntityRef = {};
  const id = url.searchParams.get('id');
  if (id !== null) ref.id = id;
  const world = url.searchParams.get('world');
  if (world !== null) ref.world = world;
  const name = url.searchParams.get('name');
  if (name !== null) ref.name = name;
  const kind = url.searchParams.get('kind');
  if (kind !== null) ref.kind = kind as KinpKind;
  return ref;
}

function entityRefFromBody(body: unknown): EntityRef {
  const object = requireObject(body);
  const ref: EntityRef = {};
  if (typeof object.id === 'string') ref.id = object.id;
  if (typeof object.world === 'string') ref.world = object.world;
  if (typeof object.name === 'string') ref.name = object.name;
  if (typeof object.kind === 'string') ref.kind = object.kind as KinpKind;
  return ref;
}

function reconciliationQueryFromBody(body: unknown): ReconciliationQuery {
  const object = requireObject(body);
  if (typeof object.query !== 'string') {
    throw new HttpError(400, 'reconcile requires a string query descriptor');
  }
  const query: ReconciliationQuery = { query: object.query };
  if (typeof object.type === 'string') query.type = object.type;
  if (typeof object.limit === 'number') query.limit = object.limit;
  if (Array.isArray(object.properties)) {
    query.properties = object.properties as NonNullable<ReconciliationQuery['properties']>;
  }
  if (typeof object.world === 'string') query.world = object.world;
  if (typeof object.of === 'string') query.of = object.of;
  return query;
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
