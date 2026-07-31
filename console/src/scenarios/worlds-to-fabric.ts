/**
 * **SAMPLE SCENARIO — not a contract.** The participants named below are the cast of the
 * ecosystem agora was extracted from, carried over verbatim so the scenario stays a faithful
 * executable of koine's own worked example. agora knows none of them: the runner resolves
 * whatever the registry indexes, and a conformant deployment writes its own scenario with its
 * own cast. Treat every project name here as fixture text.
 *
 * `kcs:worlds-to-fabric` — the identity firewall, encoded (KCS §6).
 *
 * This is `koine/scenarios/e2e-worlds-to-fabric.md` made executable: an Insimul designer
 * authors a fiction whose NPC is *modeled on* the real Napoleon, a playthrough is ingested
 * by Analyzer, Analyzer extracts knowledge from the footage, Pinakes reconciles what it extracted
 * against consensus reality, and the user then queries across all three. The property the
 * whole stack exists for is the one asserted here: **real-world knowledge stays
 * uncontaminated by fiction, and the two remain queryable together.**
 *
 * The hand-written test found five gaps; the deltas that closed them are what this
 * scenario now *checks* rather than describes:
 *
 * * **A** — an asset carries its `source_world`, so ingested footage announces that it is
 *   fiction. `source_world_is` on the footage is delta A's regression test; without it the
 *   extraction in Step 3 defaults to consensus reality and the firewall never engages.
 * * **B** — cross-producer dedup needs shared normalization. Encoded as: re-emit the
 *   extraction *after* reconciliation and watch it reduce onto the claim Insimul already
 *   published (`claims_converge`) instead of minting a second hash for the same fact.
 * * **C** — the resolver's `same_as`-vs-`based_on` rule. Pinakes reconciles into a
 *   `based_on` (different world, different ontological status) and a `same_as` (same
 *   world); `no_sameas_across_worlds` proves the fictional footage entity still has no
 *   equivalence path to the real Napoleon, through both hops.
 * * **D** — `retracts` is a reserved relation; Step 6 emits one rather than mutating an
 *   immutable claim.
 *
 * Delta E (byte-exact hashing ≠ perceptual identity) is a documented boundary about asset
 * re-encoding between Composer and Analyzer — that belongs to `kcs:media-transform`, not here.
 *
 * **On the participants.** None of Insimul, Analyzer or Pinakes has published a KCB manifest
 * yet, so all three declare a `standin` (KCS delta N) and the report says `stubbed`. The
 * fixtures are fabric-shaped — KGP delta packs, KMI envelopes, KINP links as the specs
 * write them — and the runner *prefers a live registration over a stand-in*, so the day a
 * project adopts the bus its fixture is deleted and this document is unchanged.
 *
 * **On ids.** The pressure test writes ids in Prolog (`id(ent, 'analyzer:local', 'e-8842')`);
 * a compact KINP CURIE is three segments, so the same entity is `analyzer:ent:e-8842` here —
 * the authority is `analyzer`, and "local" is what having no world scoping already means
 * (KINP §3.4/§6).
 */
import { SPEC_VERSIONS, type ScenarioDocument } from '@agora/schemas';

import {
  WORLDS_TO_FABRIC_ARGOS,
  WORLDS_TO_FABRIC_INSIMUL,
  WORLDS_TO_FABRIC_PINAKES,
} from '../fixtures/standins.ts';

export const INSIMUL = 'insimul:agent:world-server';
export const ANALYZER = 'analyzer:agent:pipeline';
export const PINAKES = 'pinakes:agent:resolver';

/** The fiction, and the playthrough fork that overrides a real fact inside it (KINP §5). */
export const ALDERFOREST = 'insimul:world:alderforest';
export const SAVE_FORK = 'insimul:world:alderforest#save-7f';
export const CONSENSUS = 'pinakes:world:consensus-reality';

const RENAUD = `${ALDERFOREST}:ent:npc-renaud`;
const ARMY_OF_ASH = `${ALDERFOREST}:ent:army-of-ash`;
const NAPOLEON = 'pinakes:ent:napoleon-i';
/** Where the real figure bottoms out in consensus reality — Q1's answer. */
const WIKIDATA = 'wikidata:ent:q517';
const PARIS = 'pinakes:ent:paris';
/** What Analyzer's vision pass minted before it knew who anyone was (KINP §6, provisional). */
const EXTRACTED = 'analyzer:ent:e-8842';
const FOOTAGE = 'analyzer:asset:blake3-a1b2c3';

/** The canon claim Insimul published, and the extraction that says the same thing. */
const CANON_CLAIM = 'insimul:claim:sha256-9f3c1a';
const EXTRACTED_CLAIM = 'analyzer:claim:sha256-c31d70';
/** Napoleon's anchor into consensus reality — Q1's answer (Wikidata Q517). */
const ANCHOR_CLAIM = 'pinakes:claim:sha256-77e0b4';
/** `destroyed(paris)` — true in the save fork, and nowhere else. */
const OVERRIDE_CLAIM = 'insimul:claim:sha256-5a7e0f';

export const WORLDS_TO_FABRIC: ScenarioDocument = {
  kcs_version: SPEC_VERSIONS.kcs,
  id: 'kcs:worlds-to-fabric',
  title: 'Fiction stays uncontaminated across the media→knowledge bridge',
  timeout_ms: 120_000,
  participants: [
    {
      identity: INSIMUL,
      planes: ['knowledge'],
      standin: { fixtures: WORLDS_TO_FABRIC_INSIMUL },
    },
    {
      identity: ANALYZER,
      planes: ['media', 'knowledge'],
      standin: { fixtures: WORLDS_TO_FABRIC_ARGOS },
    },
    {
      identity: PINAKES,
      planes: ['knowledge', 'entity'],
      standin: { fixtures: WORLDS_TO_FABRIC_PINAKES },
    },
  ],

  setup: [
    {
      id: 'world',
      kind: 'resolve',
      title: 'Step 1 — the fiction is a KINP identity, not a string (§8)',
      ref: { id: ALDERFOREST, kind: 'world' },
    },
    {
      id: 'canon',
      kind: 'subscribe',
      title: 'Step 1 — Insimul publishes the world: an NPC, an in-fiction claim, and the ' +
        'based_on link to the real figure it was modeled on',
      participant: INSIMUL,
      world: ALDERFOREST,
    },
  ],

  steps: [
    {
      id: 'footage',
      kind: 'fetch',
      title: 'Step 2 — the playthrough lands in Analyzer; the envelope must say which world ' +
        'the bytes depict (delta A)',
      participant: ANALYZER,
      asset: FOOTAGE,
    },
    {
      id: 'extract',
      kind: 'invoke',
      title: 'Step 3 — vision/ASR mints a provisional local entity and a low-confidence ' +
        'claim, scoped to the source world rather than to consensus reality',
      participant: ANALYZER,
      capability: 'extract.knowledge',
      inputs: [
        {
          port: { plane: 'media', media_types: ['video/mp4'] },
          ref: '${footage.asset}',
        },
        {
          port: { plane: 'knowledge', dialect: 'grounding-only', worlds: [ALDERFOREST] },
          value: { source_world: '${footage.source_world}' },
        },
      ],
    },
    {
      id: 'reconcile',
      kind: 'invoke',
      title: 'Step 4 — Pinakes reconciles the extraction: based_on across worlds, same_as ' +
        'within one (delta C)',
      participant: PINAKES,
      capability: 'resolve.reconcile',
      inputs: [
        {
          port: { plane: 'entity', types: ['ent'] },
          value: { ref: EXTRACTED, world: ALDERFOREST, kind: 'person' },
        },
      ],
    },
    {
      id: 'dedup',
      kind: 'emit',
      title: 'Step 3/4 — re-emit the extraction with reconciled entity ids and no minted ' +
        'hash; normalization has to reduce it onto the claim Insimul already published ' +
        '(delta B)',
      participant: PINAKES,
      pack: {
        kgp_version: '0.4.0',
        kind: 'delta',
        dialect: 'grounding-only',
        worlds: [ALDERFOREST],
        assertions: [
          {
            world: ALDERFOREST,
            subject: RENAUD,
            relation: 'commands',
            object: ARMY_OF_ASH,
            confidence: 0.55,
            prov: {
              agent: 'agora:agent:console',
              activity: 'analyzer:src:run-1a2b',
              asserted: '2026-07-18T06:22:00Z',
            },
          },
        ],
      },
    },
    {
      id: 'inspired-by',
      kind: 'invoke',
      title: 'Q1 — which real historical figures inspired characters in my footage? ' +
        '(attaches_to → alderforest → based_on → same_as)',
      participant: PINAKES,
      capability: 'query.lineage',
      inputs: [
        {
          port: { plane: 'entity', types: ['ent', 'asset'] },
          value: { from_asset: '${footage.asset}', via: ['based_on', 'same_as'] },
        },
      ],
    },
    {
      id: 'about-the-real-one',
      kind: 'invoke',
      title: 'Q2 — list facts true of the real Napoleon. The decisive property: no fiction ' +
        'claim may come back',
      participant: PINAKES,
      capability: 'query.facts',
      inputs: [
        {
          port: { plane: 'knowledge', dialect: 'grounding-only', worlds: [CONSENSUS] },
          value: { subject: NAPOLEON, world: CONSENSUS, traverse: ['same_as'] },
        },
      ],
    },
    {
      id: 'in-the-save',
      kind: 'invoke',
      title: 'Q3 — the same question inside the playthrough, where the fiction overrides a ' +
        'real fact (world inheritance + override precedence, KINP §5)',
      participant: INSIMUL,
      capability: 'query.facts',
      inputs: [
        {
          port: { plane: 'knowledge', dialect: 'grounding-only', worlds: [SAVE_FORK] },
          value: { subject: PARIS, world: SAVE_FORK },
        },
      ],
    },
    {
      id: 'retraction',
      kind: 'emit',
      title: 'Step 6 — the 0.55 extraction was a misdetection. Claims are immutable, so a ' +
        'retraction is asserted with a later transaction time (delta D)',
      participant: ANALYZER,
      claim: {
        world: ALDERFOREST,
        subject: EXTRACTED_CLAIM,
        relation: 'retracts',
        reason: 'misdetection',
        prov: {
          agent: 'agora:agent:console',
          activity: 'analyzer:src:review-9c4d',
          asserted: '2026-07-20T11:30:00Z',
        },
      },
    },

    // ---- §5 assertions. Every one reads the observation log, never a peer's prose. ----

    {
      id: 'canon-claim-is-fiction',
      kind: 'assert',
      title: 'Step 1 held — the in-fiction claim is scoped to its world, never to consensus',
      predicate: 'claim_in_world',
      args: [CANON_CLAIM, ALDERFOREST],
    },
    {
      id: 'renaud-modeled-on-napoleon',
      kind: 'assert',
      title: 'Step 1 held — the lineage to the real figure is recorded as based_on (§4.3)',
      predicate: 'based_on_exists',
      args: [RENAUD, NAPOLEON],
    },
    {
      id: 'footage-declares-its-world',
      kind: 'assert',
      title: 'Delta A — the source world travels WITH the asset, or nothing downstream can ' +
        'know the footage is fiction',
      predicate: 'source_world_is',
      args: [FOOTAGE, ALDERFOREST],
    },
    {
      id: 'footage-depicts-the-npc',
      kind: 'assert',
      title: 'Step 2 held — media hangs off entities by identifier (KINP §7.2)',
      predicate: 'asset_attaches_to',
      args: [FOOTAGE, RENAUD],
    },
    {
      id: 'extraction-lands-in-the-source-world',
      kind: 'assert',
      title: 'Step 3 held (given delta A) — extracted knowledge lands in alderforest, ' +
        'which is the moment the firewall either engages or fails open',
      predicate: 'claim_in_world',
      args: [EXTRACTED_CLAIM, ALDERFOREST],
    },
    {
      id: 'extraction-says-who-extracted-it',
      kind: 'assert',
      title: 'Step 3 held — a 0.55-confidence machine claim must be attributable (KINP §7.1)',
      predicate: 'provenance_present',
      args: [EXTRACTED_CLAIM],
    },
    {
      id: 'extraction-modeled-on-napoleon',
      kind: 'assert',
      title: 'Delta C — a candidate in another, non-identity-inheriting world reconciles ' +
        'to based_on',
      predicate: 'based_on_exists',
      args: [EXTRACTED, NAPOLEON],
    },
    // Both firewall assertions are anchored at `npc-renaud` rather than at the footage
    // entity, and that is deliberate: `no_sameas_across_worlds` decides on the worlds the
    // two ids are *named into* (KINP §5), and `analyzer:ent:e-8842` is a provisional local
    // named into no world at all. Anchoring at the world-scoped end is what gives the
    // predicate something to compare — and the same_as closure walks *through* e-8842
    // anyway, so a reconciler that wrongly equated it to Napoleon fails both of these.
    {
      id: 'firewall-holds-one-hop',
      kind: 'assert',
      title: 'Step 1/4 held — nothing promoted the fiction NPC to an equivalence with the ' +
        'real Napoleon',
      predicate: 'no_sameas_across_worlds',
      args: [RENAUD, NAPOLEON],
    },
    {
      id: 'firewall-holds-through-the-anchor',
      kind: 'assert',
      title: 'Step 4 held — and no same_as path runs npc-renaud → e-8842 → Napoleon → ' +
        'Wikidata either; the fiction reaches consensus reality only by based_on',
      predicate: 'no_sameas_across_worlds',
      args: [RENAUD, WIKIDATA],
    },
    {
      id: 'the-same-fact-is-one-claim',
      kind: 'assert',
      title: 'Delta B — post-reconciliation the extraction reduces onto the canon claim ' +
        'instead of minting a second hash for the same fact',
      predicate: 'claims_converge',
      args: ['${dedup.claims.0}', CANON_CLAIM],
    },
    {
      id: 'lineage-answers-with-a-real-figure',
      kind: 'assert',
      title: 'Q1 held — the traversal reaches consensus reality and answers there',
      predicate: 'claim_in_world',
      args: [ANCHOR_CLAIM, CONSENSUS],
    },
    {
      id: 'no-fiction-in-the-real-answer',
      kind: 'assert',
      title: 'Q2 held — THE core anti-contamination property: facts-about-real-Napoleon ' +
        'return nothing from alderforest',
      predicate: 'firewall_holds',
      args: ['about-the-real-one', CONSENSUS],
    },
    {
      id: 'the-override-stays-in-its-fork',
      kind: 'assert',
      title: 'Q3 held — destroyed(paris) is observed in the save fork and in no other ' +
        'world; the consensus query above never saw it',
      predicate: 'claim_in_world',
      args: [OVERRIDE_CLAIM, SAVE_FORK],
    },
    {
      id: 'the-retraction-is-world-scoped-too',
      kind: 'assert',
      title: 'Step 6 held — bitemporality corrects a belief without mutating a claim, and ' +
        'the correction is scoped like everything else',
      predicate: 'claim_in_world',
      args: ['${retraction.claims.0}', ALDERFOREST],
    },
    {
      id: 'always-completes',
      kind: 'assert',
      title: 'The run itself: every step that was meant to succeed did (KCS §5)',
      predicate: 'always_completes',
    },
  ],
};
