/**
 * The OpenAI-compatible gateway projection — how a producer points *its own* client at a
 * model backend it discovered.
 *
 * agora's provider-router is an OpenAI-compatible gateway: any tool that speaks the OpenAI API
 * reaches it with no change beyond a base URL. So the client surface a producer needs is not a
 * wrapper around that API — it is the two or three values an OpenAI client is *constructed*
 * with, read off the manifest the provider published. {@link openAiConfigFor} is exactly that
 * projection, and it is the same shape as everything else here: it hands back configuration and
 * gets out of the way. It opens no connection, carries no prompt, and returns no completion
 * (ADR-0001 decisions 2–4) — you construct `new OpenAI(config)` and call the vendor SDK you
 * already have.
 *
 * Two things are read from the manifest rather than assumed, because a gateway is entitled to
 * publish its own answer to both (KCB §2, §5):
 *
 * - the **base URL** is `endpoints.openai`, and there is no fallback: a provider that publishes
 *   no OpenAI endpoint is not an OpenAI-compatible gateway, and this returns `undefined` rather
 *   than inventing a URL to dial;
 * - the **spend ceiling** is carried however the provider's `auth.budget_units` says to carry it
 *   (KCB §5: a grant carries a `budget_units` ceiling). A ceiling asked for of a provider that
 *   declares no support for one is *not* silently sent under a guessed header —
 *   {@link OpenAiClientConfig.honorsBudgetUnits} reports that, so a caller learns the ceiling
 *   will not be honored before it spends rather than after.
 */
import type { Capability, CapabilityManifest } from '@agora/schemas';

import { addressOf, transportOf } from './kcb.ts';

/**
 * The header agora's routers take a spend ceiling in. It is the default only — a provider that
 * publishes an `auth.budget_units.header` names its own, and that one wins.
 */
export const BUDGET_UNITS_HEADER = 'X-Agora-Budget-Units';

/** What an OpenAI-compatible client is constructed with, projected from a published manifest. */
export interface OpenAiClientConfig {
  /** The `baseURL` an OpenAI client takes — no trailing slash, paths append to it. */
  baseUrl: string;
  /** Headers to send with each request. Only what the provider asked for; usually the ceiling. */
  headers: Readonly<Record<string, string>>;
  /** The model the matched capability advertises, when it named one — pass it as `model`. */
  model?: string;
  /** Whether the provider declared it honors a KCB §5 spend ceiling (`auth.budget_units`). */
  honorsBudgetUnits: boolean;
  /** The request-body field the provider also takes a ceiling in, for a client that cannot set
   * headers. Present only when the provider named one. */
  budgetUnitsKey?: string;
}

export interface OpenAiConfigOptions {
  /** The capability being called (e.g. `generate.text`); its model and endpoint are read. */
  capability?: string;
  /** A spend ceiling in KCB budget units. Sent only if the provider declared it honors one. */
  budgetUnits?: number;
}

/**
 * Project a manifest onto the configuration for your OpenAI client, or `undefined` when this
 * provider is not an OpenAI-compatible gateway for what you asked.
 *
 * `undefined` means one of three things, and each of them is a refusal to guess: the provider
 * publishes no `openai` endpoint; the named capability is not one it publishes; or that
 * capability is served on an endpoint its OpenAI base URL does not host — a capability reachable
 * over A2A is not reachable by pointing an OpenAI client at it.
 */
export function openAiConfigFor(
  manifest: CapabilityManifest,
  options: OpenAiConfigOptions = {},
): OpenAiClientConfig | undefined {
  const baseUrl = manifest.endpoints.openai?.replace(/\/+$/, '');
  if (baseUrl === undefined || baseUrl === '') return undefined;

  let capability: Capability | undefined;
  if (options.capability !== undefined) {
    capability = manifest.capabilities?.find((entry) => entry.name === options.capability);
    if (capability === undefined) return undefined;
    // A capability that names its own endpoint must actually be hosted on the OpenAI base;
    // `transportOf` owns that precedence, so there is one implementation of it.
    if (
      capability.endpoint !== undefined &&
      transportOf(addressOf(manifest), capability) !== 'openai'
    ) {
      return undefined;
    }
  }

  const ceiling = budgetUnitsBlock(manifest);
  const headers: Record<string, string> = {};
  if (options.budgetUnits !== undefined && ceiling.honored) {
    headers[ceiling.header] = String(options.budgetUnits);
  }

  return {
    baseUrl,
    headers,
    ...(capability?.model === undefined ? {} : { model: capability.model }),
    honorsBudgetUnits: ceiling.honored,
    ...(ceiling.requestKey === undefined ? {} : { budgetUnitsKey: ceiling.requestKey }),
  };
}

/** What the manifest says about spend ceilings: whether it takes one, and where to put it. */
function budgetUnitsBlock(manifest: CapabilityManifest): {
  honored: boolean;
  header: string;
  requestKey?: string;
} {
  const declared = manifest.auth?.budget_units;
  if (typeof declared !== 'object' || declared === null) {
    return { honored: false, header: BUDGET_UNITS_HEADER };
  }
  const block = declared as { supported?: unknown; header?: unknown; request_key?: unknown };
  return {
    honored: block.supported === true,
    header: typeof block.header === 'string' ? block.header : BUDGET_UNITS_HEADER,
    ...(typeof block.request_key === 'string' ? { requestKey: block.request_key } : {}),
  };
}
