/**
 * A captured session with the provider-router, replayed as a `fetch`.
 *
 * The console's gate must not open a socket, and a hand-written stub would only prove the
 * console agrees with itself. So `provider-router.session.json` is a *capture* of the real
 * zero-spend router — the manifest it publishes and the exact exchange this scenario
 * makes — and `provider-router/tests/test_conformance_fixture.py` asserts the capture is
 * still current. Same cross-language pin the registry's manifest fixture uses (US-AG4).
 *
 * {@link replaySession} is deliberately strict: a POST whose body differs from the
 * captured request by one field is refused with a 409, not answered. That is what makes
 * this a round-trip proof rather than a canned response — the console has to build the
 * request the router was actually asked, or the scenario goes red.
 */
import type { HttpFetch, HttpRequestInit, HttpResponse } from '../kcs/http.ts';

import session from './provider-router.session.json';

/** Where the capture was taken from — the router's own default bind address. */
export const CAPTURED_FROM: string = session.captured_from;

/** The manifest the registry crawls in the replay. */
export const CAPTURED_MANIFEST: unknown = session.manifest;

/** The one exchange the scenario makes. */
export const CAPTURED_EXCHANGE = session.exchange;

const MANIFEST_URL = `${CAPTURED_FROM}/.well-known/kcb-manifest.json`;
const EXCHANGE_URL = `${CAPTURED_FROM}${CAPTURED_EXCHANGE.path}`;

function respond(status: number, body: unknown): HttpResponse {
  return {
    ok: status < 400,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

/** Key-order-independent comparison — the router hashes a canonicalised body, so do we. */
function sameRequest(body: string | undefined): boolean {
  if (body === undefined) return false;
  try {
    return canonical(JSON.parse(body)) === canonical(CAPTURED_EXCHANGE.request);
  } catch {
    return false;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A `fetch` that answers exactly what the captured router answered, and nothing else.
 *
 * `dialed` records every URL it was handed — the same discipline as the router's
 * `recording_transport`: a zero-spend claim is about what was *contacted*, so a test
 * asserts the list, not just the winner.
 */
export function replaySession(dialed: string[] = []): HttpFetch {
  return (url: string, init?: HttpRequestInit): Promise<HttpResponse> => {
    dialed.push(url);
    if (url === MANIFEST_URL) return Promise.resolve(respond(200, CAPTURED_MANIFEST));
    if (url === EXCHANGE_URL) {
      if (!sameRequest(init?.body)) {
        return Promise.resolve(
          respond(409, { detail: `console sent a request the capture does not cover: ${init?.body ?? ''}` }),
        );
      }
      return Promise.resolve(respond(CAPTURED_EXCHANGE.status, CAPTURED_EXCHANGE.response));
    }
    return Promise.resolve(respond(404, { detail: `nothing captured at ${url}` }));
  };
}
