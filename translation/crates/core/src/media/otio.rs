//! OTIO's half of the media-timeline path: the canonical timeline, carried whole.
//!
//! KMI 0.3.0 §4 (koine `ADR-0005`) adopts the OTIO `Timeline` as the canonical composition
//! model, so nothing here is a timeline model of ours — there is no struct for a track, a
//! cut, or an EDL row, and no bespoke canonical serialization to keep in step with OTIO's.
//! What lives here is
//!
//! 1. the KMI media-plane constants (§2/§4) — the media types a media-plane port names,
//! 2. the §4.3 table naming **OTIO's own** adapters, and
//! 3. a read-only projection over an OTIO document that checks §4.1 conformance and lets
//!    koine's additive layer ([`super::koine`], §4.2) be read off it.
//!
//! See the [parent module](super) for how the engine reaches OTIO's reader, writer, and
//! adapters, and for what this crate deliberately does not do.

use crate::error::Error;
use serde_json::Value;

/// The media type of a canonical timeline (KMI §4): an OTIO `Timeline` in OTIO's JSON
/// serialization. OTIO has no IANA-registered type; KMI fixes this identifier so a
/// media-plane port can name it.
pub const OTIO_MEDIA_TYPE: &str = "application/vnd.opentimelineio+json";

/// The self-contained OTIO bundle serializations (`.otiod` directory / `.otioz` zip),
/// which MAY carry a timeline together with its media (KMI §4) — one way to satisfy the
/// media-map obligation of §4.3.
pub const OTIO_BUNDLE_MEDIA_TYPE: &str = "application/vnd.opentimelineio+zip";

/// The bespoke JSON EDL of KMI ≤ 0.2.0, **deprecated** by §4.4: readable, never emitted.
/// It is named here only so the reader can say why it is rejecting one.
pub const LEGACY_EDL_MEDIA_TYPE: &str = "application/vnd.koine.edl+json";

/// The KMI spec version this path implements. Pinned alongside the other koine spec
/// versions (`schemas/src/versions.ts`) — bump together.
pub const KMI_VERSION: &str = "0.3.2";

/// OTIO's own JSON adapter — the canonical form's reader/writer (KMI §4).
pub const OTIO_JSON_ADAPTER: &str = "otio_json";

/// One row of KMI §4.3's NLE-interchange table: a format, and the **OTIO adapter** that
/// reads/writes it. koine specifies *that* the canonical form is OTIO and *what koine
/// adds*; it does not re-specify the adapters, and neither does agora — this is a
/// reference to plugin names OTIO resolves at call time, not a dispatch table of ours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NleAdapter {
    /// The interchange format, as KMI §4.3 names it.
    pub format: &'static str,
    /// The name of OTIO's adapter for it, as `opentimelineio.adapters` resolves it.
    pub otio_adapter: &'static str,
    /// OTIO reads this format.
    pub reads: bool,
    /// OTIO writes this format.
    pub writes: bool,
}

/// KMI §4.3's table, verbatim. Every entry is bidirectional — which is why an edit that
/// leaves the fabric can come back, though lossily at each format's own edges. The
/// `ffmpeg`/programmatic-render row is deliberately absent: it has no adapter, the render
/// capability consumes the OTIO timeline directly.
///
/// Availability is OTIO's business, not ours: since OTIO 0.15 the NLE adapters ship as
/// separate plugin distributions (`otio-cmx3600-adapter`, `otio-fcp-adapter`,
/// `otio-aaf-adapter`), so a given interpreter has whichever are installed. Ask the
/// facade (`translation_py.otio_adapters()`) for the live list.
pub const NLE_ADAPTERS: [NleAdapter; 4] = [
    NleAdapter {
        format: "CMX3600 EDL",
        otio_adapter: "cmx_3600",
        reads: true,
        writes: true,
    },
    NleAdapter {
        format: "FCP7 xmeml",
        otio_adapter: "fcp_xml",
        reads: true,
        writes: true,
    },
    NleAdapter {
        format: "FCPXML",
        otio_adapter: "fcpx_xml",
        reads: true,
        writes: true,
    },
    NleAdapter {
        format: "AAF",
        otio_adapter: "aaf",
        reads: true,
        writes: true,
    },
];

/// An OTIO `RationalTime` — a value at its own rate. The rate is carried by each time
/// value itself; KMI defines no separate frame-rate field (§4.1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RationalTime {
    /// The time value, in units of `rate`.
    pub value: f64,
    /// The rate the value is expressed in (frames or samples per second).
    pub rate: f64,
}

/// An OTIO `TimeRange` — a start and a duration, each a [`RationalTime`] carrying its own
/// rate. This is the canonical form of a clip's in/out.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimeRange {
    /// Where the range starts, in the media's own time.
    pub start_time: RationalTime,
    /// How long it runs.
    pub duration: RationalTime,
}

/// A read-only view of one OTIO `Track` in the timeline's root `Stack`.
#[derive(Debug, Clone, Copy)]
pub struct Track<'a> {
    /// The track's name, if it has one.
    pub name: Option<&'a str>,
    /// OTIO's `Track.kind` — `"Video"` or `"Audio"` within the profile KMI describes.
    /// Multitrack V/A conform needs nothing beyond this: it is a `Stack` of `Track`s,
    /// not a KMI construct (§4.1).
    pub kind: &'a str,
    /// The track's ordered children — `Clip` / `Gap` / `Transition` / nested `Stack`,
    /// each still an OTIO document node.
    pub children: &'a [Value],
}

/// A read-only view of one OTIO `Clip`, anywhere in the composition (nested stacks
/// included).
#[derive(Debug, Clone)]
pub struct Clip<'a> {
    /// The clip's name, if it has one.
    pub name: Option<&'a str>,
    /// The clip's in/out — `Clip.source_range`, at the media's own rate.
    pub source_range: Option<TimeRange>,
    /// The clip's media references. A `Clip.1` has the single `media_reference`; a
    /// `Clip.2` has the `media_references` map — both are read, since version
    /// negotiation is OTIO's mechanism and either may arrive (§4.1).
    pub media_references: Vec<MediaReference<'a>>,
}

/// A read-only view of one OTIO media reference (`ExternalReference`,
/// `MissingReference`, `ImageSequenceReference`, `GeneratorReference`, …).
#[derive(Debug, Clone, Copy)]
pub struct MediaReference<'a> {
    /// The key it hangs off the clip by — `Clip.2`'s `media_references` key, or
    /// [`DEFAULT_MEDIA_KEY`] for a `Clip.1`'s single reference.
    pub key: &'a str,
    /// Its `OTIO_SCHEMA` (e.g. `"ExternalReference.1"`).
    pub schema: &'a str,
    /// Location — **advisory**, and may be stale. Absent on a `MissingReference`.
    pub target_url: Option<&'a str>,
    /// koine's namespaced metadata block (`metadata.koine`), if present — the additive
    /// layer of §4.2a, read but not interpreted here.
    pub koine: Option<&'a Value>,
}

/// OTIO's key for a clip's single/active media reference.
pub const DEFAULT_MEDIA_KEY: &str = "DEFAULT_MEDIA";

/// A canonical timeline: an OTIO document, carried whole.
///
/// The document is held as parsed JSON exactly as it arrived — no field of it is mapped
/// onto a model of ours, so nothing OTIO puts in it is dropped, and OTIO classes this
/// crate has never heard of pass through untouched (§4.1: KMI adds no classes to OTIO's
/// schema). Construction checks the §4.1/§4.4 obligations and nothing more.
#[derive(Debug, Clone, PartialEq)]
pub struct Timeline {
    doc: Value,
}

impl Timeline {
    /// Read an OTIO timeline from its JSON serialization, checking KMI §4.1 conformance.
    ///
    /// This is a *validating carrier*, not a parser of the composition: OTIO's own reader
    /// is what interprets the document (via the Python facade). Use this when a document
    /// is being moved, checked, or read off — not to convert one, which is an adapter's
    /// job.
    pub fn from_otio_json(json: &str) -> Result<Timeline, Error> {
        let doc: Value = serde_json::from_str(json)
            .map_err(|err| Error::Media(format!("timeline is not JSON: {err}")))?;
        Timeline::from_value(doc)
    }

    /// Same, over an already-parsed document.
    pub fn from_value(doc: Value) -> Result<Timeline, Error> {
        validate_timeline(&doc)?;
        Ok(Timeline { doc })
    }

    /// The document, unmodified.
    pub fn as_value(&self) -> &Value {
        &self.doc
    }

    /// Re-emit the document as JSON. Structure-preserving, not byte-preserving: object
    /// key order normalizes, as it does through any JSON map. The byte-canonical form is
    /// OTIO's own writer's output (see the module docs).
    pub fn to_otio_json(&self) -> String {
        serde_json::to_string(&self.doc).expect("a parsed OTIO document re-serializes")
    }

    /// The root's `OTIO_SCHEMA` — e.g. `"Timeline.1"`. Each item declares its own core
    /// schema version; negotiating them is OTIO's mechanism, not KMI's (§4.1).
    pub fn schema_version(&self) -> &str {
        otio_schema(&self.doc).unwrap_or_default()
    }

    /// The timeline's name, if it has one.
    pub fn name(&self) -> Option<&str> {
        self.doc.get("name").and_then(Value::as_str)
    }

    /// The optional record start (timecode origin), whose rate it carries itself.
    pub fn global_start_time(&self) -> Option<RationalTime> {
        rational_time(self.doc.get("global_start_time")?).ok()
    }

    /// koine's namespaced metadata on the `Timeline` itself (`metadata.koine`, §4.2d) —
    /// present only if the producer carried any. Lineage (§3) and analysis (§5) are
    /// **not** here: they are KGP assertions that live outside the timeline.
    pub fn koine_metadata(&self) -> Option<&Value> {
        self.doc.get("metadata")?.get("koine")
    }

    /// The tracks of the root `Stack`, in order.
    pub fn tracks(&self) -> Vec<Track<'_>> {
        stack_children(&self.doc)
            .into_iter()
            .flatten()
            .filter(|child| otio_class(child) == Some("Track"))
            .map(|child| Track {
                name: child.get("name").and_then(Value::as_str),
                kind: child
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                children: children_of(child),
            })
            .collect()
    }

    /// Every `Clip` in the composition, in document order, descending into nested
    /// `Stack`s and `Track`s.
    pub fn clips(&self) -> Vec<Clip<'_>> {
        let mut clips = Vec::new();
        if let Some(children) = stack_children(&self.doc) {
            collect_clips(children, &mut clips);
        }
        clips
    }
}

/// The `children` array of a composition node, or an empty slice.
fn children_of(node: &Value) -> &[Value] {
    node.get("children")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// The children of the timeline's root `Stack` (`tracks`).
fn stack_children(doc: &Value) -> Option<&[Value]> {
    Some(children_of(doc.get("tracks")?))
}

fn collect_clips<'a>(children: &'a [Value], out: &mut Vec<Clip<'a>>) {
    for child in children {
        match otio_class(child) {
            Some("Clip") => out.push(clip_view(child)),
            Some("Track" | "Stack") => collect_clips(children_of(child), out),
            _ => {}
        }
    }
}

fn clip_view(node: &Value) -> Clip<'_> {
    let mut media_references = Vec::new();
    if let Some(reference) = node.get("media_reference") {
        if reference.is_object() {
            media_references.push(media_reference_view(DEFAULT_MEDIA_KEY, reference));
        }
    }
    if let Some(map) = node.get("media_references").and_then(Value::as_object) {
        for (key, reference) in map {
            media_references.push(media_reference_view(key, reference));
        }
    }
    Clip {
        name: node.get("name").and_then(Value::as_str),
        source_range: node.get("source_range").and_then(|r| time_range(r).ok()),
        media_references,
    }
}

fn media_reference_view<'a>(key: &'a str, reference: &'a Value) -> MediaReference<'a> {
    MediaReference {
        key,
        schema: otio_schema(reference).unwrap_or_default(),
        target_url: reference.get("target_url").and_then(Value::as_str),
        koine: reference.get("metadata").and_then(|m| m.get("koine")),
    }
}

/// The `OTIO_SCHEMA` string of a node (`"Clip.2"`), if it declares one.
fn otio_schema(node: &Value) -> Option<&str> {
    node.get("OTIO_SCHEMA").and_then(Value::as_str)
}

/// The class half of a node's `OTIO_SCHEMA` (`"Clip"` of `"Clip.2"`).
pub(crate) fn otio_class(node: &Value) -> Option<&str> {
    otio_schema(node).map(|schema| schema.split('.').next().unwrap_or(schema))
}

fn media_err(msg: impl Into<String>) -> Error {
    Error::Media(msg.into())
}

/// Check the §4.1 obligations, and reject the §4.4 legacy shapes with a pointer to what
/// replaced them. Composition structure itself is OTIO's, unmodified — anything not
/// named here passes through untouched.
fn validate_timeline(doc: &Value) -> Result<(), Error> {
    if !doc.is_object() {
        return Err(media_err("a canonical timeline is an OTIO Timeline object"));
    }
    let schema = otio_schema(doc).ok_or_else(|| {
        media_err("timeline has no OTIO_SCHEMA — a canonical timeline is a valid OTIO JSON document (KMI §4.1)")
    })?;
    if otio_class(doc) != Some("Timeline") {
        return Err(media_err(format!(
            "a canonical timeline's root must be an OTIO Timeline, got {schema:?} (KMI §4.1)"
        )));
    }
    if doc.get("fps").is_some() {
        return Err(media_err(format!(
            "document-level `fps` is the deprecated {LEGACY_EDL_MEDIA_TYPE} shape (KMI §4.4); \
             in OTIO the rate is carried by each RationalTime / TimeRange"
        )));
    }
    let tracks = doc
        .get("tracks")
        .ok_or_else(|| media_err("timeline has no `tracks` Stack (KMI §4.1)"))?;
    if otio_class(tracks) != Some("Stack") {
        return Err(media_err(
            "a timeline's `tracks` must be an OTIO Stack of Tracks (KMI §4.1)",
        ));
    }
    validate_children(children_of(tracks))
}

fn validate_children(children: &[Value]) -> Result<(), Error> {
    for child in children {
        let schema = otio_schema(child).ok_or_else(|| {
            media_err("every composition child declares its own OTIO_SCHEMA (KMI §4.1)")
        })?;
        match otio_class(child) {
            Some("Track") => {
                let kind = child
                    .get("kind")
                    .and_then(Value::as_str)
                    .ok_or_else(|| media_err("an OTIO Track declares a `kind` (KMI §4.1)"))?;
                if kind != "Video" && kind != "Audio" {
                    return Err(media_err(format!(
                        "track kind {kind:?} is outside the profile KMI describes — \
                         Track.kind is \"Video\" or \"Audio\" (KMI §4.1)"
                    )));
                }
                validate_children(children_of(child))?;
            }
            Some("Stack") => validate_children(children_of(child))?,
            Some("Clip") => validate_clip(child, schema)?,
            _ => {}
        }
    }
    Ok(())
}

/// A clip's canonical timing is `source_range` plus its position in the track's ordered
/// children. The legacy per-clip fields of §4.4 map onto that, and are rejected here so a
/// legacy EDL cannot pass itself off as canonical.
fn validate_clip(clip: &Value, schema: &str) -> Result<(), Error> {
    for (legacy, canonical) in [
        ("in_ms", "`source_range.start_time`"),
        ("out_ms", "`source_range.duration`"),
        ("timeline_ms", "the clip's position in the track's children"),
        ("asset", "`media_reference.metadata.koine.asset`"),
    ] {
        if clip.get(legacy).is_some() {
            return Err(media_err(format!(
                "clip field `{legacy}` is the deprecated {LEGACY_EDL_MEDIA_TYPE} shape \
                 (KMI §4.4); its canonical form is {canonical}"
            )));
        }
    }
    if let Some(range) = clip.get("source_range") {
        if !range.is_null() {
            time_range(range)
                .map_err(|err| media_err(format!("{schema} has an invalid source_range: {err}")))?;
        }
    }
    Ok(())
}

/// Read an OTIO `TimeRange`.
fn time_range(value: &Value) -> Result<TimeRange, Error> {
    if otio_class(value) != Some("TimeRange") {
        return Err(media_err("expected an OTIO TimeRange (KMI §4.1)"));
    }
    let start_time = value
        .get("start_time")
        .ok_or_else(|| media_err("TimeRange has no start_time"))?;
    let duration = value
        .get("duration")
        .ok_or_else(|| media_err("TimeRange has no duration"))?;
    Ok(TimeRange {
        start_time: rational_time(start_time)?,
        duration: rational_time(duration)?,
    })
}

/// Read an OTIO `RationalTime`. The rate rides the value; there is no separate frame-rate
/// field to fall back on (§4.1).
fn rational_time(value: &Value) -> Result<RationalTime, Error> {
    if otio_class(value) != Some("RationalTime") {
        return Err(media_err("expected an OTIO RationalTime (KMI §4.1)"));
    }
    let number = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_f64)
            .ok_or_else(|| media_err(format!("RationalTime has no numeric `{key}`")))
    };
    let rate = number("rate")?;
    if rate <= 0.0 {
        return Err(media_err("a RationalTime's rate is positive"));
    }
    Ok(RationalTime {
        value: number("value")?,
        rate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// KMI §4.3's table is OTIO's adapters, named — every one bidirectional, which is
    /// what makes an edit that left the fabric able to come back.
    #[test]
    fn nle_adapter_table_names_otio_plugins_and_is_bidirectional() {
        let names: Vec<&str> = NLE_ADAPTERS.iter().map(|a| a.otio_adapter).collect();
        assert_eq!(names, vec!["cmx_3600", "fcp_xml", "fcpx_xml", "aaf"]);
        assert!(NLE_ADAPTERS.iter().all(|a| a.reads && a.writes));
    }

    #[test]
    fn rejects_a_root_that_is_not_a_timeline() {
        let err = Timeline::from_otio_json(r#"{"OTIO_SCHEMA":"Stack.1","children":[]}"#)
            .unwrap_err()
            .to_string();
        assert!(err.contains("root must be an OTIO Timeline"), "{err}");
    }
}
