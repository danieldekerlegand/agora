/**
 * The MCP client wire — dial a provider's `/mcp` Streamable-HTTP surface.
 *
 * KCB §4 maps the `invoke` verb onto an "MCP tool call" (capability-bus.md §4/§6). The shape
 * below was verified against a real server that serves exactly that at `/mcp` (FastMCP with
 * `stateless_http=True`). This wire speaks the official Model Context Protocol — the same
 * JSON-RPC methods and message shapes the `@modelcontextprotocol/sdk` client uses: it pins its
 * advertised {@link LATEST_PROTOCOL_VERSION} and classifies every answer with the SDK's own
 * {@link isJSONRPCResponse}/{@link isJSONRPCErrorResponse} guards, so the protocol is the SDK's,
 * not a hand-rolled lookalike.
 *
 * It does *not* use the SDK's bundled `StreamableHTTPClientTransport`, on purpose: that opens
 * its own socket, which would put the exchange outside the console's ObservationLog and beyond a
 * delta-N stand-in's reach — the opposite of ADR-0001 decision 7. Instead every leg of the
 * handshake (`initialize` → `tools/list` → `tools/call`) is driven through the injected
 * {@link WireIO} seam, so each request/response is an observed, direct connection.
 */
import type { Json, JsonObject } from '@agora/schemas';
import { isJsonObject } from '@agora/schemas';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResponse,
  LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js';

import { RefusedError } from './link.ts';
import {
  budgetHeaderName,
  type ExchangeDetail,
  type InvocationResult,
  type Wire,
  type WireCall,
  type WireContext,
  type WireIO,
} from './wire.ts';

/** How the console names itself to a peer's `initialize` (MCP `clientInfo`). */
const CLIENT_INFO = { name: 'agora-console', version: '0.0.0' } as const;

/** The Streamable-HTTP client MUST accept both answer content types (MCP transport spec). */
const MCP_ACCEPT = 'application/json, text/event-stream';

export const mcpWire: Wire = {
  name: 'mcp',

  async invoke(context: WireContext, io: WireIO): Promise<InvocationResult> {
    let requestId = 0;
    // Captured from `initialize`'s response header and echoed on every later request. A
    // stateless FastMCP server issues none, and then there is simply nothing to echo.
    let sessionId: string | undefined;

    const call = (method: string, params: JsonObject): WireCall => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: MCP_ACCEPT,
      };
      const budgetHeader = budgetHeaderName(context.manifest);
      if (context.budgetUnits !== undefined && budgetHeader !== undefined) {
        // The KCB §5 spend ceiling rides the transport, as it does on the openai wire — a
        // cost-gated invoke can be refused over MCP too.
        headers[budgetHeader] = String(context.budgetUnits);
      }
      if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
      return {
        url: context.endpoint,
        method: 'POST',
        headers,
        body: { jsonrpc: '2.0', id: (requestId += 1), method, params },
      };
    };

    const captureHeaders: ExchangeDetail['captureHeaders'] = (headers) => {
      const sid = headers.get('mcp-session-id');
      if (sid !== null && sid !== '') sessionId = sid;
    };

    // 1. initialize — negotiate the protocol version and pick up any session id.
    const initEnvelope = await io.exchange(
      call('initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { ...CLIENT_INFO },
      }),
      {
        request: {
          wire: mcpWire.name,
          step: 'initialize',
          capability: context.capability.name,
          endpoint: context.endpoint,
          budget_units: context.budgetUnits ?? null,
        },
        captureHeaders,
        response: (body) => {
          const result = resultOf(body);
          return {
            protocol_version: readString(result.protocolVersion),
            server: readString(isJsonObject(result.serverInfo) ? result.serverInfo.name : undefined),
          };
        },
      },
    );
    resultOrRefuse(initEnvelope, 'initialize');

    // 2. tools/list — the tool a capability names must be one the peer actually serves.
    const listEnvelope = await io.exchange(call('tools/list', {}), {
      request: { wire: mcpWire.name, step: 'tools/list' },
      response: (body) => ({ tools: toolNames(resultOf(body)) }),
    });
    const listResult = resultOrRefuse(listEnvelope, 'tools/list');
    const tool = selectTool(context);
    if (!toolNames(listResult).includes(tool)) {
      throw new RefusedError(404, `${context.manifest.identity} serves no MCP tool \`${tool}\``);
    }

    // 3. tools/call — the invoke itself; its content normalises to one InvocationResult.
    const callEnvelope = await io.exchange(
      call('tools/call', { name: tool, arguments: toolArguments(context) }),
      {
        request: {
          wire: mcpWire.name,
          step: 'tools/call',
          tool,
          capability: context.capability.name,
          budget_units: context.budgetUnits ?? null,
        },
        response: (body) => summariseCall(resultOf(body)),
      },
    );
    const callResult = resultOrRefuse(callEnvelope, 'tools/call');
    return readCallResult(callResult, callEnvelope);
  },
};

/** The `result` object of a JSON-RPC envelope, or `{}` — read for a response-leg summary. */
function resultOf(envelope: JsonObject): JsonObject {
  return isJsonObject(envelope.result) ? envelope.result : {};
}

/**
 * The `result` of a JSON-RPC answer, or a {@link RefusedError} on a JSON-RPC `error`.
 *
 * A protocol error rides HTTP 200 in JSON-RPC, so the seam cannot surface it; the wire must.
 * "Was correctly refused" is an assertable KCS outcome (delta O), so a refusal is a first-class
 * result carrying the provider's own reason — never an unhandled throw.
 */
function resultOrRefuse(envelope: JsonObject, step: string): JsonObject {
  if (isJSONRPCErrorResponse(envelope)) {
    const { code, message } = envelope.error;
    throw new RefusedError(400, `MCP ${step} refused (${code}): ${message}`);
  }
  if (!isJSONRPCResponse(envelope)) {
    throw new RefusedError(502, `MCP ${step} returned neither a result nor an error`);
  }
  return isJsonObject(envelope.result) ? envelope.result : {};
}

/** The tool a capability selects: an explicit `options.tool`, else the capability's own name. */
function selectTool(context: WireContext): string {
  const named = context.options.tool;
  return typeof named === 'string' ? named : context.capability.name;
}

/** The names a `tools/list` result advertised. */
function toolNames(result: JsonObject): string[] {
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return tools
    .map((entry) => (isJsonObject(entry) && typeof entry.name === 'string' ? entry.name : undefined))
    .filter((name): name is string => name !== undefined);
}

/** The plane-typed inputs (and options) as the tool's arguments. */
function toolArguments(context: WireContext): JsonObject {
  const args: JsonObject = {};
  for (const [key, value] of Object.entries(context.options)) {
    if (key === 'tool' || value === undefined) continue;
    args[key] = value;
  }
  for (const input of context.inputs) {
    if (input.value === undefined) continue;
    if (isJsonObject(input.value)) {
      Object.assign(args, input.value);
      continue;
    }
    args[input.shape ?? 'input'] = input.value;
  }
  return args;
}

/** A `tools/call` result → one {@link InvocationResult}; a tool-level failure is a refusal. */
function readCallResult(result: JsonObject, envelope: JsonObject): InvocationResult {
  if (result.isError === true) {
    throw new RefusedError(400, callText(result) ?? 'the MCP tool reported an error');
  }
  const invocation: InvocationResult = { raw: envelope };
  const text = callText(result);
  if (text !== undefined) invocation.text = text;
  const assets = callAssets(result);
  if (assets.length > 0) invocation.assets = assets;
  return invocation;
}

/** The text an MCP tool answered with, joined across its `text` content blocks. */
function callText(result: JsonObject): string | undefined {
  const parts: string[] = [];
  for (const block of contentOf(result)) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * The media-plane outputs an MCP tool answered with, **by reference** — the media type and a
 * digest when the block carries one. Base64 `data`/`blob` bytes are never read into the log
 * (KMI §7): a consumer fetches bytes by id.
 */
function callAssets(result: JsonObject): { media_type: string; digest?: string }[] {
  const assets: { media_type: string; digest?: string }[] = [];
  for (const block of contentOf(result)) {
    const carrier = block.type === 'resource' && isJsonObject(block.resource) ? block.resource : block;
    const mediaType = readString(carrier.mimeType) ?? readString(carrier.media_type);
    if (mediaType === undefined) continue;
    const digest = readString(carrier.digest) ?? digestFromUri(readString(carrier.uri));
    assets.push(digest === undefined ? { media_type: mediaType } : { media_type: mediaType, digest });
  }
  return assets;
}

/** The content blocks of a tool result, each as a readable object. */
function contentOf(result: JsonObject): JsonObject[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.filter(isJsonObject);
}

/** A content-addressed digest embedded in a resource uri (`sha256:…`, `blake3-…`), if any. */
function digestFromUri(uri: string | undefined): string | undefined {
  if (uri === undefined) return undefined;
  const match = /(sha256|sha512|blake3)[-:]([0-9a-fA-F]{8,})/.exec(uri);
  return match === null ? undefined : `${match[1]}:${match[2]}`;
}

/** A response-leg summary for a `tools/call`: what came back, by reference. */
function summariseCall(result: JsonObject): Record<string, Json | undefined> {
  return {
    is_error: result.isError === true ? true : undefined,
    text: callText(result) !== undefined ? true : undefined,
    assets: callAssets(result).map((asset) => asset.media_type),
  };
}

function readString(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
