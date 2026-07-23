//! The napi-rs N-API addon: the in-process boundary the TS shim (`registry/src/path-index.ts`)
//! loads. Compiled only under the `binding` feature (`npm run build:native`), so the default gate
//! stays a pure Rust build.
//!
//! The boundary is JSON in, JSON out — never a payload or a transport. `registrations_json` is the
//! registry's own `Registration[]` and `query_json` a `PathQuery`; the return is the serialized
//! `CapabilityPath` or `null`. Nothing here dials anything (ADR-0001 decision 3).

use napi_derive::napi;

use crate::{search, PathQuery, Registration};

/// Search for the best capability path. Returns the serialized `CapabilityPath` JSON, or `None`
/// (JS `null`/`undefined`) when the index has no path.
#[napi]
pub fn search_path(registrations_json: String, query_json: String) -> napi::Result<Option<String>> {
    let registrations: Vec<Registration> = serde_json::from_str(&registrations_json)
        .map_err(|e| napi::Error::from_reason(format!("registrations: {e}")))?;
    let query: PathQuery = serde_json::from_str(&query_json)
        .map_err(|e| napi::Error::from_reason(format!("query: {e}")))?;
    match search(&registrations, &query) {
        Some(path) => Ok(Some(
            serde_json::to_string(&path)
                .map_err(|e| napi::Error::from_reason(format!("result: {e}")))?,
        )),
        None => Ok(None),
    }
}
