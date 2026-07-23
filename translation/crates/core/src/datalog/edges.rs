//! Project canonical edge rows into engine-neutral [`Fact`] objects.
//!
//! A faithful port of culture-scrape's `datalog/edges.py`. An edge of `:TYPE` `T`
//! from `A` to `B` yields two interchangeable views plus optional companions:
//!
//! * `rel(t, A, B)` — the **generic** view, relation type carried as data;
//! * `t(A, B)` — the **typed** view, one binary predicate per `:TYPE` (`t` is
//!   [`predicate_for_type`], e.g. `located_in` / `derived_from`);
//! * `rel_conf(t, A, B, W)` — an optional **confidence** companion, emitted only
//!   when a strength is populated (canonical `confidence`, else a populated legacy
//!   `weight`);
//! * `rel_source(t, A, B, Source)` — an optional **provenance** companion, emitted
//!   only when the row carries a source.

use crate::datalog::{Atom, Fact};
use crate::error::Error;
use crate::graph::{Cell, Row};

/// The scalar value at `key` (`""` if absent), rejecting list columns.
fn scalar(row: &Row, key: &str) -> Result<String, Error> {
    match row.get(key) {
        Some(Cell::Scalar(s)) => Ok(s.clone()),
        Some(Cell::Multi(_)) => Err(Error::Datalog(format!(
            "column {key:?} is multi-valued, expected a scalar"
        ))),
        None => Ok(String::new()),
    }
}

/// A well-formed edge `:TYPE`: SCREAMING_SNAKE_CASE (`[A-Z][A-Z0-9_]*`).
fn is_screaming_snake(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// Derive a collision-free Datalog predicate functor from an edge `:TYPE`.
///
/// The scheme is a plain lowercasing, *constrained to be collision-free*: a `:TYPE`
/// must be SCREAMING_SNAKE_CASE, over which `to_lowercase` is a bijection onto valid
/// predicate functors. A `:TYPE` outside the domain is rejected rather than silently
/// colliding, keeping the mapping reversible.
pub fn predicate_for_type(rel_type: &str) -> Result<String, Error> {
    if !is_screaming_snake(rel_type) {
        return Err(Error::Datalog(format!(
            "edge :TYPE {rel_type:?} is not SCREAMING_SNAKE_CASE \
             (expected an uppercase-initial name like 'LOCATED_IN')"
        )));
    }
    Ok(rel_type.to_lowercase())
}

/// Project one decoded edge `row` into its facts.
///
/// Emits the generic `rel/3` and the typed `<type>/2`, plus `rel_conf/4` carrying
/// the edge's strength (canonical `confidence`, falling back to a populated legacy
/// `weight`), and — when a source is present — the queryable `rel_source/4`. A blank
/// cell emits no companion, so no null reaches the logic program.
pub fn edge_facts(row: &Row) -> Result<Vec<Fact>, Error> {
    let start = scalar(row, ":START_ID")?;
    let end = scalar(row, ":END_ID")?;
    let rel_type = scalar(row, ":TYPE")?;
    if start.is_empty() || end.is_empty() {
        return Err(Error::Datalog(
            "edge requires both a :START_ID and a :END_ID".into(),
        ));
    }
    if rel_type.is_empty() {
        return Err(Error::Datalog("edge requires a :TYPE".into()));
    }

    let predicate = predicate_for_type(&rel_type)?;
    let source_raw = scalar(row, "source")?;
    let source = if source_raw.is_empty() {
        None
    } else {
        Some(source_raw)
    };

    let mut facts = vec![
        Fact::new(
            "rel",
            vec![
                Atom::Sym(predicate.clone()),
                Atom::Sym(start.clone()),
                Atom::Sym(end.clone()),
            ],
            source.clone(),
        ),
        Fact::new(
            &predicate,
            vec![Atom::Sym(start.clone()), Atom::Sym(end.clone())],
            source.clone(),
        ),
    ];

    // Prefer the canonical confidence; fall back to a populated legacy weight.
    let confidence = scalar(row, "confidence")?;
    let strength = if confidence.is_empty() {
        scalar(row, "weight")?
    } else {
        confidence
    };
    if !strength.is_empty() {
        let weight = strength
            .parse::<f64>()
            .map_err(|e| Error::Datalog(format!("bad strength {strength:?}: {e}")))?;
        facts.push(Fact::new(
            "rel_conf",
            vec![
                Atom::Sym(predicate.clone()),
                Atom::Sym(start.clone()),
                Atom::Sym(end.clone()),
                Atom::Float(weight),
            ],
            source.clone(),
        ));
    }

    if let Some(src) = &source {
        facts.push(Fact::new(
            "rel_source",
            vec![
                Atom::Sym(predicate.clone()),
                Atom::Sym(start.clone()),
                Atom::Sym(end.clone()),
                Atom::Sym(src.clone()),
            ],
            source.clone(),
        ));
    }

    Ok(facts)
}
