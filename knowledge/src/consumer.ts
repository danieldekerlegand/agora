/**
 * The KGP consumer a pack is delivered to, and how the bridge finds it.
 *
 * A consumer is **discovered, not configured by name**: it publishes a KCB capability manifest
 * declaring a knowledge-plane input port (capability-bus.md §2.1), the registry hands back its
 * ADDRESS, and the bridge dials that address directly (ADR-0001 decisions 2–4 — the control
 * plane never carries the payload). {@link consumerFromManifest} is that projection: manifest →
 * address → the one endpoint a pack is POSTed to. Nothing here knows the name of any particular
 * knowledge authority; a deployment with two of them has two manifests.
 *
 * The interface is deliberately one method wide. A consumer that also wanted to be asked
 * questions would be a *port*, not a delivery target, and belongs behind its own capability.
 */
import { addressOf, endpointFor, isDialable, type Capability, type CapabilityManifest } from '@agora/sdk';

import type { GroundingPack } from './pack.ts';

/** Thrown when a manifest names no consumer this bridge can deliver to. */
export class ConsumerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumerError';
  }
}

/** What a consumer said about a delivery. A refusal is reported, never swallowed. */
export interface DeliveryReceipt {
  readonly accepted: boolean;
  /** The consumer's own words — a §7.2 rejection report, a validation error, an HTTP status. */
  readonly detail?: string;
  readonly status?: number;
}

/** Somewhere a pack can be delivered. Implemented over HTTP here; a test implements it inline. */
export interface KgpConsumer {
  /** KINP identity of the consuming participant. */
  readonly identity: string;
  /** Where it is dialed. Reported on the receipt so a delivery is always attributable. */
  readonly endpoint: string;
  deliver(pack: GroundingPack): Promise<DeliveryReceipt>;
}

/** The slice of `fetch` a delivery needs — structural, so a test can pass three lines. */
export type DeliverFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface HttpConsumerOptions {
  readonly identity: string;
  readonly endpoint: string;
  readonly fetch?: DeliverFetch;
  /** Auth or trace headers the deployment's consumer requires. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A consumer reached over HTTP: one POST of the JSON serialization of the pack (§4). */
export function httpConsumer(options: HttpConsumerOptions): KgpConsumer {
  const send = options.fetch ?? (globalThis as { fetch?: DeliverFetch }).fetch;
  if (send === undefined) {
    throw new ConsumerError(`no fetch implementation available to dial ${options.endpoint}`);
  }
  return {
    identity: options.identity,
    endpoint: options.endpoint,
    async deliver(pack: GroundingPack): Promise<DeliveryReceipt> {
      const response = await send(options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(pack),
      });
      const detail = (await response.text()).slice(0, 2000);
      return {
        accepted: response.ok,
        status: response.status,
        ...(detail === '' ? {} : { detail }),
      };
    },
  };
}

/**
 * The capability a manifest publishes for *consuming* knowledge: one whose `inputs` carry a
 * knowledge-plane port. `dialect` narrows it to a consumer that can evaluate what is being sent
 * (KGP §5), and `world` to one that serves the world the claims are asserted in (KINP §5).
 */
export function knowledgeSink(
  manifest: CapabilityManifest,
  query: { readonly dialect?: string; readonly world?: string } = {},
): Capability | undefined {
  return (manifest.capabilities ?? []).find((capability) =>
    (capability.inputs ?? []).some((port) => {
      if (port.plane !== 'knowledge') return false;
      if (query.dialect !== undefined && port.dialect !== undefined && port.dialect !== query.dialect) {
        return false;
      }
      if (query.world !== undefined && port.worlds !== undefined && !port.worlds.includes(query.world)) {
        return false;
      }
      return true;
    }),
  );
}

export interface ManifestConsumerOptions {
  readonly fetch?: DeliverFetch;
  readonly headers?: Readonly<Record<string, string>>;
  /** Narrow which knowledge sink is chosen when the peer publishes more than one. */
  readonly dialect?: string;
  readonly world?: string;
}

/**
 * Project a peer's KCB manifest into the consumer this bridge delivers to.
 *
 * Address-only, like every projection in the commons: the manifest says where, and the bridge
 * dials it. A manifest with no knowledge sink, or one whose address is not dialable, is an
 * error rather than a guessed URL — inventing an endpoint is how knowledge ends up somewhere
 * nobody declared.
 */
export function consumerFromManifest(
  manifest: CapabilityManifest,
  options: ManifestConsumerOptions = {},
): KgpConsumer {
  const capability = knowledgeSink(manifest, {
    ...(options.dialect === undefined ? {} : { dialect: options.dialect }),
    ...(options.world === undefined ? {} : { world: options.world }),
  });
  if (capability === undefined) {
    throw new ConsumerError(
      `${manifest.identity} publishes no capability consuming a knowledge-plane port ` +
        `(KCB §2.1), so it is not a KGP consumer`,
    );
  }
  const address = addressOf(manifest);
  if (!isDialable(address)) {
    throw new ConsumerError(`${manifest.identity} published no dialable endpoint`);
  }
  const endpoint = endpointFor(address, capability);
  if (endpoint === undefined) {
    throw new ConsumerError(
      `${manifest.identity}'s ${capability.name} resolves to no endpoint — a caller must not ` +
        `invent an address (ADR-0001 decisions 2-4)`,
    );
  }
  return httpConsumer({
    identity: manifest.identity,
    endpoint,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
}
