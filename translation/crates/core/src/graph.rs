//! The canonical in-memory graph — node and edge records over the koine schema.
//!
//! A record ([`Row`]) is a map from a column key (`csid`, `:LABEL`, `name`, ...)
//! to a [`Cell`]. This mirrors culture-scrape's `Row = dict[str, str | list[str]]`:
//! scalar columns hold a string, the multi-value columns (`:LABEL`, `aliases`)
//! hold a list. A key absent from the record writes an empty cell, so the record
//! is sparse the way the Python dict is. The [`CanonicalSchema`](crate::CanonicalSchema)
//! supplies the column order, the typed `:int`/`:float` suffixes, and the node/edge
//! type vocabularies, so records stay schema-driven rather than a fixed struct.

use crate::error::Error;
use serde::Deserialize;
use std::collections::BTreeMap;

/// One field value: a scalar string, or the parts of a multi-value column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cell {
    /// A scalar column's value (`csid`, `name`, `confidence`, ...).
    Scalar(String),
    /// A multi-value column's parts (`:LABEL`, `aliases`), joined on `;` on write.
    Multi(Vec<String>),
}

impl Cell {
    /// Borrow the scalar string, or error if this is a multi-value cell.
    pub fn as_scalar(&self, key: &str) -> Result<&str, Error> {
        match self {
            Cell::Scalar(s) => Ok(s),
            Cell::Multi(_) => Err(Error::Tsv(format!(
                "scalar column {key:?} expects a string, got a list"
            ))),
        }
    }

    /// Borrow the multi-value parts, or error if this is a scalar cell.
    pub fn as_multi(&self, key: &str) -> Result<&[String], Error> {
        match self {
            Cell::Multi(v) => Ok(v),
            Cell::Scalar(_) => Err(Error::Tsv(format!(
                "multi-value column {key:?} expects a sequence, got a string"
            ))),
        }
    }
}

/// A decoded node or edge record, keyed by column key. Deterministic iteration
/// order (a `BTreeMap`) keeps equality and debugging stable; write order is always
/// driven by the schema's column order, never the map's.
pub type Row = BTreeMap<String, Cell>;

/// A canonical graph: node records and edge records.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Graph {
    pub nodes: Vec<Row>,
    pub edges: Vec<Row>,
}

// --- fixture / JSON interchange ---
//
// A graph is passed across the WASM (US-4) and HTTP (US-6) seams as JSON: an object
// with `nodes` and `edges` arrays, each element an object mapping a column key to a
// string (scalar) or an array of strings (multi-value). The same shape backs the
// committed test fixtures.

#[derive(Deserialize)]
struct RawGraph {
    #[serde(default)]
    nodes: Vec<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    edges: Vec<serde_json::Map<String, serde_json::Value>>,
}

fn row_from_json(obj: &serde_json::Map<String, serde_json::Value>) -> Result<Row, Error> {
    let mut row = Row::new();
    for (key, value) in obj {
        let cell = match value {
            serde_json::Value::String(s) => Cell::Scalar(s.clone()),
            serde_json::Value::Array(items) => {
                let parts = items
                    .iter()
                    .map(|item| match item {
                        serde_json::Value::String(s) => Ok(s.clone()),
                        other => Err(Error::Tsv(format!(
                            "multi-value column {key:?} part must be a string, got {other}"
                        ))),
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Cell::Multi(parts)
            }
            other => {
                return Err(Error::Tsv(format!(
                    "column {key:?} must be a string or list of strings, got {other}"
                )))
            }
        };
        row.insert(key.clone(), cell);
    }
    Ok(row)
}

impl Graph {
    /// Load a graph from its JSON interchange form.
    pub fn from_json(text: &str) -> Result<Graph, Error> {
        let raw: RawGraph =
            serde_json::from_str(text).map_err(|e| Error::Tsv(format!("bad graph JSON: {e}")))?;
        Ok(Graph {
            nodes: raw
                .nodes
                .iter()
                .map(row_from_json)
                .collect::<Result<Vec<_>, _>>()?,
            edges: raw
                .edges
                .iter()
                .map(row_from_json)
                .collect::<Result<Vec<_>, _>>()?,
        })
    }
}
