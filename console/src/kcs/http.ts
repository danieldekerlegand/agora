/**
 * The slice of `fetch` the console uses, stated structurally.
 *
 * Structural rather than `typeof fetch` for two reasons: the platform `fetch` satisfies it
 * (so the live console passes nothing), and a test can satisfy it in a dozen lines without
 * a mock library — which is what lets the gate exercise the whole discovery → dial → read
 * path with only the socket replaced.
 */
export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  /**
   * Optional because only one caller needs it: a `subscribe` stream arrives as NDJSON or
   * SSE, which is a sequence of JSON documents rather than one, so `json()` cannot read
   * it. The platform `Response` has it; a test double supplies it only when it is
   * standing in for a stream.
   */
  text?(): Promise<string>;
}

export interface HttpRequestInit {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
}

export type HttpFetch = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/** The platform fetch, or a clear failure — never a silent no-op. */
export function platformFetch(): HttpFetch {
  const global = globalThis as { fetch?: HttpFetch };
  if (global.fetch === undefined) throw new Error('console: no fetch implementation available');
  return global.fetch.bind(globalThis) as HttpFetch;
}
