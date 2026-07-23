//! Project canonical node rows into engine-neutral [`Fact`] objects.
//!
//! A faithful port of culture-scrape's `datalog/nodes.py`. Each node row becomes:
//!
//! * `node(Csid, Type, Name)` — one per row; `Type` is the primary `:LABEL`.
//! * `instance_of(Csid, Label)` — one per `:LABEL` value, so a multi-label node
//!   keeps every type rather than only the primary one.
//! * `source(Csid, Source)` — a *queryable* provenance fact, only when the row
//!   carries a non-blank source (no null reaches the logic program).
//! * `located_at(Csid, Lat, Lon)` — when both `lat` and `lon` are populated.
//! * one dimension fact per populated dimension column — `time_start(Csid, Year)`,
//!   `language_code(Csid, Code)`, … An empty cell emits nothing.
//!
//! A csid is carried *verbatim* as the first argument of every fact; [`render_atom`]
//! then quotes it deterministically, so the mapping is reversible.

use crate::datalog::{Atom, Fact};
use crate::error::Error;
use crate::graph::{Cell, Row};
use crate::schema::{CanonicalSchema, Column, PropertyType};

/// Scalar dimension columns and the binary predicate each projects to, in the exact
/// order culture-scrape's `_DIMENSION_PREDICATES` dict declares (so the emitted fact
/// order is byte-stable). `lat`/`lon` are absent — they are emitted jointly as
/// `located_at/3`.
const DIMENSION_PREDICATES: &[(&str, &str)] = &[
    ("time_start", "time_start"),
    ("time_end", "time_end"),
    ("period", "part_of_period"),
    ("place_qid", "place_qid"),
    ("tgn_id", "tgn_id"),
    ("pleiades_id", "pleiades_id"),
    ("language_code", "language_code"),
    ("script", "script"),
    ("etymology", "etymology"),
    ("derived_from_csid", "derived_from"),
];

/// The scalar value at `key` (`""` if absent), rejecting list columns.
fn scalar(row: &Row, key: &str) -> Result<String, Error> {
    match row.get(key) {
        Some(cell) => Ok(cell.as_scalar(key)?.to_string()),
        None => Ok(String::new()),
    }
}

/// The `:LABEL` values (empty if absent), rejecting a scalar where a list is wanted.
fn labels(row: &Row) -> Result<Vec<String>, Error> {
    match row.get(":LABEL") {
        Some(Cell::Multi(v)) => Ok(v.clone()),
        Some(Cell::Scalar(_)) => Err(Error::Datalog("column ':LABEL' must be multi-valued".into())),
        None => Ok(Vec::new()),
    }
}

/// Coerce a raw cell to the numeric term its column type implies.
fn coerce(value: &str, ptype: PropertyType) -> Result<Atom, Error> {
    match ptype {
        PropertyType::Int => value
            .parse::<i64>()
            .map(Atom::Int)
            .map_err(|e| Error::Datalog(format!("bad int {value:?}: {e}"))),
        PropertyType::Float => value
            .parse::<f64>()
            .map(Atom::Float)
            .map_err(|e| Error::Datalog(format!("bad float {value:?}: {e}"))),
        PropertyType::String => Ok(Atom::Sym(value.to_string())),
    }
}

/// The declared type of a property column, defaulting to string (its dict value in
/// culture-scrape's `types` map, which every dimension column is present in).
fn column_type(schema: &CanonicalSchema, name: &str) -> PropertyType {
    schema
        .node_columns
        .iter()
        .find_map(|c| match c {
            Column::Property { name: n, ptype } if n == name => Some(*ptype),
            _ => None,
        })
        .unwrap_or(PropertyType::String)
}

/// Project one node `row` (read under `schema`) into its facts.
///
/// Emits `node/3` and an `instance_of/2` per label, the queryable `source/2` when a
/// source is present, `located_at/3` when coordinates are populated, then one fact
/// per populated dimension column. Empty cells are skipped, so no null ever reaches
/// the logic program. Every fact carries the row's `source` as provenance.
pub fn node_facts(schema: &CanonicalSchema, row: &Row) -> Result<Vec<Fact>, Error> {
    let id_key = schema.node_id_key()?;
    let csid = scalar(row, id_key)?;
    let labels = labels(row)?;
    if labels.is_empty() {
        return Err(Error::Datalog(format!(
            "node {csid:?} has no :LABEL, cannot type it"
        )));
    }
    let name = scalar(row, "name")?;
    let source_raw = scalar(row, "source")?;
    let source = if source_raw.is_empty() {
        None
    } else {
        Some(source_raw)
    };

    let mut facts = vec![Fact::new(
        "node",
        vec![
            Atom::Sym(csid.clone()),
            Atom::Sym(labels[0].clone()),
            Atom::Sym(name),
        ],
        source.clone(),
    )];
    for label in &labels {
        facts.push(Fact::new(
            "instance_of",
            vec![Atom::Sym(csid.clone()), Atom::Sym(label.clone())],
            source.clone(),
        ));
    }
    if let Some(src) = &source {
        facts.push(Fact::new(
            "source",
            vec![Atom::Sym(csid.clone()), Atom::Sym(src.clone())],
            source.clone(),
        ));
    }

    let lat = scalar(row, "lat")?;
    let lon = scalar(row, "lon")?;
    if !lat.is_empty() && !lon.is_empty() {
        let lat = lat
            .parse::<f64>()
            .map_err(|e| Error::Datalog(format!("bad lat {lat:?}: {e}")))?;
        let lon = lon
            .parse::<f64>()
            .map_err(|e| Error::Datalog(format!("bad lon {lon:?}: {e}")))?;
        facts.push(Fact::new(
            "located_at",
            vec![Atom::Sym(csid.clone()), Atom::Float(lat), Atom::Float(lon)],
            source.clone(),
        ));
    }

    for (col, predicate) in DIMENSION_PREDICATES {
        let value = scalar(row, col)?;
        if value.is_empty() {
            continue; // null/empty column emits no fact
        }
        let atom = coerce(&value, column_type(schema, col))?;
        facts.push(Fact::new(
            predicate,
            vec![Atom::Sym(csid.clone()), atom],
            source.clone(),
        ));
    }

    Ok(facts)
}
