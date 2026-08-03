//! The media-timeline path is OTIO's, carried whole (KMI §4 / koine ADR-0005).
//!
//! These tests are about what the *core* is responsible for on that path: carrying an
//! OTIO document without loss, checking the §4.1 obligations, and refusing the §4.4
//! legacy EDL shapes. Conversion is not tested here because conversion is not done here —
//! CMX3600/FCP are OTIO's adapters, driven through the Python facade, and their
//! round trip is asserted in `crates/py/tests/test_otio_roundtrip.py`.
//!
//! The fixture is a document **OTIO itself wrote** (`tools/gen_timeline_fixture.py`), so
//! a green run here is over real OTIO output rather than our idea of it.

use serde_json::Value;
use translation_core::media::{Timeline, LEGACY_EDL_MEDIA_TYPE, NLE_ADAPTERS, OTIO_MEDIA_TYPE};

const FIXTURE: &str = include_str!("../fixtures/timeline.otio.json");

fn timeline() -> Timeline {
    Timeline::from_otio_json(FIXTURE).expect("the fixture is a conformant OTIO timeline")
}

/// §4.1: the root is an OTIO `Timeline`, its `tracks` a `Stack` of `Track`s whose kinds
/// are OTIO's own — multitrack V/A needs no KMI construct.
#[test]
fn reads_otios_own_composition_structure() {
    let timeline = timeline();
    assert_eq!(timeline.schema_version(), "Timeline.1");
    assert_eq!(timeline.name(), Some("recap-trailer"));

    let tracks = timeline.tracks();
    let kinds: Vec<(Option<&str>, &str)> = tracks.iter().map(|t| (t.name, t.kind)).collect();
    assert_eq!(
        kinds,
        vec![
            (Some("V1"), "Video"),
            (Some("A1"), "Audio"),
            (Some("A2"), "Audio"),
        ]
    );
    // The video track's lead-in is an OTIO Gap, in the track's ordered children — a
    // clip's timeline position is that order, not a field (§4.4 mapping table).
    assert_eq!(tracks[0].children.len(), 2);
    assert_eq!(
        tracks[0].children[0].get("OTIO_SCHEMA").and_then(Value::as_str),
        Some("Gap.1")
    );
}

/// §4.1: timing is `RationalTime` / `TimeRange`, each carrying its own rate — there is no
/// document-level frame rate to read. The audio clips sit at 48 kHz while the video runs
/// at 24 fps, in the same timeline, precisely because the rate rides the value.
#[test]
fn timing_is_otio_rational_time_with_a_per_value_rate() {
    let timeline = timeline();
    let clips = timeline.clips();
    let names: Vec<Option<&str>> = clips.iter().map(|c| c.name).collect();
    assert_eq!(
        names,
        vec![Some("renaud-approach"), Some("score"), Some("narration")]
    );

    let shot = clips[0].source_range.expect("the clip has an in/out");
    assert_eq!(shot.start_time.value, 288.0);
    assert_eq!(shot.start_time.rate, 24.0);
    assert_eq!(shot.duration.value, 96.0);

    let score = clips[1].source_range.expect("the clip has an in/out");
    assert_eq!(score.duration.value, 1_440_000.0);
    assert_eq!(score.duration.rate, 48_000.0);

    assert!(timeline.as_value().get("fps").is_none());
}

/// A media reference is OTIO's own class, whichever it is: the offline narration rides a
/// `MissingReference` and is still read, with its location simply absent.
#[test]
fn reads_every_otio_media_reference_class() {
    let timeline = timeline();
    let clips = timeline.clips();
    let shot = &clips[0].media_references[0];
    assert_eq!(shot.schema, "ExternalReference.1");
    assert_eq!(shot.target_url, Some("file:///conform/renaud-approach.mov"));

    let narration = &clips[2].media_references[0];
    assert_eq!(narration.schema, "MissingReference.1");
    assert_eq!(narration.target_url, None);
}

/// The document is *carried*, not mapped onto a model of ours: everything OTIO put in it
/// — classes, fields, defaults this crate has never heard of — comes back out. Structural
/// equality, since re-emitting through any JSON map normalizes key order; the
/// byte-canonical form is OTIO's own writer's.
#[test]
fn round_trips_the_otio_document_without_loss() {
    let timeline = timeline();
    let out: Value = serde_json::from_str(&timeline.to_otio_json()).expect("valid JSON out");
    let original: Value = serde_json::from_str(FIXTURE).expect("valid JSON in");
    assert_eq!(out, original);

    // And re-reading what we emitted yields the same timeline — the carrier is idempotent.
    let again = Timeline::from_otio_json(&timeline.to_otio_json()).expect("still conformant");
    assert_eq!(again.as_value(), timeline.as_value());
}

/// §4.4: the bespoke JSON EDL is deprecated, and a document wearing its shape is not a
/// canonical timeline. The rejection names what replaced the field, since the mapping is
/// total.
#[test]
fn rejects_the_deprecated_json_edl_shapes() {
    let document_level_fps = r#"{"OTIO_SCHEMA":"Timeline.1","fps":23.976,
        "tracks":{"OTIO_SCHEMA":"Stack.1","children":[]}}"#;
    let err = Timeline::from_otio_json(document_level_fps)
        .unwrap_err()
        .to_string();
    assert!(err.contains(LEGACY_EDL_MEDIA_TYPE), "{err}");
    assert!(err.contains("RationalTime"), "{err}");

    let legacy_clip = r#"{"OTIO_SCHEMA":"Timeline.1","tracks":{"OTIO_SCHEMA":"Stack.1",
        "children":[{"OTIO_SCHEMA":"Track.1","kind":"Video","children":[
          {"OTIO_SCHEMA":"Clip.1","name":"c","in_ms":12000,"out_ms":16000}]}]}}"#;
    let err = Timeline::from_otio_json(legacy_clip).unwrap_err().to_string();
    assert!(err.contains("in_ms"), "{err}");
    assert!(err.contains("source_range"), "{err}");
}

/// §4.1: KMI adds no classes to OTIO's schema, so a class the core does not know is not
/// an error — it passes through untouched, and only what koine constrains is checked.
#[test]
fn unknown_otio_classes_pass_through_untouched() {
    let exotic = r#"{"OTIO_SCHEMA":"Timeline.1","tracks":{"OTIO_SCHEMA":"Stack.1",
        "children":[{"OTIO_SCHEMA":"Track.1","kind":"Video","children":[
          {"OTIO_SCHEMA":"SomeFutureItem.7","payload":{"a":1}}]}]}}"#;
    let timeline = Timeline::from_otio_json(exotic).expect("not ours to reject");
    let out: Value = serde_json::from_str(&timeline.to_otio_json()).expect("valid JSON");
    assert_eq!(
        out["tracks"]["children"][0]["children"][0]["payload"]["a"],
        Value::from(1)
    );

    let bad_kind = r#"{"OTIO_SCHEMA":"Timeline.1","tracks":{"OTIO_SCHEMA":"Stack.1",
        "children":[{"OTIO_SCHEMA":"Track.1","kind":"Subtitle","children":[]}]}}"#;
    let err = Timeline::from_otio_json(bad_kind).unwrap_err().to_string();
    assert!(err.contains("outside the profile"), "{err}");
}

/// The engine names OTIO's adapters; it does not implement them. This asserts the shape
/// of that claim: the §4.3 table is a list of *plugin names*, and the core carries no
/// converter of its own for any of those formats.
#[test]
fn nle_formats_are_reached_by_naming_otios_adapters() {
    assert_eq!(OTIO_MEDIA_TYPE, "application/vnd.opentimelineio+json");
    let cmx = NLE_ADAPTERS
        .iter()
        .find(|a| a.format == "CMX3600 EDL")
        .expect("§4.3 lists CMX3600");
    assert_eq!(cmx.otio_adapter, "cmx_3600");
    assert!(cmx.reads && cmx.writes);
}
