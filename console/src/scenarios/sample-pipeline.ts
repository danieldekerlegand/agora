/**
 * `kcs:sample-pipeline` — the identity firewall, encoded (KCS §6).
 *
 * **This is a neutral sample.** A commons runtime ships the agnostic KCS runner and one
 * scenario proving it runs end to end; the ecosystem's real conformance scenarios — with a
 * deployment's own participants, worlds and fixtures — live in the private `legacy`
 * integration repo and are loaded from there. Everything below is cast from generic
 * `producer` / `processor` / `curator` authorities on purpose.
 *
 * What it exercises is every plane and verb the runner implements, in one pass: a producer
 * publishes a world-scoped claim and a `based_on` link to an entity in the baseline world; a
 * processor ingests a recording of that world and extracts knowledge from it; a curator
 * reconciles the extraction and answers queries in both worlds. The property asserted is the
 * one KINP §4.3/§5 exists for: **knowledge in the baseline world stays uncontaminated by a
 * scoped world, and the two remain queryable together.**
 *
 * The four properties it holds the stack to:
 *
 * * **A** — an asset carries its `source_world`, so ingested media announces which world its
 *   bytes depict. `source_world_is` on the recording is that rule's regression test; without
 *   it the extraction in Step 3 defaults to the baseline world and the firewall never
 *   engages.
 * * **B** — cross-producer dedup needs shared normalization. Encoded as: re-emit the
 *   extraction *after* reconciliation and watch it reduce onto the claim the producer already
 *   published (`claims_converge`) instead of minting a second hash for the same fact.
 * * **C** — the resolver's `same_as`-vs-`based_on` rule. The curator reconciles into a
 *   `based_on` (different world, different ontological status) and a `same_as` (same
 *   world); `no_sameas_across_worlds` proves the scoped-world entity still has no
 *   equivalence path to the baseline entity, through both hops.
 * * **D** — `retracts` is a reserved relation; Step 6 emits one rather than mutating an
 *   immutable claim.
 *
 * **On the participants.** None of the three has published a KCB manifest, so all three
 * declare a `standin` (KCS delta N) and the report says `stubbed`. The fixtures are
 * fabric-shaped — KGP delta packs, KMI envelopes, KINP links as the specs write them — and
 * the runner *prefers a live registration over a stand-in*, so the day a peer adopts the bus
 * its fixture is deleted and this document is unchanged.
 *
 * **On ids.** A compact KINP CURIE is three segments, so a provisional local the processor
 * minted before it knew what it was looking at is `processor:ent:c-4410` — the authority is
 * `processor`, and "local" is what having no world scoping already means (KINP §3.4/§6).
 */
import { SPEC_VERSIONS, type ScenarioDocument } from '@agora/schemas';

import {
  SAMPLE_PIPELINE_PROCESSOR,
  SAMPLE_PIPELINE_PRODUCER,
  SAMPLE_PIPELINE_CURATOR,
} from '../fixtures/standins.ts';

export const PRODUCER = 'producer:agent:publisher';
export const PROCESSOR = 'processor:agent:pipeline';
export const CURATOR = 'curator:agent:resolver';

/** The scoped world, its fork (which overrides a baseline fact), and the baseline (KINP §5). */
export const SAMPLE_WORLD = 'producer:world:sample';
export const FORK = 'producer:world:sample#variant-a';
export const BASELINE = 'curator:world:baseline';

const ITEM = `${SAMPLE_WORLD}:ent:item-alpha`;
const ASSEMBLY = `${SAMPLE_WORLD}:ent:assembly-alpha`;
/** The baseline-world entity the scoped one was modeled on. */
const REFERENCE = 'curator:ent:reference-alpha';
/** Where the baseline entity bottoms out in an external authority — Q1's answer. */
const EXTERNAL_ANCHOR = 'external:ent:ref-0001';
const SITE = 'curator:ent:site-north';
/** What the processor's extraction pass minted before it knew what it saw (KINP §6, provisional). */
const EXTRACTED = 'processor:ent:c-4410';
const RECORDING = 'processor:asset:blake3-a1b2c3';

/** The claim the producer published, and the extraction that says the same thing. */
const PUBLISHED_CLAIM = 'producer:claim:sha256-9f3c1a';
const EXTRACTED_CLAIM = 'processor:claim:sha256-c31d70';
/** The baseline entity's anchor into the external authority — Q1's answer. */
const ANCHOR_CLAIM = 'curator:claim:sha256-77e0b4';
/** `offline(site-north)` — true in the fork, and nowhere else. */
const OVERRIDE_CLAIM = 'producer:claim:sha256-5a7e0f';

export const SAMPLE_PIPELINE: ScenarioDocument = {
  kcs_version: SPEC_VERSIONS.kcs,
  id: 'kcs:sample-pipeline',
  title: 'A scoped world stays uncontaminated across the media→knowledge bridge',
  timeout_ms: 120_000,
  participants: [
    {
      identity: PRODUCER,
      planes: ['knowledge'],
      standin: { fixtures: SAMPLE_PIPELINE_PRODUCER },
    },
    {
      identity: PROCESSOR,
      planes: ['media', 'knowledge'],
      standin: { fixtures: SAMPLE_PIPELINE_PROCESSOR },
    },
    {
      identity: CURATOR,
      planes: ['knowledge', 'entity'],
      standin: { fixtures: SAMPLE_PIPELINE_CURATOR },
    },
  ],

  setup: [
    {
      id: 'world',
      kind: 'resolve',
      title: 'Step 1 — the world is a KINP identity, not a string (§8)',
      ref: { id: SAMPLE_WORLD, kind: 'world' },
    },
    {
      id: 'published',
      kind: 'subscribe',
      title: 'Step 1 — the producer publishes the world: an entity, a world-scoped claim, ' +
        'and the based_on link to the baseline entity it was modeled on',
      participant: PRODUCER,
      world: SAMPLE_WORLD,
    },
  ],

  steps: [
    {
      id: 'recording',
      kind: 'fetch',
      title: 'Step 2 — the recording lands in the processor; the envelope must say which ' +
        'world the bytes depict (delta A)',
      participant: PROCESSOR,
      asset: RECORDING,
    },
    {
      id: 'extract',
      kind: 'invoke',
      title: 'Step 3 — extraction mints a provisional local entity and a low-confidence ' +
        'claim, scoped to the source world rather than to the baseline',
      participant: PROCESSOR,
      capability: 'extract.knowledge',
      inputs: [
        {
          port: { plane: 'media', media_types: ['video/mp4'] },
          ref: '${recording.asset}',
        },
        {
          port: { plane: 'knowledge', dialect: 'grounding-only', worlds: [SAMPLE_WORLD] },
          value: { source_world: '${recording.source_world}' },
        },
      ],
    },
    {
      id: 'reconcile',
      kind: 'invoke',
      title: 'Step 4 — the curator reconciles the extraction: based_on across worlds, ' +
        'same_as within one (delta C)',
      participant: CURATOR,
      capability: 'resolve.reconcile',
      inputs: [
        {
          port: { plane: 'entity', types: ['ent'] },
          value: { ref: EXTRACTED, world: SAMPLE_WORLD, kind: 'person' },
        },
      ],
    },
    {
      id: 'dedup',
      kind: 'emit',
      title: 'Step 3/4 — re-emit the extraction with reconciled entity ids and no minted ' +
        'hash; normalization has to reduce it onto the claim the producer already ' +
        'published (delta B)',
      participant: CURATOR,
      pack: {
        kgp_version: '0.4.0',
        kind: 'delta',
        dialect: 'grounding-only',
        worlds: [SAMPLE_WORLD],
        assertions: [
          {
            world: SAMPLE_WORLD,
            subject: ITEM,
            relation: 'contains',
            object: ASSEMBLY,
            confidence: 0.55,
            prov: {
              agent: 'agora:agent:console',
              activity: 'processor:src:run-1a2b',
              asserted: '2026-07-18T06:22:00Z',
            },
          },
        ],
      },
    },
    {
      id: 'lineage',
      kind: 'invoke',
      title: 'Q1 — which baseline entities were the things in my recording modeled on? ' +
        '(attaches_to → sample → based_on → same_as)',
      participant: CURATOR,
      capability: 'query.lineage',
      inputs: [
        {
          port: { plane: 'entity', types: ['ent', 'asset'] },
          value: { from_asset: '${recording.asset}', via: ['based_on', 'same_as'] },
        },
      ],
    },
    {
      id: 'about-the-baseline-entity',
      kind: 'invoke',
      title: 'Q2 — list facts true of the baseline entity. The decisive property: no ' +
        'scoped-world claim may come back',
      participant: CURATOR,
      capability: 'query.facts',
      inputs: [
        {
          port: { plane: 'knowledge', dialect: 'grounding-only', worlds: [BASELINE] },
          value: { subject: REFERENCE, world: BASELINE, traverse: ['same_as'] },
        },
      ],
    },
    {
      id: 'in-the-fork',
      kind: 'invoke',
      title: 'Q3 — the same question inside the fork, where the scoped world overrides a ' +
        'baseline fact (world inheritance + override precedence, KINP §5)',
      participant: PRODUCER,
      capability: 'query.facts',
      inputs: [
        {
          port: { plane: 'knowledge', dialect: 'grounding-only', worlds: [FORK] },
          value: { subject: SITE, world: FORK },
        },
      ],
    },
    {
      id: 'retraction',
      kind: 'emit',
      title: 'Step 6 — the 0.55 extraction was a misdetection. Claims are immutable, so a ' +
        'retraction is asserted with a later transaction time (delta D)',
      participant: PROCESSOR,
      claim: {
        world: SAMPLE_WORLD,
        subject: EXTRACTED_CLAIM,
        relation: 'retracts',
        reason: 'misdetection',
        prov: {
          agent: 'agora:agent:console',
          activity: 'processor:src:review-9c4d',
          asserted: '2026-07-20T11:30:00Z',
        },
      },
    },

    // ---- §5 assertions. Every one reads the observation log, never a peer's prose. ----

    {
      id: 'published-claim-is-world-scoped',
      kind: 'assert',
      title: 'Step 1 held — the claim is scoped to its world, never to the baseline',
      predicate: 'claim_in_world',
      args: [PUBLISHED_CLAIM, SAMPLE_WORLD],
    },
    {
      id: 'item-modeled-on-reference',
      kind: 'assert',
      title: 'Step 1 held — the lineage to the baseline entity is recorded as based_on (§4.3)',
      predicate: 'based_on_exists',
      args: [ITEM, REFERENCE],
    },
    {
      id: 'recording-declares-its-world',
      kind: 'assert',
      title: 'Delta A — the source world travels WITH the asset, or nothing downstream can ' +
        'know which world the recording depicts',
      predicate: 'source_world_is',
      args: [RECORDING, SAMPLE_WORLD],
    },
    {
      id: 'recording-attaches-to-the-item',
      kind: 'assert',
      title: 'Step 2 held — media hangs off entities by identifier (KINP §7.2)',
      predicate: 'asset_attaches_to',
      args: [RECORDING, ITEM],
    },
    {
      id: 'extraction-lands-in-the-source-world',
      kind: 'assert',
      title: 'Step 3 held (given delta A) — extracted knowledge lands in the sample world, ' +
        'which is the moment the firewall either engages or fails open',
      predicate: 'claim_in_world',
      args: [EXTRACTED_CLAIM, SAMPLE_WORLD],
    },
    {
      id: 'extraction-says-who-extracted-it',
      kind: 'assert',
      title: 'Step 3 held — a 0.55-confidence machine claim must be attributable (KINP §7.1)',
      predicate: 'provenance_present',
      args: [EXTRACTED_CLAIM],
    },
    {
      id: 'extraction-modeled-on-reference',
      kind: 'assert',
      title: 'Delta C — a candidate in another, non-identity-inheriting world reconciles ' +
        'to based_on',
      predicate: 'based_on_exists',
      args: [EXTRACTED, REFERENCE],
    },
    // Both firewall assertions are anchored at `item-alpha` rather than at the extracted
    // entity, and that is deliberate: `no_sameas_across_worlds` decides on the worlds the
    // two ids are *named into* (KINP §5), and `processor:ent:c-4410` is a provisional local
    // named into no world at all. Anchoring at the world-scoped end is what gives the
    // predicate something to compare — and the same_as closure walks *through* c-4410
    // anyway, so a reconciler that wrongly equated it to reference-alpha fails both of these.
    {
      id: 'firewall-holds-one-hop',
      kind: 'assert',
      title: 'Step 1/4 held — nothing promoted the scoped-world entity to an equivalence ' +
        'with the baseline one',
      predicate: 'no_sameas_across_worlds',
      args: [ITEM, REFERENCE],
    },
    {
      id: 'firewall-holds-through-the-anchor',
      kind: 'assert',
      title: 'Step 4 held — and no same_as path runs item-alpha → c-4410 → reference-alpha → ' +
        'the external anchor either; the scoped world reaches the baseline only by based_on',
      predicate: 'no_sameas_across_worlds',
      args: [ITEM, EXTERNAL_ANCHOR],
    },
    {
      id: 'the-same-fact-is-one-claim',
      kind: 'assert',
      title: 'Delta B — post-reconciliation the extraction reduces onto the published claim ' +
        'instead of minting a second hash for the same fact',
      predicate: 'claims_converge',
      args: ['${dedup.claims.0}', PUBLISHED_CLAIM],
    },
    {
      id: 'lineage-answers-in-the-baseline',
      kind: 'assert',
      title: 'Q1 held — the traversal reaches the baseline world and answers there',
      predicate: 'claim_in_world',
      args: [ANCHOR_CLAIM, BASELINE],
    },
    {
      id: 'no-scoped-claims-in-the-baseline-answer',
      kind: 'assert',
      title: 'Q2 held — THE core anti-contamination property: facts about the baseline ' +
        'entity return nothing from the sample world',
      predicate: 'firewall_holds',
      args: ['about-the-baseline-entity', BASELINE],
    },
    {
      id: 'the-override-stays-in-its-fork',
      kind: 'assert',
      title: 'Q3 held — offline(site-north) is observed in the fork and in no other ' +
        'world; the baseline query above never saw it',
      predicate: 'claim_in_world',
      args: [OVERRIDE_CLAIM, FORK],
    },
    {
      id: 'the-retraction-is-world-scoped-too',
      kind: 'assert',
      title: 'Step 6 held — bitemporality corrects a belief without mutating a claim, and ' +
        'the correction is scoped like everything else',
      predicate: 'claim_in_world',
      args: ['${retraction.claims.0}', SAMPLE_WORLD],
    },
    {
      id: 'always-completes',
      kind: 'assert',
      title: 'The run itself: every step that was meant to succeed did (KCS §5)',
      predicate: 'always_completes',
    },
  ],
};
