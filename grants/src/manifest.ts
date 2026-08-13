/**
 * The issuer's own KCB manifest — how a host finds the thing that mints its credentials.
 *
 * A capability provider is itself a fabric entity (KCB §2), and issuance is a capability like
 * any other: it has a name, an address, ports and a cost. So the issuer publishes the same two
 * documents every other participant publishes — an A2A AgentCard with the manifest riding as its
 * one extension, and the bare manifest body a registry crawl pulls (§3) — and is then
 * discoverable by `find({capability: 'grant.issue'})` exactly as a text generator is.
 *
 * What discovery hands back is an **address** (ADR-0001 decision 3): the registry indexes this
 * manifest and answers with where to dial, and the caller mints *directly* against the issuer.
 * Nothing about a grant travels through the registry, and nothing about it travels through the
 * issuer afterwards either — the credential goes back to the caller, who presents it to whatever
 * relying party it wants to spend it at.
 *
 * **No `grants_required`**, which is a deliberate absence rather than an oversight. KCB §5 leaves
 * identity providers to the control-plane host's infra, so what authorizes a *mint* is whatever
 * the host fronts this surface with, not a capability grant; and what authorizes a *derivation*
 * is the presented parent grant itself. Advertising `invoke:grant.issue` as required would claim
 * a grant you would need this very service to obtain.
 */
import {
  embedManifest,
  SPEC_VERSIONS,
  type AgentCard,
  type CapabilityManifest,
  type EntityPort,
} from '@agora/schemas';

import { GRANT_ISSUER_IDENTITY } from './issuer.ts';

/** Where an A2A peer publishes its card — the address a host discovers this issuer at. */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

/** Where the bare manifest body is published, for the registry crawl that pulls it in (§3). */
export const KCB_MANIFEST_PATH = '/.well-known/kcb-manifest.json';

/** Minting a grant for a principal the host names. */
export const ISSUE_CAPABILITY = 'grant.issue';

/** Narrowing a grant the caller already holds, for the next hop of a chain. */
export const DERIVE_CAPABILITY = 'grant.derive';

/** The principal a grant is minted for, in KCB port terms — an entity, named by the host. */
const PRINCIPAL: EntityPort = { plane: 'entity', types: ['agent'] };

/** What comes back: the §5 capability grant itself. */
const GRANT: EntityPort = { plane: 'entity', types: ['capability-grant'] };

/**
 * The issuer's manifest, addressed at `baseUrl`.
 *
 * Both capabilities are `est_units: 0` and mean it — issuing a credential is not itself a
 * metered act, and path search (§3) prefers zero-cost routes, which is the right preference for
 * the step that tells you what the *rest* of the chain may spend.
 */
export function grantIssuerManifest(baseUrl: string): CapabilityManifest {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    kcb_version: SPEC_VERSIONS.kcb,
    identity: GRANT_ISSUER_IDENTITY,
    endpoints: {
      grants: `${base}/grants`,
      keys: `${base}/keys`,
      a2a: `${base}${AGENT_CARD_PATH}`,
      manifest: `${base}${KCB_MANIFEST_PATH}`,
    },
    produces: [GRANT],
    consumes: [PRINCIPAL],
    capabilities: [
      {
        name: ISSUE_CAPABILITY,
        inputs: [PRINCIPAL],
        outputs: [GRANT],
        cost: { est_units: 0, basis: 'one signed capability grant' },
        endpoint: `${base}/grants`,
      },
      {
        name: DERIVE_CAPABILITY,
        inputs: [GRANT],
        outputs: [GRANT],
        cost: { est_units: 0, basis: 'one grant narrowed from a presented parent' },
        endpoint: `${base}/grants/derive`,
      },
    ],
    // The scheme names what a relying party will be handed, not what this surface demands: see
    // the file header on why there is no `grants_required` here.
    auth: { scheme: 'capability-grant' },
  };
}

/** The manifest riding as the single KCB extension on an A2A AgentCard (§2/§6). */
export function grantIssuerCard(baseUrl: string): AgentCard {
  const base = baseUrl.replace(/\/+$/, '');
  return embedManifest(
    { name: GRANT_ISSUER_IDENTITY, url: base },
    grantIssuerManifest(base),
  );
}
