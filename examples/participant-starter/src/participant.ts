/**
 * The participant starter — the smallest thing that is a discoverable, dial-able peer.
 *
 * Publishing makes you a participant: an **A2A AgentCard** at the well-known path with your
 * **KCB manifest** riding as its one extension (capability-bus.md §2/§6) — plus that manifest
 * as a bare body, which is what a registry crawl pulls (§3) — and one answer to an A2A
 * `message/send` at the address the card advertises. That is the whole contract. A peer reads
 * your card, learns WHERE to dial you and WHAT you can do, and then dials you *directly*
 * — nothing relays on your behalf (ADR-0001 decisions 2-4), so there is no bus to join and no
 * hub to route through. Serve those routes and you are on the fabric.
 *
 * Everything above the plumbing divider is the ~20 lines you copy: change {@link IDENTITY} and
 * {@link CAPABILITY} to describe what you offer, and replace {@link summarize} with your real
 * work. Below the divider is A2A/JSON handling a real deployment would get from an A2A server
 * library; it is spelled out here so the starter needs nothing beyond `@agora/sdk` and Node.
 *
 * Run it:
 *
 * ```sh
 * node src/participant.ts                               # PORT=8790 by default
 * curl localhost:8790/.well-known/agent-card.json       # your card, KCB manifest inside
 * curl localhost:8790/.well-known/kcb-manifest.json     # the same manifest, bare
 * ```
 *
 * The identity and capability below are sample data — a made-up peer, not any real one.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

import {
  embedManifest,
  SPEC_VERSIONS,
  type AgentCard,
  type CapabilityManifest,
  type KnowledgePort,
} from '@agora/sdk';

/** Where A2A publishes an agent card — the address a peer discovers you at (KCB §2/§6). */
export const CARD_PATH = '/.well-known/agent-card.json';

/** Where the bare manifest body is published, for the registry crawl that pulls it in (KCB §3). */
export const MANIFEST_PATH = '/.well-known/kcb-manifest.json';

/** Who this peer is (a KINP id) and the one capability it offers. Sample data — change both. */
export const IDENTITY = 'example:agent:summarizer';
export const CAPABILITY = 'summarize.text';

// ─────────────────────────── the starter: copy from here ───────────────────────────

/** A port typed by the KCB knowledge plane — plain text in, plain text out (KCB §2.1). */
const TEXT: KnowledgePort = { plane: 'knowledge', shape: 'text' };

/** What you can do, and where to dial you for it — your KCB capability manifest (KCB §2). */
export function participantManifest(baseUrl: string): CapabilityManifest {
  return {
    kcb_version: SPEC_VERSIONS.kcb,
    identity: IDENTITY,
    endpoints: { a2a: `${baseUrl}${CARD_PATH}`, manifest: `${baseUrl}${MANIFEST_PATH}` },
    capabilities: [{ name: CAPABILITY, inputs: [TEXT], outputs: [TEXT], cost: { est_units: 0 } }],
  };
}

/** Your AgentCard — that manifest, riding as its single extension (KCB §2/§6). */
export function participantCard(baseUrl: string): AgentCard {
  return embedManifest({ name: IDENTITY, url: baseUrl }, participantManifest(baseUrl));
}

/** Your work — what this peer actually does with a request. Replace this. */
export function summarize(text: string): string {
  const [firstSentence = ''] = text.split(/(?<=[.!?])\s+/);
  return firstSentence.trim() || 'nothing to summarize';
}

/** Serve it: the card and the manifest at their well-known paths, your answer at the card's url. */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
  if (req.url === CARD_PATH) return send(res, 200, participantCard(baseUrl));
  if (req.url === MANIFEST_PATH) return send(res, 200, participantManifest(baseUrl));
  if (req.method === 'POST') return send(res, 200, answer(await readJson(req)));
  send(res, 404, { error: `no route for ${req.method ?? 'GET'} ${req.url ?? '/'}` });
}

// ──────────────────────── the plumbing: an A2A library's job ───────────────────────

/** The participant as a Node server, listening on nothing until you {@link startParticipant}. */
export function createParticipant(): Server {
  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => send(res, 400, { error: String(err) }));
  });
}

/**
 * One A2A `message/send` → one completed Task carrying the answer.
 *
 * The shapes are A2A's own (camelCase keys, `kind`-tagged parts, a kebab-case task state), so
 * any A2A client — the conformance console's `a2a` wire included — reads the reply unchanged.
 */
export function answer(request: unknown): unknown {
  const call = asObject(request);
  return {
    jsonrpc: '2.0',
    id: call.id ?? null,
    result: {
      id: crypto.randomUUID(),
      status: {
        state: 'completed',
        message: {
          role: 'agent',
          parts: [{ kind: 'text', text: summarize(promptOf(call)) }],
          messageId: crypto.randomUUID(),
        },
      },
    },
  };
}

/** Where this starter binds with nothing configured — safe to run immediately. */
export const DEFAULT_PORT = 8790;

/** A bound, running participant — what {@link startParticipant} resolves to. */
export interface StartedParticipant {
  /** The base URL a peer dials; the card is at `${url}${CARD_PATH}`. */
  url: string;
  server: Server;
  close(): Promise<void>;
}

/** Start listening. Port `0` binds an ephemeral port, which is how the test drives it. */
export function startParticipant(
  port: number = DEFAULT_PORT,
  host = '127.0.0.1',
): Promise<StartedParticipant> {
  const server = createParticipant();
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const bound = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${bound.port}`,
        server,
        close: () =>
          new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

/** The text of every `text` part of the message a `message/send` carries. */
function promptOf(call: Record<string, unknown>): string {
  const message = asObject(asObject(call.params).message);
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .map(asObject)
    .filter((part) => part.kind === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

/** A JSON object, or an empty one — this peer never guesses at a shape it was not sent. */
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Read a request body as JSON; an empty body is an empty object. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// When run directly (`node src/participant.ts`), start listening; when imported, export only.
// Comparing import.meta.url to argv[1] is the ESM main-module idiom (registry/src/main.ts).
const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  startParticipant(port)
    .then(({ url }) => {
      console.log(`${IDENTITY} listening on ${url} — card at ${url}${CARD_PATH}`);
    })
    .catch((err: unknown) => {
      console.error('participant failed to start:', err);
      process.exitCode = 1;
    });
}
