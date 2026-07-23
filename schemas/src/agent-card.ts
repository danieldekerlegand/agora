/**
 * The A2A AgentCard and the KCB manifest extension it carries — `koine/specs/capability-bus.md`
 * §2/§6 (post-0.3.0).
 *
 * A capability provider already publishes an **A2A AgentCard** at the standard
 * `/.well-known/agent-card.json`; it carries the provider's identity (`name`, a KINP agent id)
 * and its A2A service endpoint (`url`). Rather than publish a second, standalone
 * `/.well-known/kcb-manifest.json`, KCB rides as one **named extension** of that card: a single
 * entry under `capabilities.extensions[]` whose `uri` is {@link KCB_MANIFEST_EXTENSION_URI} and
 * whose `params` object is the KCB payload (§2, §2.2).
 *
 * These types model the *card*, not the KCB payload — `manifest.ts` narrows the payload out of
 * `params`. The index signatures are load-bearing: the provider's card is authoritative (§3), so
 * fields this build does not model — on the card, on `capabilities`, or on an extension — must
 * survive being read (narrow-in-place, §2.2 preserves `signing` and anything future).
 */

/**
 * One `AgentExtension` on an AgentCard — A2A's standard, in-band way to attach
 * protocol-specific metadata without forking the card schema (§2). The KCB manifest is one such
 * extension, identified by {@link KCB_MANIFEST_EXTENSION_URI}.
 */
export interface AgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

/** An AgentCard's `capabilities` block; `extensions` is where KCB (and any peer) attaches. */
export interface AgentCapabilities {
  extensions?: AgentExtension[];
  [key: string]: unknown;
}

/**
 * The A2A AgentCard served at `/.well-known/agent-card.json`. `name` is the provider's KINP
 * agent id, `url` its A2A service endpoint; the KCB manifest is an entry in
 * `capabilities.extensions[]` (§2).
 */
export interface AgentCard {
  name?: string;
  url?: string;
  capabilities?: AgentCapabilities;
  [key: string]: unknown;
}

/**
 * The stable URI identifying the KCB capability-manifest extension on an AgentCard, ratified in
 * `capability-bus.md` §2 (0.3.0). This is the single source of the literal — no other file
 * hardcodes it; parsing and emitting both key off this constant.
 */
export const KCB_MANIFEST_EXTENSION_URI = 'https://koine.dev/kcb/manifest/0.3';
