/**
 * The A2A client wire — dial a provider's Agent Card, then send it a task.
 *
 * KCB §4 maps the `invoke` verb onto an "A2A task" (capability-bus.md §4/§6): the console
 * fetches the peer's Agent Card at `endpoints.a2a` (KCB §2 `/.well-known/agent-card.json`,
 * §6), reads the JSON-RPC endpoint the card advertises, and sends one `message/send` there.
 * It speaks the standard's wire shapes verbatim: camelCase keys, a Message of
 * `kind`-tagged Parts (text/data/file) carrying `messageId`/`contextId`, and a returned Task
 * whose `status.state` is the kebab-case {@link https://google.github.io/A2A/ TaskState}.
 *
 * As with the MCP wire, it does *not* open its own socket — both legs (agent-card GET →
 * `message/send` POST) are driven through the injected {@link WireIO} seam, so each is an
 * observed, direct connection a delta-N stand-in can substitute for (ADR-0001 decision 7).
 */
import type { Json, JsonObject } from '@agora/schemas';
import { isJsonObject } from '@agora/schemas';

import { RefusedError } from './link.ts';
import {
  budgetHeaderName,
  type InvocationResult,
  type Wire,
  type WireCall,
  type WireContext,
  type WireIO,
} from './wire.ts';

/**
 * The A2A wire-protocol versions this build speaks, oldest → newest. The wire advertises the
 * latest it supports; a peer negotiates the highest version they both speak.
 */
export const A2A_PROTOCOL_VERSIONS = ['1.0', '1.1'] as const;

/** The newest version this wire advertises on every message it sends (the list is non-empty). */
const A2A_LATEST_VERSION: string = A2A_PROTOCOL_VERSIONS[A2A_PROTOCOL_VERSIONS.length - 1] as string;

/** How the console names itself when a message carries a sending agent (an A2A extension). */
const CLIENT_AGENT = 'agora-console';

/**
 * An A2A task that paused for more input (`status.state === 'input-required'`).
 *
 * Deliberately *not* a {@link RefusedError}: nobody refused the task, it is waiting on the
 * caller. Reporting it as a completed invoke would be a lie (KCS honest-degrade), so the wire
 * surfaces it as its own outcome — a scenario sees an `input-required` task for what it is.
 */
export class InputRequiredError extends Error {
  constructor(
    readonly taskId: string,
    readonly prompt: string,
  ) {
    super(`A2A task ${taskId} needs more input${prompt === '' ? '' : `: ${prompt}`}`);
    this.name = 'InputRequiredError';
  }
}

export const a2aWire: Wire = {
  name: 'a2a',

  async invoke(context: WireContext, io: WireIO): Promise<InvocationResult> {
    // 1. agent-card — a GET at the published address; its `url` is where a task is sent.
    const card = await io.exchange(
      { url: context.endpoint, method: 'GET', headers: { accept: 'application/json' }, body: {} },
      {
        request: { wire: a2aWire.name, step: 'agent-card', endpoint: context.endpoint },
        response: (body) => ({ agent: readString(body.name), version: readString(body.version) }),
      },
    );
    const target = sendTarget(card, context.endpoint);

    // 2. message/send — the invoke itself; the returned Task normalises to one result.
    const envelope = await io.exchange(sendCall(target, context), {
      request: {
        wire: a2aWire.name,
        step: 'message/send',
        endpoint: target,
        capability: context.capability.name,
        budget_units: context.budgetUnits ?? null,
      },
      response: (body) => summariseSend(taskOf(body)),
    });
    const result = resultOrRefuse(envelope);
    return readTerminal(result, envelope);
  },
};

/** The JSON-RPC `message/send` request, carrying a Message in the standard's exact wire shape. */
function sendCall(target: string, context: WireContext): WireCall {
  const message: JsonObject = {
    role: 'user',
    parts: messageParts(context),
    messageId: newId(),
    protocolVersion: A2A_LATEST_VERSION,
    fromAgent: CLIENT_AGENT,
  };
  const contextId = readString(context.options.contextId);
  if (contextId !== undefined) message.contextId = contextId;
  const toAgent = readString(context.options.toAgent);
  if (toAgent !== undefined) message.toAgent = toAgent;
  const metadata = messageMetadata(context);
  if (metadata !== undefined) message.metadata = metadata;
  return {
    url: target,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message } },
  };
}

/**
 * The plane-typed inputs as `kind`-tagged Parts: a string is a `text` part, an object is a
 * `data` part, anything else is wrapped in one. A message with no inputs still carries an
 * (empty) text part, because A2A requires at least one part.
 */
function messageParts(context: WireContext): JsonObject[] {
  const parts: JsonObject[] = [];
  for (const input of context.inputs) {
    if (input.value === undefined) continue;
    if (typeof input.value === 'string') parts.push({ kind: 'text', text: input.value });
    else if (isJsonObject(input.value)) parts.push({ kind: 'data', data: input.value });
    else parts.push({ kind: 'data', data: { value: input.value } });
  }
  if (parts.length === 0) parts.push({ kind: 'text', text: '' });
  return parts;
}

/**
 * The KCB §5 spend ceiling as A2A message metadata — the transport A2A carries it over, as
 * the openai/MCP wires carry it in a header (KCB §5), so a cost-gated invoke can be refused
 * over A2A too. Keyed by the header name the manifest advertises, so every transport agrees.
 */
function messageMetadata(context: WireContext): JsonObject | undefined {
  const budgetHeader = budgetHeaderName(context.manifest);
  if (context.budgetUnits === undefined || budgetHeader === undefined) return undefined;
  return { [budgetHeader]: context.budgetUnits };
}

/**
 * Where a task is sent: the card's own `url` (A2A's `AgentCard.url`), else a JSON-RPC
 * interface it advertises, else the card address with its well-known suffix stripped. A card
 * that names no address falls back to its own origin — never an invented one.
 */
function sendTarget(card: JsonObject, cardEndpoint: string): string {
  const direct = readString(card.url);
  if (direct !== undefined) return direct;
  for (const key of ['additionalInterfaces', 'supportedInterfaces', 'interfaces']) {
    const list = Array.isArray(card[key]) ? card[key] : [];
    const jsonrpc = list
      .filter(isJsonObject)
      .find((entry) => entry.protocolBinding === 'JSONRPC' || entry.transport === 'JSONRPC');
    const url = readString(jsonrpc?.url);
    if (url !== undefined) return url;
  }
  return cardEndpoint.replace(/\/\.well-known\/agent-card\.json$/, '') || cardEndpoint;
}

/** The `message/send` result — a Task (or a bare Message), or a {@link RefusedError} on error. */
function resultOrRefuse(envelope: JsonObject): JsonObject {
  if (isJsonObject(envelope.error)) {
    const { code, message } = envelope.error;
    const reason = typeof message === 'string' ? message : 'no reason given';
    const shown = typeof code === 'number' ? ` (${code})` : '';
    throw new RefusedError(400, `A2A message/send refused${shown}: ${reason}`);
  }
  const result = envelope.result;
  if (!isJsonObject(result)) throw new RefusedError(502, 'A2A message/send returned no task');
  return result;
}

/**
 * A terminal Task → one {@link InvocationResult}. A `failed`/`rejected`/`canceled` task is a
 * refusal (the work did not succeed); an `input-required` task is surfaced as its own outcome;
 * a Task still `submitted`/`working` never reached a terminal state and is an error, not a
 * silent success. A bare Message reply (no `status`) is read directly as a completed answer.
 */
function readTerminal(result: JsonObject, envelope: JsonObject): InvocationResult {
  if (!isJsonObject(result.status)) return normalise(result, [], envelope);
  const taskId = readString(result.id) ?? 'unknown';
  const state = readString(result.status.state) ?? 'unknown';
  const message = isJsonObject(result.status.message) ? result.status.message : undefined;
  switch (state) {
    case 'completed':
      return normalise(message, artifactsOf(result), envelope);
    case 'failed':
    case 'rejected':
    case 'canceled':
      throw new RefusedError(400, `A2A task ${taskId} ${state}: ${messageText(message) ?? 'no reason given'}`);
    case 'input-required':
      throw new InputRequiredError(taskId, messageText(message) ?? '');
    default:
      throw new RefusedError(502, `A2A task ${taskId} did not reach a terminal state (state: ${state})`);
  }
}

/**
 * The terminal `status.message` + `artifacts`, normalised: text from every text part/artifact,
 * media by reference (media type + a digest when the file names one) — bytes are never read
 * into the log (KMI §7); a consumer fetches them by id.
 */
function normalise(
  message: JsonObject | undefined,
  artifacts: JsonObject[],
  envelope: JsonObject,
): InvocationResult {
  const result: InvocationResult = { raw: envelope };
  const texts: string[] = [];
  const spoken = messageText(message);
  if (spoken !== undefined) texts.push(spoken);
  for (const artifact of artifacts) {
    if (artifact.kind === 'text' && typeof artifact.text === 'string') texts.push(artifact.text);
  }
  if (texts.length > 0) result.text = texts.join('\n');
  const assets = [
    ...(message === undefined ? [] : fileAssets(partsOf(message))),
    ...fileAssets(artifacts),
  ];
  if (assets.length > 0) result.assets = assets;
  return result;
}

/** The parts of a Message, each as a readable object. */
function partsOf(message: JsonObject): JsonObject[] {
  return (Array.isArray(message.parts) ? message.parts : []).filter(isJsonObject);
}

/** The artifacts a Task produced, each as a readable object. */
function artifactsOf(task: JsonObject): JsonObject[] {
  return (Array.isArray(task.artifacts) ? task.artifacts : []).filter(isJsonObject);
}

/** The joined text of every `text` part in a list. */
function partsText(parts: JsonObject[]): string | undefined {
  const texts = parts
    .filter((part) => part.kind === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/** The text of a Message's text parts — a status message's reason or answer. */
function messageText(message: JsonObject | undefined): string | undefined {
  return message === undefined ? undefined : partsText(partsOf(message));
}

/**
 * The media-plane outputs among a list of parts/artifacts, **by reference**: a `file` part's
 * `mimeType` and a digest embedded in its `uri`. Base64 `file.bytes` is never read (KMI §7).
 */
function fileAssets(parts: JsonObject[]): { media_type: string; digest?: string }[] {
  const assets: { media_type: string; digest?: string }[] = [];
  for (const part of parts) {
    if (part.kind !== 'file' || !isJsonObject(part.file)) continue;
    const mediaType = readString(part.file.mimeType) ?? readString(part.file.media_type);
    if (mediaType === undefined) continue;
    const digest = digestFromUri(readString(part.file.uri));
    assets.push(digest === undefined ? { media_type: mediaType } : { media_type: mediaType, digest });
  }
  return assets;
}

/** A content-addressed digest embedded in a file uri (`sha256:…`, `blake3-…`), if any. */
function digestFromUri(uri: string | undefined): string | undefined {
  if (uri === undefined) return undefined;
  const match = /(sha256|sha512|blake3)[-:]([0-9a-fA-F]{8,})/.exec(uri);
  return match === null ? undefined : `${match[1]}:${match[2]}`;
}

/** The `result` Task of a JSON-RPC envelope, or `{}` — read for a response-leg summary. */
function taskOf(envelope: JsonObject): JsonObject {
  return isJsonObject(envelope.result) ? envelope.result : {};
}

/** A response-leg summary for a `message/send`: the task's id, state, and what came back. */
function summariseSend(task: JsonObject): Record<string, Json | undefined> {
  const status = isJsonObject(task.status) ? task.status : {};
  const message = isJsonObject(status.message) ? status.message : undefined;
  return {
    task: readString(task.id),
    state: readString(status.state),
    text: messageText(message) !== undefined ? true : undefined,
    artifacts: artifactsOf(task).length > 0 ? artifactsOf(task).length : undefined,
  };
}

/** A fresh message id — A2A requires each Message to carry one. */
function newId(): string {
  return `agora-${crypto.randomUUID()}`;
}

function readString(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
