/**
 * `kcs:media-transform` — the four-project transform chain, encoded (KCS §6).
 *
 * This is `koine/scenarios/e2e-media-transform.md` made executable. In Analyzer chat a user
 * asks for *"a 30-second recap trailer of my Alderforest playthrough, with narration and an
 * original orchestral score, delivered as a DaVinci project"*, and answering it drags every
 * surface of KCB and KMI through four projects at once: Insimul produces the footage,
 * Composer composes the score, Analyzer transforms, Pinakes takes the knowledge that falls out
 * the far end.
 *
 * Where `kcs:worlds-to-fabric` asserts the *identity* firewall, this one asserts the
 * **control and media planes**: that a route across planes can be planned before anything is
 * dialed, that bytes can be retrieved by id, that spend is bounded, and — the result the
 * pressure test called the key one — that the firewall survives the media→knowledge bridge
 * when the thing being analysed is a *generated composite*.
 *
 * The hand-written test found seven gaps; the deltas that closed them are what this scenario
 * now *checks* rather than describes:
 *
 * * **F** — transform typing spans all planes. The score leg consumes a mood descriptor
 *   (knowledge) and produces audio (media), which media-profile-only typing could not
 *   express and the registry could not route. `route-for-the-score` is its regression test:
 *   damage Composer's port typing back to media-only and the route disappears.
 * * **G** — there is a `fetch` verb. Step 1 of the body is a CAS GET of Insimul's master by
 *   KINP id; without it the whole chain is references nobody can dereference.
 * * **H** — `source_world` is conditional and per-asset. Ingested footage declares its world
 *   (`the-footage-declares-its-world`); the narration, the score, the EDL and the render are
 *   *generated* and declare `null` — a positive claim, not a silence.
 * * **J** — media ports carry a world. `route-from-the-world` asks for a route starting at
 *   *"video from `alderforest#save-7f`"*, which is unmatchable without the declaration.
 * * **K** — grants carry a spend ceiling. The score is the one paid hop in the chain, so it
 *   is the one invoke that declares `budget_units`, and `cost_within_ceiling` reads what
 *   Composer actually reported rather than what it projected.
 * * **L** — a reference may arrive before its bytes. The playthrough is still running, so a
 *   `subscribe` frame announces a clip whose bytes have not propagated; the fetch is
 *   declared `expect: reject` and the run carries on (`dangling_ref_tolerated`).
 *
 * **Delta I has no assertion, and that is a gap in KCS, not an oversight here.** The CMX3600
 * projection ships an asset-id ↔ path media map (KMI §4) so Resolve can relink; §5 has no
 * predicate that can read one, so the map travels into the observation log and nothing
 * checks it. A `media_map_complete(projection)` predicate is the koine follow-up.
 *
 * **On the participants.** None of the four has published a KCB manifest, so all four
 * declare a `standin` (KCS delta N) and the report says `stubbed`. Their fixtures carry a
 * `manifest` as well as canned exchanges — a peer off the bus is absent from the *control*
 * plane too, and Step 1 of this scenario is path planning. The runner indexes those
 * manifests for the run only and still prefers a live registration, so adoption deletes a
 * fixture rather than rewriting this document.
 */
import { SPEC_VERSIONS, type ScenarioDocument } from '@agora/schemas';

import {
  MEDIA_TRANSFORM_ARGOS,
  MEDIA_TRANSFORM_FORMANT,
  MEDIA_TRANSFORM_INSIMUL,
  MEDIA_TRANSFORM_PINAKES,
} from '../fixtures/standins.ts';

export const INSIMUL = 'insimul:agent:world-server';
export const ANALYZER = 'analyzer:agent:pipeline';
export const COMPOSER = 'composer:agent:composer';
export const PINAKES = 'pinakes:agent:resolver';

/** The playthrough fork the footage depicts — the only world in this scenario (KINP §5). */
export const SAVE_FORK = 'insimul:world:alderforest#save-7f';

/** What the NLE projection is, as a media profile — the goal port of the whole chain. */
export const CMX3600 = 'application/vnd.cmx3600.edl';
const EDL_JSON = 'application/vnd.koine.edl+json';

/** Ingested: the master recording, and a clip the still-running playthrough just announced. */
export const MASTER = 'insimul:asset:blake3-77aa10';
export const LATE_CLIP = 'insimul:asset:blake3-9d0e11';
/** Cut from the master, so it inherits the master's world (delta H, per-asset). */
export const CLIP = 'analyzer:asset:blake3-c10704';
/** Generated: each of these depicts no world at all. */
export const NARRATION = 'analyzer:asset:blake3-4e2f80';
export const SCORE = 'composer:asset:blake3-5c0e33';
export const EDL = 'analyzer:asset:blake3-ed10a2';
export const RENDER = 'analyzer:asset:blake3-d4af71';
export const PROJECT = 'analyzer:asset:blake3-cc36a0';

const RENAUD = 'insimul:world:alderforest:ent:npc-renaud';
const MOOD = 'analyzer:ent:mood-elegiac';

/** The mood the score leg consumes, and the two claims the render's analysis produced. */
const MOOD_CLAIM = 'analyzer:claim:sha256-6b1f09';
export const SHOWS_CLAIM = 'analyzer:claim:sha256-2ad4e1';
const CONTINUITY_CLAIM = 'analyzer:claim:sha256-90cc7b';

/** What Analyzer is willing to spend on a score. The chain's only priced hop (delta K). */
export const SCORE_CEILING = 40;

export const MEDIA_TRANSFORM: ScenarioDocument = {
  kcs_version: SPEC_VERSIONS.kcs,
  title: 'A trailer is composed across four projects without leaving the fabric',
  id: 'kcs:media-transform',
  timeout_ms: 120_000,
  participants: [
    {
      identity: INSIMUL,
      planes: ['media'],
      standin: { fixtures: MEDIA_TRANSFORM_INSIMUL },
    },
    {
      identity: ANALYZER,
      planes: ['media', 'knowledge'],
      standin: { fixtures: MEDIA_TRANSFORM_ARGOS },
    },
    {
      identity: COMPOSER,
      planes: ['knowledge', 'media'],
      standin: { fixtures: MEDIA_TRANSFORM_FORMANT },
    },
    {
      identity: PINAKES,
      planes: ['knowledge'],
      standin: { fixtures: MEDIA_TRANSFORM_PINAKES },
    },
  ],

  steps: [
    {
      id: 'master',
      kind: 'fetch',
      title: 'Step 4 — Analyzer references the playthrough by KINP id, then retrieves the ' +
        'bytes it has to cut from (delta G)',
      participant: INSIMUL,
      asset: MASTER,
    },
    {
      id: 'mood',
      kind: 'invoke',
      title: 'Step 1 — the score leg starts on the knowledge plane: av-analysis reads a ' +
        "mood out of the footage, scoped to the footage's own world",
      participant: ANALYZER,
      capability: 'analyze.mood',
      inputs: [
        {
          port: { plane: 'media', media_types: ['video/mp4'], world_pattern: '*' },
          ref: '${master.asset}',
        },
        {
          port: { plane: 'knowledge', dialect: 'grounding-only', worlds: [SAVE_FORK] },
          value: { source_world: '${master.source_world}' },
        },
      ],
    },
    {
      id: 'narrate',
      kind: 'invoke',
      title: 'Step 2 — narration is synthesized, not ingested: it depicts no world, and it ' +
        'costs nothing (the zero-spend rung)',
      participant: ANALYZER,
      capability: 'narrate',
      budget_units: 0,
      inputs: [
        {
          port: { plane: 'knowledge', shape: 'script', dialect: 'grounding-only' },
          value: {
            script: 'Thirty seconds of Alderforest, as the ash army crests the ridge.',
          },
        },
      ],
    },
    {
      id: 'score',
      kind: 'invoke',
      title: 'Step 3 — the cross-project paid hop: Composer composes to a mood descriptor, ' +
        'under a ceiling Analyzer states on the invoke (delta K)',
      participant: COMPOSER,
      capability: 'compose',
      budget_units: SCORE_CEILING,
      inputs: [
        {
          port: { plane: 'knowledge', shape: 'mood-descriptor', dialect: 'grounding-only' },
          value: { mood: MOOD, duration_ms: 30_000 },
          ref: MOOD_CLAIM,
        },
      ],
    },
    {
      id: 'clip',
      kind: 'invoke',
      title: 'Step 5 — the cut. An excerpt carries its range on its own envelope and ' +
        "inherits the master's world, because source_world is per-asset (delta H)",
      participant: ANALYZER,
      capability: 'edit.clip',
      inputs: [
        {
          port: { plane: 'media', media_types: ['video/mp4'], world_pattern: '*' },
          ref: '${master.asset}',
        },
      ],
    },
    {
      id: 'still-recording',
      kind: 'subscribe',
      title: 'Step 5 — the playthrough has not stopped; a delta announces a clip that was ' +
        'captured moments ago',
      participant: INSIMUL,
      world: SAVE_FORK,
    },
    {
      id: 'late-bytes',
      kind: 'fetch',
      title: 'Step 5 — and its bytes have not propagated yet. A consumer must tolerate the ' +
        'dangling reference and fetch it later (delta L)',
      participant: INSIMUL,
      asset: LATE_CLIP,
      expect: 'reject',
    },
    {
      id: 'edl',
      kind: 'invoke',
      title: 'Step 5 — the multitrack EDL: V1 clip, A1 score, A2 narration, every one of ' +
        'them referenced by id with nothing inlined',
      participant: ANALYZER,
      capability: 'conform',
      inputs: [
        {
          port: { plane: 'media', media_types: ['video/mp4'], world_pattern: '*' },
          ref: CLIP,
        },
        { port: { plane: 'media', media_types: ['audio/wav'] }, ref: SCORE },
        { port: { plane: 'media', media_types: ['audio/wav'] }, ref: NARRATION },
      ],
    },
    {
      id: 'render',
      kind: 'invoke',
      title: 'Step 6 — draft.mp4, derived_from the EDL. A generated composite, so it ' +
        'declares source_world null',
      participant: ANALYZER,
      capability: 'render',
      inputs: [{ port: { plane: 'media', media_types: [EDL_JSON] }, ref: EDL }],
    },
    {
      id: 'project',
      kind: 'invoke',
      title: 'Step 6 — the DaVinci projection. The canonical EDL stays the source of ' +
        'truth; the projection ships a media map so nothing goes offline (delta I)',
      participant: ANALYZER,
      capability: 'export.cmx3600',
      inputs: [{ port: { plane: 'media', media_types: [EDL_JSON] }, ref: EDL }],
    },
    {
      id: 'analysis',
      kind: 'invoke',
      title: 'Step 7 — continuity analysis of the RENDER. The decisive question: which ' +
        'world do claims about a generated composite land in?',
      participant: ANALYZER,
      capability: 'analyze.continuity',
      inputs: [{ port: { plane: 'media', media_types: ['video/mp4'] }, ref: RENDER }],
    },
    {
      id: 'publish',
      kind: 'emit',
      title: 'Step 7 — the media→knowledge bridge: what analysis found is published as a ' +
        'KGP delta, world-scoped like everything else',
      participant: PINAKES,
      pack: {
        kgp_version: '0.4.0',
        kind: 'delta',
        dialect: 'grounding-only',
        worlds: [SAVE_FORK],
        assertions: [
          {
            id: SHOWS_CLAIM,
            world: SAVE_FORK,
            subject: RENDER,
            relation: 'cine:shows',
            object: RENAUD,
            confidence: 0.88,
            prov: {
              agent: 'agora:agent:console',
              activity: 'analyzer:src:continuity-6f30',
              asserted: '2026-07-20T09:52:00Z',
            },
          },
          {
            id: CONTINUITY_CLAIM,
            world: SAVE_FORK,
            subject: RENDER,
            relation: 'cine:continuity_break',
            object: 'analyzer:ent:shot-14',
            confidence: 0.64,
            prov: {
              agent: 'agora:agent:console',
              activity: 'analyzer:src:continuity-6f30',
              asserted: '2026-07-20T09:52:00Z',
            },
          },
        ],
      },
    },

    // ---- §5 assertions. Every one reads the observation log or the index, never prose. ----

    {
      id: 'route-for-the-score',
      kind: 'assert',
      title: 'Delta F — the leg that broke path-finding: a transform that consumes ' +
        'KNOWLEDGE and produces MEDIA is routable at all',
      predicate: 'capability_path_exists',
      args: [
        { plane: 'knowledge', shape: 'mood-descriptor' },
        { plane: 'media', mediaType: 'audio/wav' },
      ],
    },
    {
      id: 'route-from-the-world',
      kind: 'assert',
      title: 'Delta J — "video from world alderforest#save-7f" is a matchable start port, ' +
        'and delta F again in the other direction (media → knowledge)',
      predicate: 'capability_path_exists',
      args: [
        { plane: 'media', mediaType: 'video/mp4', world: SAVE_FORK },
        { plane: 'knowledge', shape: 'mood-descriptor' },
      ],
    },
    {
      id: 'route-to-the-nle',
      kind: 'assert',
      title: 'Step 1 held — the registry can describe the whole chain from the ' +
        'world-scoped footage to a DaVinci project, across providers (KCB §3)',
      predicate: 'capability_path_exists',
      args: [
        { plane: 'media', mediaType: 'video/mp4', world: SAVE_FORK },
        { plane: 'media', mediaType: CMX3600 },
      ],
    },
    {
      id: 'the-footage-declares-its-world',
      kind: 'assert',
      title: 'Delta H — an INGESTED asset that depicts a world says which, or nothing ' +
        'downstream can scope what it extracts',
      predicate: 'source_world_is',
      args: [MASTER, SAVE_FORK],
    },
    {
      id: 'the-footage-hangs-off-the-npc',
      kind: 'assert',
      title: 'Step 4 held — media attaches to entities by identifier (KINP §7.2)',
      predicate: 'asset_attaches_to',
      args: [MASTER, RENAUD],
    },
    {
      id: 'the-clip-keeps-the-masters-world',
      kind: 'assert',
      title: 'Delta H — source_world is per-asset and an excerpt is still ingested ' +
        'footage, so the cut carries the fiction with it',
      predicate: 'source_world_is',
      args: [CLIP, SAVE_FORK],
    },
    {
      id: 'the-narration-depicts-no-world',
      kind: 'assert',
      title: 'Delta H, the half that broke — a SYNTHESIZED asset is not "true in" any ' +
        'world; null is the answer, and an unstated field is not null',
      predicate: 'source_world_is',
      args: [NARRATION, null],
    },
    {
      id: 'the-score-depicts-no-world',
      kind: 'assert',
      title: 'Delta H — and the same for a composed score, from another project entirely',
      predicate: 'source_world_is',
      args: [SCORE, null],
    },
    {
      id: 'the-render-depicts-no-world',
      kind: 'assert',
      title: 'Delta H — a composite imposes no single world on its constituents, so the ' +
        'render declares none of its own',
      predicate: 'source_world_is',
      args: [RENDER, null],
    },
    {
      id: 'the-narration-cost-nothing',
      kind: 'assert',
      title: 'The sacred ladder — the narration was served by a local rung under a ceiling ' +
        'of zero budget units',
      predicate: 'cost_within_ceiling',
      args: ['narrate', 0],
    },
    {
      id: 'the-score-stayed-under-its-ceiling',
      kind: 'assert',
      title: 'Delta K — the cross-project invoke chain cannot spend unbounded: the grant ' +
        'carries a ceiling and the paid tier reported inside it',
      predicate: 'cost_within_ceiling',
      args: ['score', SCORE_CEILING],
    },
    {
      id: 'the-score-came-off-the-paid-rung',
      kind: 'assert',
      title: 'And it says so: an unpriced or unreported route would fail the ceiling above',
      predicate: 'tier_resolved',
      args: ['score', 'paid-model'],
    },
    {
      id: 'the-late-clip-was-tolerated',
      kind: 'assert',
      title: 'Delta L — a reference arrived before its bytes; the consumer met the miss ' +
        'and the run carried on',
      predicate: 'dangling_ref_tolerated',
      args: [LATE_CLIP],
    },
    {
      id: 'the-mood-stayed-in-the-fiction',
      kind: 'assert',
      title: 'Step 1 held — knowledge read out of fictional footage lands in the fiction, ' +
        'which is where the firewall engages',
      predicate: 'claim_in_world',
      args: [MOOD_CLAIM, SAVE_FORK],
    },
    {
      id: 'analysis-lands-in-the-constituents-world',
      kind: 'assert',
      title: 'Step 7 — THE result of this pressure test: analysis of a generated composite ' +
        "is attributed to its constituent clip's world, traced through the lineage graph, " +
        'not to the composite (which has none)',
      predicate: 'analysis_attributed_to_constituent',
      args: [RENDER],
    },
    {
      id: 'the-analysis-says-who-ran-it',
      kind: 'assert',
      title: 'Step 7 held — a 0.88-confidence machine claim must be attributable (KINP §7.1)',
      predicate: 'provenance_present',
      args: [SHOWS_CLAIM],
    },
    {
      id: 'the-published-claims-stay-in-the-fork',
      kind: 'assert',
      title: 'Step 7 held — crossing the media→knowledge bridge does not promote a claim ' +
        'out of its world; consensus reality never sees the trailer',
      predicate: 'claim_in_world',
      args: ['${publish.claims.0}', SAVE_FORK],
    },
    {
      id: 'always-completes',
      kind: 'assert',
      title: 'The run itself: four projects, ten exchanges, every step that was meant to ' +
        'succeed did (KCS §5)',
      predicate: 'always_completes',
    },
  ],
};
