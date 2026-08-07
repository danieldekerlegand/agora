/**
 * The knowledge-sync bridge as an HTTP service — the surface a producer actually submits to.
 *
 * Two routes and no more: `GET /describe` (what this is, and what it will not do) and
 * `POST /claims` (one {@link ClaimSubmission}, one {@link SyncReceipt}). KGP defines the
 * payload, not the pipe (§6), so this is the JSON-over-HTTP pipe; an MCP tool or an A2A
 * `message/send` in front of the same {@link KnowledgeSync} carries the identical envelope.
 *
 * A refused claim is **not** an HTTP error. The receipt is 200 with the graded rejections in it,
 * because a batch is admitted per record (§7.1) — a 4xx would tell a producer that its whole
 * submission was malformed when nine claims of ten crossed. A 4xx here means the *submission*
 * was not a submission; a 502 means the consumer refused the pack.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { SPEC_VERSIONS } from '@agora/schemas';

import { PackError } from './pack.ts';
import {
  createKnowledgeSync,
  parseSubmission,
  SyncError,
  type KnowledgeSync,
  type KnowledgeSyncOptions,
} from './sync.ts';

/** A bound address — what {@link SyncService.listen} resolves to. */
export interface ServiceAddress {
  host: string;
  port: number;
}

/** A running knowledge-sync surface. */
export interface SyncService {
  /** The bridge behind the service. */
  readonly sync: KnowledgeSync;
  readonly server: Server;
  /** Start listening. `port` 0 (the default) picks an ephemeral port for tests. */
  listen(port?: number, host?: string): Promise<ServiceAddress>;
  close(): Promise<void>;
}

export type SyncServerOptions =
  | { readonly sync: KnowledgeSync }
  | ({ readonly sync?: undefined } & KnowledgeSyncOptions);

/** What this service is, on its own surface — the invariants, asserted rather than documented. */
export interface SyncDescription {
  identity: string;
  kgpVersion: string;
  /** Always false: a submission is gated, delivered and forgotten. No second copy of anyone's
   * knowledge accumulates in the commons. */
  retainsClaims: false;
  /** Always false: relations come from the shared registry, and an unpublished one is refused
   * rather than coined here (KGP §3.2 rule 1, §9 decision 1). */
  coinsRelations: false;
  /** The routes this build answers. There is no `/store`, no `/query`, and no relay. */
  routes: readonly string[];
}

/** KINP identity of the bridge itself — a data-plane participant is a fabric entity too. */
export const KNOWLEDGE_SYNC_IDENTITY = 'agora:agent:knowledge-sync';

export function describeKnowledgeSync(): SyncDescription {
  return {
    identity: KNOWLEDGE_SYNC_IDENTITY,
    kgpVersion: SPEC_VERSIONS.kgp,
    retainsClaims: false,
    coinsRelations: false,
    routes: ['GET /describe', 'POST /claims'],
  };
}

/** Build a service around one bridge. Nothing listens until {@link SyncService.listen}. */
export function createSyncServer(options: SyncServerOptions): SyncService {
  const sync = options.sync ?? createKnowledgeSync(options);
  const server = createServer((req, res) => {
    void handle(req, res, sync);
  });
  return {
    sync,
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

async function handle(req: IncomingMessage, res: ServerResponse, sync: KnowledgeSync): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://knowledge.local');
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'GET' && (path === '/' || path === '/describe')) {
      return sendJson(res, 200, describeKnowledgeSync());
    }

    if (method === 'POST' && path === '/claims') {
      const submission = parseSubmission(await readJson(req));
      const receipt = await sync.submit(submission);
      // A pack that was built but not delivered means the CONSUMER refused it — an upstream
      // failure, reported as one, with its own words on the receipt. Nothing admitted is not a
      // failure at all: the receipt carries the reasons and the status stays 200.
      const refused = receipt.pack_id !== undefined && !receipt.delivered;
      return sendJson(res, refused ? 502 : 200, receipt);
    }

    sendJson(res, 404, { error: 'NotFound', message: `no route for ${method} ${path}` });
  } catch (err) {
    if (err instanceof SyncError || err instanceof PackError) {
      sendJson(res, 400, { error: err.name, message: err.message });
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
        reject(new SyncError('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
