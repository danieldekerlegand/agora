/**
 * The wire the thin example participants are served over — the part a real deployment would
 * take from an A2A/MCP server library, written once here so each example beside it stays what
 * it claims to be: **a local inference call and the four lines that publish it**.
 *
 * Every app in this directory is the same shape. It has a KINP identity, one capability, and a
 * function that answers text with text *on this machine* — no model download, no vendor key, no
 * network call — standing in for the local model (llama.cpp, MLX, Ollama, a small transformer)
 * you would actually wrap. Publishing it is what makes it a participant (KCB §2/§6): an A2A
 * AgentCard carrying its manifest, that manifest as a bare body for the registry crawl (§3), and
 * an answer at the address the manifest advertises. Nothing registers with a bus and nothing
 * routes through a hub — a peer reads the card, learns where to dial, and dials directly
 * (ADR-0001 decisions 2-4).
 *
 * Two transports, because a fabric has both: {@link A2A_PATH} answers one `message/send`, and
 * {@link MCP_PATH} answers the `initialize` → `tools/list` → `tools/call` handshake, with the
 * capability's own name as the tool name — which is what the conformance console's `mcp` wire
 * dials by default. An app declares the transports it serves and only those endpoints are
 * published: a manifest advertises what the process actually answers.
 *
 * Everything here — identities, capabilities, the inference itself — is **sample data**: a
 * made-up cast, so a newcomer has something running to look at. Describe what *you* do.
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

/** Where an A2A `message/send` is answered — the `url` the agent card names. */
export const A2A_PATH = '/a2a';

/** Where the MCP Streamable-HTTP surface answers, as KCB §4 maps `invoke` onto a tool call. */
export const MCP_PATH = '/mcp';

/**
 * The MCP revision these examples answer with when the client names none. A client that does
 * name one gets it echoed back: this server is a handful of JSON-RPC methods and every revision
 * that has them is one it speaks, so there is nothing to negotiate down to.
 */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

/** The transports an example serves. The spec's two peer-to-peer names (KCB §4). */
export type ExampleTransport = 'a2a' | 'mcp';

/**
 * One thin participant: who it is, what it offers, and the local call that answers.
 *
 * This is the whole authoring surface. An example file below declares one of these and hands it
 * to {@link startApp}; there is no framework underneath, only the request handling in this file.
 */
export interface LocalInferenceApp {
  /** KINP identity — sample data, `example:` scoped, never a real project's name. */
  identity: string;
  /** What to show a human. */
  label: string;
  /** The one capability it advertises (KCB §2.1), and the MCP tool name it serves. */
  capability: string;
  /** One line about what the capability does — rides the card and the MCP tool listing. */
  description: string;
  /** The transports it actually answers on. Only these endpoints are published. */
  transports: readonly ExampleTransport[];
  /** The port it binds when run directly, so the whole example cast can run side by side. */
  port: number;
  /** The KGP payload shape it answers with, when it is not plain `text` (KCB §2.1). */
  shape?: string;
  /**
   * The local model call. Replace this body with your own — everything else about being a
   * participant is already done.
   */
  infer(input: string): string;
}

/** A port typed by the KCB knowledge plane — plain text in (KCB §2.1). */
const TEXT: KnowledgePort = { plane: 'knowledge', shape: 'text' };

/** What an app can do and where to dial it for it — its KCB capability manifest (KCB §2). */
export function appManifest(app: LocalInferenceApp, baseUrl: string): CapabilityManifest {
  const endpoints: Record<string, string> = { manifest: `${baseUrl}${MANIFEST_PATH}` };
  if (app.transports.includes('a2a')) endpoints.a2a = `${baseUrl}${CARD_PATH}`;
  if (app.transports.includes('mcp')) endpoints.mcp = `${baseUrl}${MCP_PATH}`;

  return {
    kcb_version: SPEC_VERSIONS.kcb,
    identity: app.identity,
    endpoints,
    capabilities: [
      {
        name: app.capability,
        inputs: [TEXT],
        outputs: [{ plane: 'knowledge', shape: app.shape ?? 'text' }],
        // Local inference on hardware you already own: nothing is spent per call, and the
        // registry's zero-cost preference (KCB §3) should hear that from the manifest.
        cost: { est_units: 0 },
      },
    ],
  };
}

/** The app's AgentCard — its manifest riding as the card's single extension (KCB §2/§6). */
export function appCard(app: LocalInferenceApp, baseUrl: string): AgentCard {
  return embedManifest(
    { name: app.identity, description: app.description, url: `${baseUrl}${A2A_PATH}` },
    appManifest(app, baseUrl),
  );
}

/** A bound, running example participant — what {@link startApp} resolves to. */
export interface StartedApp {
  /** The base URL a peer dials; the card is at `${url}${CARD_PATH}` when it serves A2A. */
  url: string;
  app: LocalInferenceApp;
  server: Server;
  close(): Promise<void>;
}

/**
 * Start one example participant listening.
 *
 * Port `0` binds an ephemeral port, which is how the tests drive it; the default is the app's
 * own {@link LocalInferenceApp.port}, so the whole cast can be run at once without collisions.
 */
export function startApp(
  app: LocalInferenceApp,
  port: number = app.port,
  host = '127.0.0.1',
): Promise<StartedApp> {
  const server = createServer((req, res) => {
    void handle(app, req, res).catch((err: unknown) => send(res, 400, { error: String(err) }));
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const bound = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${bound.port}`,
        app,
        server,
        close: () =>
          new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

/** Serve it: the card and the manifest at their well-known paths, the answers at the rest. */
async function handle(
  app: LocalInferenceApp,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
  const path = (req.url ?? '/').split('?')[0];
  const serves = (transport: ExampleTransport): boolean => app.transports.includes(transport);

  if (path === MANIFEST_PATH) return send(res, 200, appManifest(app, baseUrl));
  if (path === CARD_PATH && serves('a2a')) return send(res, 200, appCard(app, baseUrl));
  if (req.method === 'POST' && path === A2A_PATH && serves('a2a')) {
    return send(res, 200, a2aAnswer(app, await readJson(req)));
  }
  if (req.method === 'POST' && path === MCP_PATH && serves('mcp')) {
    const answered = mcpAnswer(app, await readJson(req));
    // A JSON-RPC notification has no id and takes no answer — MCP's `notifications/initialized`
    // is the one every SDK client sends. HTTP 202 with an empty body is what it expects back.
    return answered === undefined ? accept(res) : send(res, 200, answered);
  }
  send(res, 404, { error: `no route for ${req.method ?? 'GET'} ${path ?? '/'}` });
}

// ──────────────────────── A2A: one message/send, one completed Task ───────────────────────

/**
 * One A2A `message/send` → one completed Task carrying the answer.
 *
 * The shapes are A2A's own (camelCase keys, `kind`-tagged parts, a kebab-case task state), so
 * any A2A client — the conformance console's `a2a` wire included — reads the reply unchanged.
 */
export function a2aAnswer(app: LocalInferenceApp, request: unknown): unknown {
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
          parts: [{ kind: 'text', text: app.infer(promptOf(call)) }],
          messageId: crypto.randomUUID(),
        },
      },
    },
  };
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

// ─────────────── MCP: initialize → tools/list → tools/call, the capability as the tool ──────────────

/** The one tool an app serves: its capability, by name, taking the text to run inference on. */
export function toolDescriptor(app: LocalInferenceApp): Record<string, unknown> {
  return {
    name: app.capability,
    description: app.description,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to run inference on.' } },
      required: ['text'],
    },
  };
}

/**
 * Answer one MCP JSON-RPC request, or `undefined` for a notification (which takes no answer).
 *
 * Three methods is the whole of it, because a stateless tool server needs no more: the peer
 * negotiates a protocol version, reads the one tool this app serves, and calls it. A tool that
 * failed comes back as `isError` content rather than a JSON-RPC error — MCP's own distinction
 * between "the call went wrong" and "the protocol did".
 */
export function mcpAnswer(app: LocalInferenceApp, request: unknown): unknown {
  const call = asObject(request);
  const id = call.id;
  const method = typeof call.method === 'string' ? call.method : '';
  const params = asObject(call.params);
  if (id === undefined || id === null) return undefined;

  if (method === 'initialize') {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    return ok(id, {
      protocolVersion: asked ?? MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: app.identity, version: '0.0.0' },
    });
  }
  if (method === 'tools/list') return ok(id, { tools: [toolDescriptor(app)] });
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    if (name !== app.capability) {
      return ok(id, {
        content: [{ type: 'text', text: `${app.identity} serves no tool \`${name}\`` }],
        isError: true,
      });
    }
    const args = asObject(params.arguments);
    const text = typeof args.text === 'string' ? args.text : '';
    return ok(id, { content: [{ type: 'text', text: app.infer(text) }], isError: false });
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `${app.identity} does not serve \`${method}\`` },
  };
}

/** A JSON-RPC success envelope. */
function ok(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

// ──────────────────────────────── HTTP/JSON handling ───────────────────────────────

/** A JSON object, or an empty one — an example never guesses at a shape it was not sent. */
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

function accept(res: ServerResponse): void {
  res.writeHead(202);
  res.end();
}

/**
 * Run this app when its file was executed directly (`node src/notes.ts`), and do nothing when it
 * was imported. Comparing `import.meta.url` to `argv[1]` is the ESM main-module idiom the rest
 * of the tree uses (`registry/src/main.ts`); it has to be evaluated in the app's own module, so
 * each example passes its own `import.meta.url` in.
 */
export function runIfMain(moduleUrl: string, app: LocalInferenceApp): void {
  const argv1 = process.argv[1];
  if (argv1 === undefined || moduleUrl !== pathToFileURL(argv1).href) return;

  const port = Number(process.env.PORT ?? app.port);
  startApp(app, port)
    .then(({ url }) => {
      console.log(`${app.identity} listening on ${url} — manifest at ${url}${MANIFEST_PATH}`);
    })
    .catch((err: unknown) => {
      console.error(`${app.identity} failed to start:`, err);
      process.exitCode = 1;
    });
}
