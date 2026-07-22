/**
 * `kcs:provider-router-roundtrip` — the commons' first executable conformance scenario.
 *
 * It proves the one property the whole ladder exists for (US-AG2's always-completes
 * invariant, US-AG3's ceiling) over a **real connection**: discover the provider-router
 * through the registry, dial its own address directly, ask for a completion with a spend
 * ceiling of zero, and assert the zero-spend tier served it for nothing.
 *
 * Everything it needs is already contract, not configuration: the participant is a KINP
 * identity (the registry supplies the address), the capability name and its wire come from
 * the provider's manifest, and the ceiling rides in the header that manifest advertises.
 */
import { PROVIDER_ROUTER_IDENTITY } from '@agora/registry';
import { SPEC_VERSIONS, type ScenarioDocument } from '@agora/schemas';

/** The zero-spend tier, as the router names it on its own ladder. */
export const ZERO_SPEND_TIER = 'placeholder';

export const PROVIDER_ROUTER_ROUNDTRIP: ScenarioDocument = {
  kcs_version: SPEC_VERSIONS.kcs,
  id: 'kcs:provider-router-roundtrip',
  title: 'The commons always completes: a text completion served by the zero-spend tier',
  timeout_ms: 30_000,
  participants: [{ identity: PROVIDER_ROUTER_IDENTITY, planes: ['knowledge'] }],
  steps: [
    {
      id: 'router',
      kind: 'resolve',
      title: 'The participant is an identity, not an address (KINP §8)',
      ref: { id: PROVIDER_ROUTER_IDENTITY, kind: 'agent' },
    },
    {
      id: 'completion',
      kind: 'invoke',
      title: 'Ask for a completion with a ceiling of zero budget units',
      participant: PROVIDER_ROUTER_IDENTITY,
      capability: 'generate.text',
      budget_units: 0,
      timeout_ms: 15_000,
      inputs: [
        {
          port: { plane: 'knowledge', shape: 'chat-messages' },
          value: {
            messages: [{ role: 'user', content: 'In one sentence, what is the agora commons?' }],
          },
        },
      ],
      options: { max_tokens: 64 },
    },
    {
      id: 'served-by-the-zero-spend-tier',
      kind: 'assert',
      title: 'With no keys and no local servers, the ladder lands on the placeholder',
      predicate: 'tier_resolved',
      args: ['completion', ZERO_SPEND_TIER],
    },
    {
      id: 'spent-nothing',
      kind: 'assert',
      title: 'A zero ceiling was honored — projected and actual (KCB §5)',
      predicate: 'cost_within_ceiling',
      args: ['completion', 0],
    },
    {
      id: 'the-registry-can-route-it',
      kind: 'assert',
      title: 'Discovery describes the route it handed back (KCB §3)',
      predicate: 'capability_path_exists',
      args: [
        { plane: 'knowledge', shape: 'chat-messages' },
        { plane: 'knowledge', shape: 'completion-text' },
      ],
    },
    {
      id: 'always-completes',
      kind: 'assert',
      title: 'The scenario-wide liveness property (KCS §5)',
      predicate: 'always_completes',
    },
  ],
};
