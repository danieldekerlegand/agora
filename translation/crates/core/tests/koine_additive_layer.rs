//! koine's additive layer over OTIO — identity, lineage, and knowledge (KMI §4.2).
//!
//! Adopting OTIO settled the *composition*; these tests are about the three things OTIO
//! has no model for and koine does. They matter most at the seam the adoption created: an
//! NLE format addresses media by path and carries no namespaced metadata, so a trip
//! through one is where a content-addressed asset id can quietly become a file path, the
//! lineage graph can quietly detach from the edit, and analysis can quietly become an
//! annotation instead of a claim. None of those may happen.
//!
//! The adapter cycle is simulated here — every `metadata.koine` block removed, which is
//! precisely what a path-addressing format does to a document — because conversion is
//! OTIO's and belongs in a test that has OTIO. `crates/py/tests/test_otio_koine_layer.py`
//! runs the same assertions with OTIO's real `cmx_3600` adapter doing the damage.

use serde_json::Value;
use translation_core::media::{
    analysis_assertions, assertion_facts, AnalysisObservation, AssetEnvelope, AssetId,
    LineageGraph, LineageLink, LineageRelation, MediaMap, Timeline, ANALYSIS_BRIDGE_INPUT_PLANE,
    ANALYSIS_BRIDGE_OUTPUT_PLANE, OTIO_MEDIA_TYPE,
};
use translation_core::render_annotated_fact;

const FIXTURE: &str = include_str!("../fixtures/timeline.otio.json");

const SHOT: &str = "analyzer:asset:blake3-c3d4e5f6a1b2";
const SCORE: &str = "mediastore:asset:blake3-b7c8d9e0f1a2";
const NARRATION: &str = "analyzer:asset:blake3-d4e5f6a1b2c3";
const MASTER: &str = "analyzer:asset:blake3-a1b2c3d4e5f6";
const WORLD: &str = "worldsim:world:alderforest";
const RENAUD: &str = "worldsim:world:alderforest:ent:npc-renaud";

fn timeline() -> Timeline {
    Timeline::from_otio_json(FIXTURE).expect("the fixture is a conformant OTIO timeline")
}

fn asset(curie: &str) -> AssetId {
    AssetId::parse(curie).expect("a well-formed content-addressed asset id")
}

/// What a path-addressing NLE format does to a document: the composition survives, every
/// namespaced `metadata.koine` block does not (KMI §9.5).
fn strip_koine_metadata(timeline: &Timeline) -> Timeline {
    fn walk(value: &mut Value) {
        match value {
            Value::Object(map) => {
                if let Some(Value::Object(metadata)) = map.get_mut("metadata") {
                    metadata.remove("koine");
                }
                for child in map.values_mut() {
                    walk(child);
                }
            }
            Value::Array(items) => items.iter_mut().for_each(walk),
            _ => {}
        }
    }
    let mut doc = timeline.as_value().clone();
    walk(&mut doc);
    Timeline::from_value(doc).expect("stripping koine's metadata leaves a valid OTIO timeline")
}

/// The composition itself — what OTIO owns, and what must be identical on both sides of
/// any repair koine performs: the tracks, and every clip's name and timing (at its own
/// rate, §4.1).
type Composition = (
    Vec<(Option<String>, String)>,
    Vec<(Option<String>, Option<(f64, f64, f64)>)>,
);

fn composition(timeline: &Timeline) -> Composition {
    let tracks = timeline
        .tracks()
        .iter()
        .map(|track| (track.name.map(str::to_string), track.kind.to_string()))
        .collect();
    let clips = timeline
        .clips()
        .into_iter()
        .map(|clip| {
            (
                clip.name.map(str::to_string),
                clip.source_range.map(|range| {
                    (
                        range.start_time.value,
                        range.duration.value,
                        range.duration.rate,
                    )
                }),
            )
        })
        .collect();
    (tracks, clips)
}

fn media_map() -> MediaMap {
    timeline()
        .media_map()
        .expect("the fixture's media map is well formed")
        .expect("the fixture carries one (§4.2d)")
}

/// §4.2a: a clip references its media by **KINP asset id**, and that id is the hash of the
/// bytes — not a path, not a name. The ids are the same ones the §4.3 media map keys on,
/// which is what makes relinking possible at all.
#[test]
fn clips_reference_assets_by_content_addressed_kinp_id() {
    let timeline = timeline();
    let ids: Vec<String> = timeline
        .asset_ids()
        .expect("every id parses")
        .iter()
        .map(|id| id.as_str().to_string())
        .collect();
    assert_eq!(ids, vec![SHOT, NARRATION, SCORE]);

    let shot = asset(SHOT);
    assert_eq!(shot.namespace(), "analyzer");
    assert_eq!(shot.hash_algorithm(), "blake3");
    assert_eq!(shot.digest(), "c3d4e5f6a1b2");

    // The identity is carried even where there is no path to offer: the narration rides a
    // MissingReference, and §4.2a still requires its id so an offline timeline stays
    // resolvable in the fabric.
    let offline = timeline
        .asset_references()
        .expect("references read")
        .into_iter()
        .find(|reference| reference.schema == "MissingReference.1")
        .expect("the fixture has one");
    assert_eq!(offline.target_url, None);
    assert_eq!(offline.asset.as_ref().map(AssetId::as_str), Some(NARRATION));

    // Every referenced asset is in the media map, keyed by that same id (§4.3).
    let map = media_map();
    assert_eq!(map.len(), 3);
    assert_eq!(map.get(&shot), Some("/conform/renaud-approach.mov"));
    assert!(timeline.unidentified_references().unwrap().is_empty());
}

/// The load-bearing round trip: a translate cycle through a path-addressing format drops
/// the ids, and the media map puts back **exactly** those ids — the same bytes' hashes,
/// not new ones. Stability is what the whole additive layer hangs off; an id that changed
/// across a cycle would silently fork every asset's identity, lineage, and knowledge.
#[test]
fn a_content_addressed_asset_id_is_stable_across_a_translate_cycle() {
    let original = timeline();
    let cycled = strip_koine_metadata(&original);

    // The loss is real, and detected rather than assumed away (§9.5).
    assert!(cycled.asset_ids().unwrap().is_empty());
    assert_eq!(cycled.unidentified_references().unwrap().len(), 3);
    assert_eq!(cycled.media_map().unwrap(), None);

    let relinked = cycled.relink(&media_map()).expect("the map relinks");

    // Byte-identical ids on the two path-bearing references — nothing minted, nothing lost.
    let restored: Vec<String> = relinked
        .asset_ids()
        .unwrap()
        .iter()
        .map(|id| id.as_str().to_string())
        .collect();
    assert_eq!(restored, vec![SHOT, SCORE]);

    // And the reference with no path at all is *reported*, not guessed: a media map is a
    // path index, so a MissingReference has nothing to match on. Inventing an id there —
    // by position, by name, by anything — would be minting identity.
    let unresolved = relinked.unidentified_references().unwrap();
    assert_eq!(unresolved.len(), 1);
    assert_eq!(unresolved[0].schema, "MissingReference.1");

    // OTIO's half is untouched by koine's repair: same clips, same tracks, same timing.
    assert_eq!(composition(&relinked), composition(&original));

    // The map that made the repair possible rides home (§4.2d), so the next hop needs no
    // second copy travelling beside the document.
    assert_eq!(relinked.media_map().unwrap(), Some(media_map()));
}

/// Relinking supplies what is absent and overrides nothing. The id is authoritative and
/// the `target_url` advisory (§4.2a), so a map that disagrees with an id loses.
#[test]
fn relinking_never_invents_or_overrides_identity() {
    let original = timeline();

    // A map naming a different asset at the shot's path does not renumber the shot.
    let mut misdirected = MediaMap::new();
    misdirected.insert(asset(MASTER), "/conform/renaud-approach.mov");
    let relinked = original.relink(&misdirected).expect("relinks");
    assert_eq!(
        relinked.asset_ids().unwrap(),
        original.asset_ids().unwrap(),
        "an existing id outranks the map (§4.2a)"
    );

    // A map that names none of the timeline's paths attaches nothing.
    let cycled = strip_koine_metadata(&original);
    let mut elsewhere = MediaMap::new();
    elsewhere.insert(asset(MASTER), "/archive/master.mov");
    let relinked = cycled.relink(&elsewhere).expect("relinks");
    assert!(relinked.asset_ids().unwrap().is_empty());
    assert_eq!(relinked.unidentified_references().unwrap().len(), 3);
}

/// §4.2b/§3: lineage is a graph *over assets*, held outside the timeline — so no adapter
/// can rewrite it. What a cycle can break is the join between the two, which is the
/// timeline's asset ids; relinking is what re-attaches an edit to its own lineage.
#[test]
fn the_asset_lineage_graph_survives_the_round_trip() {
    let shot = asset(SHOT);
    let master = asset(MASTER);
    let score = asset(SCORE);
    let lineage: LineageGraph = [
        LineageLink::certain(LineageRelation::ExcerptOf, shot.clone(), master.clone()),
        LineageLink {
            relation: LineageRelation::PerceptualMatch,
            subject: shot.clone(),
            object: asset("mediastore:asset:sha256-9f3c1a7b"),
            confidence: 0.71,
            source: Some("analyzer:run/1a2b".to_string()),
        },
        LineageLink::certain(LineageRelation::VariantOf, score.clone(), master.clone()),
        // Lineage among assets this edit never plays stays out of the edit's sub-graph.
        LineageLink::certain(
            LineageRelation::DerivedFrom,
            asset("mediastore:asset:blake3-0f0f0f0f"),
            master.clone(),
        ),
    ]
    .into_iter()
    .collect();

    let original = timeline();
    let before: Vec<&LineageLink> = lineage.for_timeline(&original).unwrap();
    assert_eq!(before.len(), 3);

    // Detached: the links are all still there, but an edit that has forgotten its asset
    // ids can no longer name them.
    let cycled = strip_koine_metadata(&original);
    assert_eq!(lineage.links().len(), 4);
    assert!(lineage.for_timeline(&cycled).unwrap().is_empty());

    // Re-attached, edge for edge, by the same repair that restored the ids.
    let relinked = cycled.relink(&media_map()).expect("relinks");
    assert_eq!(lineage.for_timeline(&relinked).unwrap(), before);

    // §3/KINP delta E: a lineage edge never collapses two assets into one identity — a
    // perceptual match least of all, which is a proposal for a review queue.
    assert!(LineageRelation::ALL
        .iter()
        .all(|relation| !relation.is_identity_bearing()));
    assert_eq!(lineage.constituents(&shot), vec![&master]);
}

/// §5 / §4.2c: media analysis becomes **KGP assertions**, scoped to the asset's world —
/// records with a relation, a confidence and provenance, not prose and not an OTIO
/// `Marker`. And the bridge is additive: it reads the OTIO-sourced timeline's assets and
/// writes nothing back into the document.
#[test]
fn analysis_becomes_plane_typed_kgp_claims_over_an_otio_sourced_timeline() {
    let timeline = timeline();
    let shot = asset(SHOT);
    let envelopes = vec![AssetEnvelope::ingested(
        shot.clone(),
        "video/mp4",
        WORLD,
        vec![RENAUD.to_string()],
    )];
    let observation = AnalysisObservation {
        asset: shot.clone(),
        relation: "cine:shows".to_string(),
        entity: RENAUD.to_string(),
        confidence: 0.88,
        source: "analyzer:run/1a2b".to_string(),
    };

    // The subject is an asset the OTIO timeline plays — the bridge runs over the adopted
    // model exactly as it ran over the prior media path.
    assert!(timeline.asset_ids().unwrap().contains(&shot));
    let claims =
        analysis_assertions(&[observation], &envelopes, &LineageGraph::new()).expect("bridged");
    assert_eq!(claims.len(), 1);
    let claim = &claims[0];
    assert_eq!(claim.world.as_deref(), Some(WORLD));
    assert_eq!(claim.relation, "cine:shows");
    assert_eq!(claim.subject, SHOT);
    assert_eq!(claim.object, RENAUD);
    assert_eq!(claim.confidence, 0.88);

    // Plane-typed (KMI §6 / KCB §2.1): media in, knowledge out. A claim is a
    // knowledge-plane record however media-plane its origin.
    assert_eq!(ANALYSIS_BRIDGE_INPUT_PLANE, "media");
    assert_eq!(OTIO_MEDIA_TYPE, "application/vnd.opentimelineio+json");
    assert_eq!(claim.plane(), ANALYSIS_BRIDGE_OUTPUT_PLANE);

    // Not generated text: it projects mechanically onto the engine's own fact vocabulary,
    // confidence becoming the annotated fact's probability, world and provenance riding
    // queryable companions.
    let facts = assertion_facts(&claims).expect("projected");
    let rendered: Vec<String> = facts
        .iter()
        .map(|fact| render_annotated_fact(fact).expect("renders"))
        .collect();
    assert_eq!(
        rendered,
        vec![
            format!("0.88::rel('cine:shows', '{SHOT}', '{RENAUD}').  % source: analyzer:run/1a2b"),
            format!(
                "rel_conf('cine:shows', '{SHOT}', '{RENAUD}', 0.88).  % source: analyzer:run/1a2b"
            ),
            format!(
                "rel_world('cine:shows', '{SHOT}', '{RENAUD}', '{WORLD}').  \
                 % source: analyzer:run/1a2b"
            ),
            format!(
                "rel_source('cine:shows', '{SHOT}', '{RENAUD}', 'analyzer:run/1a2b').  \
                 % source: analyzer:run/1a2b"
            ),
        ]
    );

    // Additive, not written back: the knowledge stays outside the timeline (§4.2c), so the
    // document is untouched and no Marker was minted to carry a claim.
    let document = timeline.to_otio_json();
    assert!(!document.contains("cine:shows"));
    assert!(!document.contains(RENAUD));
    assert_eq!(
        timeline.as_value(),
        Timeline::from_otio_json(FIXTURE).unwrap().as_value()
    );
}

/// Delta H, across editing: analysis of a *composite* attributes each claim to the
/// **constituent's** world, traced through lineage — because the composite is generated,
/// depicts no world of its own, and scoping it to one would drop its clips' claims out of
/// every fictional world.
#[test]
fn a_composites_claims_are_attributed_per_constituent_world() {
    let render = asset("mediastore:asset:blake3-facefeed");
    let shot = asset(SHOT);
    let envelopes = vec![
        AssetEnvelope::generated(render.clone(), "video/mp4"),
        AssetEnvelope::ingested(shot.clone(), "video/mp4", WORLD, vec![RENAUD.to_string()]),
    ];
    let lineage: LineageGraph = [LineageLink::certain(
        LineageRelation::ExcerptOf,
        render.clone(),
        shot.clone(),
    )]
    .into_iter()
    .collect();
    let observation = AnalysisObservation {
        asset: render.clone(),
        relation: "cine:shows".to_string(),
        entity: RENAUD.to_string(),
        confidence: 0.62,
        source: "analyzer:run/9c0d".to_string(),
    };

    let claims = analysis_assertions(std::slice::from_ref(&observation), &envelopes, &lineage)
        .expect("bridged");
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].world.as_deref(), Some(WORLD));
    assert_eq!(claims[0].subject, render.as_str());

    // With no constituent to attribute to, the bridge refuses rather than defaulting into
    // consensus reality — the firewall (KINP §4.3) is a refusal, not a fallback.
    let orphaned = analysis_assertions(
        &[observation],
        &[AssetEnvelope::generated(render, "video/mp4")],
        &LineageGraph::new(),
    )
    .unwrap_err()
    .to_string();
    assert!(orphaned.contains("no source_world"), "{orphaned}");
    assert!(orphaned.contains("consensus reality"), "{orphaned}");
}

/// The bridge emits claims, so it refuses the inputs that would make one meaningless: a
/// relation outside the registry's shape, a confidence that is not one, and a finding
/// about an entity the asset does not depict.
#[test]
fn the_bridge_refuses_what_would_not_be_a_kgp_claim() {
    let shot = asset(SHOT);
    let envelopes = vec![AssetEnvelope::ingested(
        shot.clone(),
        "video/mp4",
        WORLD,
        vec![RENAUD.to_string()],
    )];
    let sound = AnalysisObservation {
        asset: shot.clone(),
        relation: "cine:shows".to_string(),
        entity: RENAUD.to_string(),
        confidence: 0.88,
        source: "analyzer:run/1a2b".to_string(),
    };
    let bridge = |observation: AnalysisObservation| {
        analysis_assertions(&[observation], &envelopes, &LineageGraph::new())
            .unwrap_err()
            .to_string()
    };

    let err = bridge(AnalysisObservation {
        relation: "Renaud is approaching the treeline".to_string(),
        ..sound.clone()
    });
    assert!(err.contains("relation-registry CURIE"), "{err}");

    let err = bridge(AnalysisObservation {
        confidence: 1.4,
        ..sound.clone()
    });
    assert!(err.contains("not in [0, 1]"), "{err}");

    let err = bridge(AnalysisObservation {
        entity: "worldsim:world:alderforest:ent:npc-oriel".to_string(),
        ..sound.clone()
    });
    assert!(err.contains("attaches_to"), "{err}");

    let err = bridge(AnalysisObservation {
        asset: asset("analyzer:asset:blake3-deadbeef"),
        ..sound
    });
    assert!(err.contains("no asset envelope"), "{err}");
}
