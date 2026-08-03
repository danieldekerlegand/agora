//! The media-timeline path — the engine's bridge to OpenTimelineIO (KMI §4).
//!
//! # Why the bridge is here
//!
//! KMI 0.3.0 adopts OTIO as the canonical timeline, so agora must *use* OTIO rather than
//! reimplement it. OTIO is a C++ core with a Python binding: the `opentimelineio` name on
//! crates.io is an explicitly-marked placeholder (`0.1.0`, "Rust bindings for
//! OpenTimelineIO (placeholder)") containing no bindings, so there is nothing for the
//! native core to link. The engine therefore reaches OTIO where a Python interpreter
//! already is — this facade — and the dependency surface is exactly two calls:
//! `opentimelineio.adapters.read_from_string` and `.write_to_string`.
//!
//! So the whole of composition parsing, serialization, and NLE conversion (CMX3600, FCP7
//! `xmeml`, FCPXML, AAF — KMI §4.3) is OTIO's own code, run in-process. agora contributes
//! no timeline model, no EDL writer, and no canonical serialization of its own; the Rust
//! here hands documents across and calls [`translation_core::media::Timeline`] for the
//! §4.1 conformance check on the way past.
//!
//! # The dependency, stated
//!
//! `opentimelineio` is an **optional runtime dependency** of this extension — it is not
//! linked, not vendored, and not needed by any other path through the facade. A caller
//! that never touches the timeline path never needs it installed. The NLE adapters are
//! themselves separate OTIO plugin distributions (`otio-cmx3600-adapter`,
//! `otio-fcp-adapter`, `otio-aaf-adapter`) since OTIO 0.15, so which formats are reachable
//! is a property of the interpreter: ask [`otio_adapters`].

use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use translation_core as core;

/// The install line a caller needs for the timeline path, quoted in every error that
/// fires because OTIO is not there.
const INSTALL_HINT: &str = "pip install opentimelineio otio-cmx3600-adapter otio-fcp-adapter";

/// Import the host interpreter's `opentimelineio`, failing with the install line rather
/// than a bare `ModuleNotFoundError` — the timeline path is the one path through this
/// extension with a runtime dependency, so say so where it bites.
fn import_otio(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    py.import("opentimelineio").map_err(|err| {
        PyRuntimeError::new_err(format!(
            "the media-timeline path needs OpenTimelineIO, which KMI §4 adopts as the \
             canonical timeline ({INSTALL_HINT}): {err}"
        ))
    })
}

/// `opentimelineio.adapters`, the module that owns every read and write on this path.
fn adapters(py: Python<'_>) -> PyResult<Bound<'_, PyAny>> {
    import_otio(py)?.getattr("adapters")
}

/// Check that `adapter` is one this interpreter's OTIO actually has, so an unknown or
/// uninstalled adapter reports *which* are reachable instead of failing deep inside a
/// plugin lookup.
fn check_adapter(adapters: &Bound<'_, PyAny>, adapter: &str) -> PyResult<()> {
    let available: Vec<String> = adapters
        .call_method0("available_adapter_names")?
        .extract()?;
    if available.iter().any(|name| name == adapter) {
        return Ok(());
    }
    let mut available = available;
    available.sort();
    Err(PyValueError::new_err(format!(
        "unknown OTIO adapter {adapter:?}; this interpreter has [{}]. The NLE adapters \
         ship as separate OTIO plugins ({INSTALL_HINT})",
        available.join(", ")
    )))
}

/// Run the KMI §4.1 conformance check over a canonical timeline document.
fn check_conformance(otio_json: &str) -> PyResult<()> {
    core::media::Timeline::from_otio_json(otio_json)
        .map(|_| ())
        .map_err(|err| PyValueError::new_err(err.to_string()))
}

/// The version of OpenTimelineIO backing the timeline path in this interpreter.
#[pyfunction]
pub fn otio_version(py: Python<'_>) -> PyResult<String> {
    import_otio(py)?.getattr("__version__")?.extract()
}

/// The OTIO adapters reachable here, sorted — the live answer to "can this process write
/// a CMX3600 EDL?". Availability is OTIO's business: the NLE adapters are separate plugin
/// distributions, so the list reflects what is installed, not what KMI §4.3 lists.
#[pyfunction]
pub fn otio_adapters(py: Python<'_>) -> PyResult<Vec<String>> {
    let mut names: Vec<String> = adapters(py)?
        .call_method0("available_adapter_names")?
        .extract()?;
    names.sort();
    Ok(names)
}

/// Read an NLE document with **OTIO's** adapter and return the canonical timeline — an
/// OTIO `Timeline` in OTIO's JSON serialization (`application/vnd.opentimelineio+json`,
/// KMI §4).
///
/// `adapter` is an OTIO adapter name: `cmx_3600`, `fcp_xml`, `fcpx_xml`, `aaf`
/// (KMI §4.3), or `otio_json` for the canonical form itself. Because OTIO's adapters are
/// bidirectional, an edit that left the fabric can come back this way — lossily at each
/// format's own edges, which is the format's property, not the engine's.
#[pyfunction]
pub fn timeline_from_adapter(py: Python<'_>, document: &str, adapter: &str) -> PyResult<String> {
    let adapters = adapters(py)?;
    check_adapter(&adapters, adapter)?;
    let timeline = adapters.call_method1("read_from_string", (document, adapter))?;
    let otio_json: String = adapters
        .call_method1("write_to_string", (timeline, core::OTIO_JSON_ADAPTER))?
        .extract()?;
    check_conformance(&otio_json)?;
    Ok(otio_json)
}

/// Write a canonical timeline out through **OTIO's** adapter, returning the adapter's
/// document.
///
/// The input is checked for KMI §4.1 conformance and then handed to OTIO unchanged; the
/// engine writes none of the output itself. Note what §4.3 requires of the caller:
/// adapter output addresses media by path, so anything handed to a consumer that resolves
/// media by path must travel with the asset-id ↔ path media map (or an OTIO bundle), or
/// every clip goes "media offline" on the far side.
#[pyfunction]
pub fn timeline_to_adapter(py: Python<'_>, otio_json: &str, adapter: &str) -> PyResult<String> {
    check_conformance(otio_json)?;
    let adapters = adapters(py)?;
    check_adapter(&adapters, adapter)?;
    let timeline = adapters.call_method1("read_from_string", (otio_json, core::OTIO_JSON_ADAPTER))?;
    adapters
        .call_method1("write_to_string", (timeline, adapter))?
        .extract()
}
