/**
 * Pull population (KCB §3): "projects register their manifest (push) or the registry
 * **crawls** known A2A agent-cards / MCP servers".
 *
 * The crawl is one HTTP GET of a provider's well-known manifest, handed straight to
 * `register`. This is the only place the registry makes an outbound call, and it fetches a
 * *manifest* — never a payload on someone's behalf (ADR-0001 decision 3).
 *
 * `fetch` is a parameter with a global default so the gate never touches the network and
 * the console can supply its own instrumented fetch.
 */
import type { CapabilityRegistry, Registration } from './registry.ts';

/** Where a KCB provider publishes its manifest. The provider-router serves this path. */
export const KCB_MANIFEST_PATH = '/.well-known/kcb-manifest.json';

/** KINP identity of the provider-router (`agora_provider_router.ROUTER_IDENTITY`). */
export const PROVIDER_ROUTER_IDENTITY = 'agora:agent:provider-router';

/** The router's own default bind address (`manifest.DEFAULT_BASE_URL` on the Python side). */
export const PROVIDER_ROUTER_BASE_URL = 'http://127.0.0.1:8000';

/** KINP identity of the general finetune trainer (`agora_trainer.TRAINER_IDENTITY`). */
export const TRAINER_IDENTITY = 'agora:agent:trainer';

/** The trainer's own default bind address (`config.DEFAULT_BASE_URL` on the Python side) —
 * one port above the router's, because it is a distinct service (ADR-0001 decision 1). */
export const TRAINER_BASE_URL = 'http://127.0.0.1:8001';

/** The slice of `fetch` a crawl needs — structural, so a test can pass three lines. */
export type ManifestFetch = (
  url: string,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface CrawlOptions {
  fetch?: ManifestFetch;
}

export class CrawlError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'CrawlError';
  }
}

export function manifestUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${KCB_MANIFEST_PATH}`;
}

/**
 * Crawl one provider's well-known manifest and index it.
 *
 * The manifest is registered verbatim — the provider is authoritative about itself (§3),
 * so a crawl that "fixed up" what it fetched would be inventing a second source of truth.
 */
export async function registerFromWellKnown(
  registry: CapabilityRegistry,
  baseUrl: string,
  options: CrawlOptions = {},
): Promise<Registration> {
  const url = manifestUrl(baseUrl);
  const get = options.fetch ?? (globalThis as { fetch?: ManifestFetch }).fetch;
  if (get === undefined) throw new CrawlError('no fetch implementation available', url);
  const response = await get(url);
  if (!response.ok) throw new CrawlError(`manifest fetch failed with ${response.status}`, url);
  return registry.register(await response.json(), { source: 'pull' });
}

/**
 * Index the provider-router — the commons' first capability, and so the registry's first
 * entry (US-AG3 publishes the manifest this reads).
 *
 * The identity check is deliberate: a manifest fetched from the router's address that
 * claims to be someone else is a misconfiguration, and indexing it would publish a wrong
 * address to every peer that later dials it.
 */
export async function registerProviderRouter(
  registry: CapabilityRegistry,
  baseUrl: string = PROVIDER_ROUTER_BASE_URL,
  options: CrawlOptions = {},
): Promise<Registration> {
  const registration = await registerFromWellKnown(registry, baseUrl, options);
  if (registration.identity !== PROVIDER_ROUTER_IDENTITY) {
    registry.remove(registration.identity);
    throw new CrawlError(
      `expected ${PROVIDER_ROUTER_IDENTITY} at this address, got ${registration.identity}`,
      manifestUrl(baseUrl),
    );
  }
  return registration;
}

/**
 * Index the general finetune trainer — agora's KFT `finetune` provider (US-1 publishes the
 * manifest this reads), a **distinct** leaf capability from the provider-router (ADR-0001
 * decision 1). The same crawl, the same authoritative-manifest rule, and the same
 * identity check: a manifest fetched from the trainer's address that claims to be someone
 * else is a misconfiguration, and indexing it would publish a wrong address to every peer.
 */
export async function registerTrainer(
  registry: CapabilityRegistry,
  baseUrl: string = TRAINER_BASE_URL,
  options: CrawlOptions = {},
): Promise<Registration> {
  const registration = await registerFromWellKnown(registry, baseUrl, options);
  if (registration.identity !== TRAINER_IDENTITY) {
    registry.remove(registration.identity);
    throw new CrawlError(
      `expected ${TRAINER_IDENTITY} at this address, got ${registration.identity}`,
      manifestUrl(baseUrl),
    );
  }
  return registration;
}
