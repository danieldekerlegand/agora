/**
 * The resolver as an HTTP service — the same seam over the wire instead of only as an
 * `import`. It exposes identity.md §8's two verbs, `resolve` and `reconcile`, delegating to
 * the existing {@link Resolver}: {@link createLocalResolver} by default, and
 * {@link createAuthorityResolver} when an authority endpoint is configured — the same wiring
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
 * `authority:'cache'` (never `'authority'`) and, with nothing cached, surfaces
 * {@link AuthorityUnreachableError} as a 502 — the upstream-authority analogue of the
 * registry's `CrawlError`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { KinpKind } from '@agora/schemas';

import { createMemoryCache, type ResolverCache } from './cache.ts';
import { createLocalResolver, describeResolver } from './index.ts';
import {
  createGroundingResolver,
  GroundingPackError,
  type GroundingOptions,
  type GroundingResolver,
} from './grounding.ts';
import type { LinkStore } from './persistence.ts';
import { createAuthorityResolver, type AuthorityFetch } from './authority.ts';
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
   * defaults to {@link createLocalResolver} (or a dialing one when an authority is given). */
  resolver?: Resolver;
  /** The authority's base URL, as the registry would hand it back. When set (and no explicit
   * `resolver` is passed) the service dials it via {@link createAuthorityResolver}; when unset
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
  /** The durable equivalence-layer store (applied / reviewQueue). Ignored unless an authority
   * resolver is built here (§11 decision 2). */
  links?: LinkStore;
  /**
   * Grounding-pack ingest options (KGP §5/§7.1/§7.2 gating, the merge policy the ingested links
   * are held to). The service always mounts the ingest surface — with nothing ingested the
   * grounding resolver answers exactly as its delegate does — so this only tunes it.
   */
  grounding?: Omit<GroundingOptions, 'delegate'>;
}

/** A bound address — what {@link ResolverService.listen} resolves to. */
export interface ServiceAddress {
  host: string;
  port: number;
}

/** A running resolver HTTP surface. */
export interface ResolverService {
  /**
   * The resolver behind the service — the same seam the routes delegate to. It is always a
   * {@link GroundingResolver}: the configured resolver, wrapped so an ingested pack's `same_as`
   * edges join the query-time closure it computes (KINP §4.1).
   */
  readonly resolver: GroundingResolver;
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

/**
 * Build the resolver an {@link ResolverServerOptions} describes, and wrap it so grounding packs
 * can be ingested against it.
 *
 * The wrap is unconditional and costs nothing when nothing has been ingested: with an empty
 * equivalence layer the grounding resolver returns its delegate's answer unchanged, and defers
 * `reconcile` to it entirely — so the authority-free service still refuses a name loudly rather
 * than inventing an id.
 */
function resolverFor(options: ResolverServerOptions): GroundingResolver {
  // The durable link store and the merge policy belong to whichever resolver actually *decides*
  // links, and to exactly one of them — two owners would rehydrate the same list twice and
  // double-count every write. An authority delegate is that decider and already holds them
  // (`delegateFor`); a plain local resolver has no ledger at all, so the wrapper is.
  const owns = options.authority === undefined && options.resolver === undefined;
  return createGroundingResolver({
    ...options.grounding,
    delegate: delegateFor(options),
    ...(owns && options.links !== undefined ? { links: options.links } : {}),
    ...(owns && options.policy !== undefined ? { policy: options.policy } : {}),
  });
}

function delegateFor(options: ResolverServerOptions): Resolver {
  if (options.resolver) return options.resolver;
  if (options.authority === undefined) return createLocalResolver();
  const dialed: Parameters<typeof createAuthorityResolver>[0] = { endpoint: options.authority };
  if (options.fetch !== undefined) dialed.fetch = options.fetch;
  if (options.cache !== undefined) dialed.cache = options.cache;
  else dialed.cache = createMemoryCache();
  if (options.policy !== undefined) dialed.policy = options.policy;
  if (options.authorityIdentity !== undefined) dialed.identity = options.authorityIdentity;
  if (options.links !== undefined) dialed.links = options.links;
  return createAuthorityResolver(dialed);
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
  resolver: GroundingResolver,
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
    } else if (err instanceof GroundingPackError) {
      // A pack this consumer must not hold (§5 dialect, §7.2 egress) or cannot read. The
      // violations ride along because §7.2 requires reporting, not silent dropping.
      sendJson(res, 400, {
        error: err.name,
        code: err.code,
        message: err.message,
        violations: err.violations,
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
  resolver: GroundingResolver,
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

  // Ingest a KGP GroundingPack (§2) into the equivalence layer. Still not a relay: what is
  // submitted is world knowledge and the `same_as`/`based_on` edges over it, and what comes back
  // is a report of what was admitted, queued and refused. Nothing is forwarded anywhere, and
  // nothing is stored merged — `resolve` walks the closure per call (KINP §4.1).
  if (method === 'POST' && path === '/grounding-packs') {
    return sendJson(res, 200, resolver.ingest(await readJson(req)));
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
