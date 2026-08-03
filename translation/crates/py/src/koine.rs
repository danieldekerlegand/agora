//! koine's additive layer over OTIO, at the facade (KMI §4.2).
//!
//! Unlike its sibling [`crate::otio`], **nothing here needs OpenTimelineIO**: reading an
//! asset id off a document, seeing which references lost theirs, and relinking them from
//! the §4.3 media map are pure [`translation_core`] over parsed JSON. They live in the
//! Python facade anyway, because this is where the OTIO adapters run — and an adapter is
//! exactly what drops the ids. A caller that writes an EDL here reads it back here, and
//! needs the repair in the same breath:
//!
//! ```python
//! edl  = translation_py.timeline_to_adapter(canonical, "cmx_3600")   # OTIO writes; ids do not survive
//! back = translation_py.timeline_from_adapter(edl, "cmx_3600")       # OTIO reads
//! back = translation_py.timeline_relink(back, media_map)             # koine's ids come home
//! ```
//!
//! The other two thirds of the additive layer — the asset-lineage graph (§4.2b) and the
//! analysis → knowledge bridge (§4.2c/§5) — are deliberately *not* here, because they are
//! not in the timeline at all. They are KGP assertions over assets, which is why no
//! adapter can damage them and why the facade has nothing to repair. They live in
//! `translation_core::media::koine`.

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyDict;
use std::collections::BTreeMap;
use translation_core as core;
use translation_core::media::{AssetId, MediaMap, Timeline};

/// Map a core error to a Python `ValueError` carrying its display message.
fn to_py<E: std::fmt::Display>(err: E) -> PyErr {
    PyValueError::new_err(err.to_string())
}

/// Read a canonical timeline, checking KMI §4.1 on the way in.
fn timeline(otio_json: &str) -> PyResult<Timeline> {
    Timeline::from_otio_json(otio_json).map_err(to_py)
}

/// Build a [`MediaMap`] from a Python `{asset id: path}` dict, validating every id.
fn media_map(entries: BTreeMap<String, String>) -> PyResult<MediaMap> {
    entries
        .into_iter()
        .map(|(curie, path)| AssetId::parse(&curie).map(|id| (id, path)).map_err(to_py))
        .collect::<PyResult<MediaMap>>()
}

/// The distinct KINP asset ids a timeline's clips reference (KMI §4.2a), sorted.
///
/// These are content-addressed ids — the hash of the bytes — so they are stable across
/// every hop that preserves them, and a malformed one is an error rather than a silent
/// omission.
#[pyfunction]
pub fn timeline_assets(otio_json: &str) -> PyResult<Vec<String>> {
    Ok(timeline(otio_json)
        .and_then(|timeline| timeline.asset_ids().map_err(to_py))?
        .iter()
        .map(|id| id.as_str().to_string())
        .collect())
}

/// The media references that carry **no** asset id — the §9.5 exposure, made visible.
///
/// Each entry is `{"clip", "key", "schema", "target_url"}`. A non-empty list after a trip
/// through a third-party tool is the signal to [`timeline_relink`]; an empty one after the
/// repair is the proof the identity came home.
#[pyfunction]
pub fn timeline_unidentified(py: Python<'_>, otio_json: &str) -> PyResult<Vec<Py<PyDict>>> {
    let timeline = timeline(otio_json)?;
    let mut out = Vec::new();
    for reference in timeline.unidentified_references().map_err(to_py)? {
        let entry = PyDict::new(py);
        entry.set_item("clip", reference.clip)?;
        entry.set_item("key", reference.key)?;
        entry.set_item("schema", reference.schema)?;
        entry.set_item("target_url", reference.target_url)?;
        out.push(entry.unbind());
    }
    Ok(out)
}

/// The asset-id ↔ path media map a timeline carries at `metadata.koine.media_map`
/// (§4.2d), or `None` when it carries none — which is what a path-addressing round trip
/// leaves behind, and why §4.3 lets the map travel beside the document instead.
#[pyfunction]
pub fn timeline_media_map(otio_json: &str) -> PyResult<Option<BTreeMap<String, String>>> {
    Ok(timeline(otio_json)
        .and_then(|timeline| timeline.media_map().map_err(to_py))?
        .map(|map| {
            map.iter()
                .map(|(id, path)| (id.as_str().to_string(), path.to_string()))
                .collect()
        }))
}

/// Re-attach the asset ids an NLE round trip dropped, from the §4.3 media map, and return
/// the repaired canonical timeline.
///
/// The repair is bounded on purpose (see `translation_core::media::koine`): an id already
/// present outranks the map, a location the map does not name stays unidentified rather
/// than guessed, and the composition is untouched — only `metadata.koine` is written. So
/// `timeline_relink` restores identity and never mints it.
#[pyfunction]
pub fn timeline_relink(
    otio_json: &str,
    media_map_entries: BTreeMap<String, String>,
) -> PyResult<String> {
    let map = media_map(media_map_entries)?;
    let relinked = timeline(otio_json)?.relink(&map).map_err(to_py)?;
    Ok(relinked.to_otio_json())
}

/// The KMI version this path implements and the media types of a canonical timeline —
/// what a caller needs to name the plane it is on when it declares a port (§2/§4/§6).
#[pyfunction]
pub fn kmi_media_plane(py: Python<'_>) -> PyResult<Py<PyDict>> {
    let out = PyDict::new(py);
    out.set_item("kmi_version", core::KMI_VERSION)?;
    out.set_item("timeline_media_type", core::OTIO_MEDIA_TYPE)?;
    out.set_item("bundle_media_type", core::OTIO_BUNDLE_MEDIA_TYPE)?;
    Ok(out.unbind())
}
