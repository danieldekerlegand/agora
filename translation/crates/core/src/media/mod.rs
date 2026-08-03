//! The media-timeline path — OpenTimelineIO (OTIO), adopted rather than reinvented.
//!
//! KMI 0.3.0 §4 (koine `ADR-0005`) makes an **OTIO `Timeline`, in OTIO's own JSON
//! serialization**, the canonical composition model. So this module deliberately does
//! *not* define a timeline model: there is no struct here for a track, a cut, or an EDL
//! row, and no bespoke canonical-timeline serialization to keep in step with OTIO's.
//!
//! The module is split the way KMI §4 splits the work itself:
//!
//! | Submodule | Whose model | What it holds |
//! |---|---|---|
//! | [`otio`] | **OTIO's** | the KMI media-plane constants, the §4.3 table naming OTIO's own adapters, and a read-only projection over an OTIO document that checks §4.1 conformance |
//! | [`koine`] | **koine's** | the additive layer of §4.2 — the things OTIO has no model for: identity ([`AssetId`]), lineage ([`LineageGraph`]), and the analysis → knowledge bridge ([`Assertion`]) |
//!
//! That boundary is the point of the adoption. OTIO owns composition — tracks, clips,
//! timing, transitions, effects, nesting — and koine adds only what OTIO deliberately
//! leaves open. Nothing in [`koine`] re-specifies a byte of OTIO's model, and nothing in
//! [`otio`] interprets koine's namespaced metadata beyond handing it back.
//!
//! # How the engine reaches OTIO
//!
//! OTIO is a C++ core with a Python binding. The `opentimelineio` name on crates.io is an
//! explicitly-marked *placeholder* (`0.1.0`, "Rust bindings for OpenTimelineIO
//! (placeholder)") with no bindings in it, so there is no Rust library to link and no
//! honest way for this crate to run OTIO in-process. The engine therefore reaches OTIO —
//! its reader, its writer, and every adapter in [`NLE_ADAPTERS`] — through the engine's
//! **Python facade**, `crates/py`: `translation_py.timeline_from_adapter` /
//! `timeline_to_adapter` drive `opentimelineio.adapters` in the host interpreter, and the
//! Rust in that facade only hands documents across and calls back here for the §4.1
//! check. Every byte of composition parsing and every NLE conversion is OTIO's own code.
//!
//! Consequences worth stating plainly, because they are the point of adopting OTIO:
//!
//! - **This crate never parses or writes an EDL.** `timeline → CMX3600` is
//!   `opentimelineio.adapters`' `cmx_3600`, not a translator of ours.
//! - **The canonical bytes are OTIO's writer's.** [`Timeline::to_otio_json`] re-emits the
//!   same document through `serde_json` for callers that only moved it around; it
//!   normalizes object key order (as any JSON map does) and so is structure-preserving,
//!   not byte-preserving. The byte-canonical form a timeline asset is content-addressed
//!   over (§4/§2) is what OTIO's own serializer produced.
//! - **The WASM facade has no media-timeline path.** There is no OTIO in a wasm sandbox;
//!   a TypeScript consumer reaches the timeline path over the fabric, not in-process.
//!
//! The additive layer is the exception to that last row: [`koine`] is pure native Rust
//! over the parsed document — reading an asset id, relinking one, walking lineage, and
//! bridging analysis to KGP need no adapter and therefore no interpreter. Only conversion
//! is OTIO-bound.

pub mod koine;
pub mod otio;

pub use koine::{
    analysis_assertions, assertion_facts, AnalysisObservation, Assertion, AssetEnvelope, AssetId,
    AssetReference, LineageGraph, LineageLink, LineageRelation, MediaMap,
    ANALYSIS_BRIDGE_INPUT_PLANE, ANALYSIS_BRIDGE_OUTPUT_PLANE, ASSET_KIND, KOINE_METADATA_KEY,
    LINEAGE_DOMAIN,
};
pub use otio::{
    Clip, MediaReference, NleAdapter, RationalTime, TimeRange, Timeline, Track, DEFAULT_MEDIA_KEY,
    KMI_VERSION, LEGACY_EDL_MEDIA_TYPE, NLE_ADAPTERS, OTIO_BUNDLE_MEDIA_TYPE, OTIO_JSON_ADAPTER,
    OTIO_MEDIA_TYPE,
};
