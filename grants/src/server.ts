/**
 * The issuer as an HTTP service — the surface a control-plane host actually mints against.
 *
 * Three routes and no more: `GET /describe` (what this is, and what it will not do),
 * `POST /grants` (one request, one signed grant) and `GET /keys` (the public material a relying
 * party verifies with, so verification never has to dial back per request).
 *
 * A refusal here IS an HTTP error, unlike the knowledge bridge's per-record receipts: a mint is
 * one indivisible decision. The status comes off {@link GrantError} so it is graded the way
 * `apr_grant:parse/1` grades — 403 you are not authorized, 422 you sent something unreadable —
 * and an operator reading two logs sees one vocabulary.
 *
 * The issuer mints; it does not enforce, proxy, or hold anybody's traffic. Presenting a grant is
 * the caller's business and checking it is the relying party's (ADR-0001 decision 3's shape,
 * applied to auth: hand back a credential, never stand in the path).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { SPEC_VERSIONS } from '@agora/schemas';

import { GRANT_VERBS, GrantError } from './grant.ts';
import { GRANT_ISSUER_IDENTITY, type GrantIssuer } from './issuer.ts';

/** A bound address — what {@link GrantService.listen} resolves to. */
export interface ServiceAddress {
  host: string;
  port: number;
}

/** A running issuance surface. */
export interface GrantService {
  readonly issuer: GrantIssuer;
  readonly server: Server;
  /** Start listening. `port` 0 (the default) picks an ephemeral port for tests. */
  listen(port?: number, host?: string): Promise<ServiceAddress>;
  close(): Promise<void>;
}

/** What this service is, on its own surface — the invariants, asserted rather than documented. */
export interface IssuerDescription {
  identity: string;
  kcbVersion: string;
  /** The §4 verbs this issuer will mint. Nothing outside the spec's set is mintable. */
  verbs: readonly string[];
  /** Always false: a grant is minted, handed back, and forgotten. The issuer keeps no ledger of
   * who holds what — a relying party enforces what is presented to it. */
  retainsGrants: false;
  /** Always false: the issuer hands back a credential and never stands in the caller's path. */
  proxiesTraffic: false;
  routes: readonly string[];
}

export function describeGrantIssuer(): IssuerDescription {
  return {
    identity: GRANT_ISSUER_IDENTITY,
    kcbVersion: SPEC_VERSIONS.kcb,
    verbs: GRANT_VERBS,
    retainsGrants: false,
    proxiesTraffic: false,
    routes: ['GET /describe', 'POST /grants', 'GET /keys'],
  };
}

/** Build a service around one issuer. Nothing listens until {@link GrantService.listen}. */
export function createGrantServer(issuer: GrantIssuer): GrantService {
  const server = createServer((req, res) => {
    void handle(req, res, issuer);
  });
  return {
    issuer,
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

async function handle(req: IncomingMessage, res: ServerResponse, issuer: GrantIssuer): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://grants.local');
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'GET' && (path === '/' || path === '/describe')) {
      return sendJson(res, 200, describeGrantIssuer());
    }
    if (method === 'GET' && path === '/keys') {
      return sendJson(res, 200, { keys: issuer.publicKeys() });
    }
    if (method === 'POST' && path === '/grants') {
      return sendJson(res, 201, issuer.issue(await readJson(req)));
    }

    sendJson(res, 404, { error: 'NotFound', message: `no route for ${method} ${path}` });
  } catch (err) {
    if (err instanceof GrantError) {
      sendJson(res, err.status, { error: err.name, message: err.message });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'InternalError', message });
    }
  }
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
        reject(new GrantError(422, 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
