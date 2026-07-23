//! Engine-neutral fact representation for Datalog/Prolog export.
//!
//! A faithful port of culture-scrape's `datalog/__init__.py` render layer. The
//! canonical store is TSV; Datalog is a *derived*, mechanical projection of it.
//! Before targeting any specific engine (SWI-Prolog, Soufflé, ProbLog) we need one
//! in-memory shape for a logical fact that renders validly into either syntax. That
//! shape is [`Fact`]: a `predicate` functor, a tuple of [`Atom`] `args`, and an
//! optional `source` for provenance.
//!
//! Rendering is the delicate part. Prolog and Soufflé Datalog disagree on how a
//! symbolic constant is written:
//!
//! * **Prolog** — a lowercase-initial token (`dish`) is a bare atom; anything else
//!   (a csid like `cs:dish:Q42`, a name like `Ceviche` whose capital would read as a
//!   variable, or a string with spaces/quotes/Unicode) is a single-quoted, escaped
//!   atom: `'cs:dish:Q42'`.
//! * **Soufflé Datalog** — every symbolic constant is a double-quoted string:
//!   `"cs:dish:Q42"`.
//!
//! [`render_atom`] hides that difference; [`render_fact`] assembles a complete,
//! terminated clause for the chosen [`Dialect`].

mod edges;
mod nodes;
mod problog;
mod prolog;
mod souffle;

pub use edges::{edge_facts, predicate_for_type};
pub use nodes::node_facts;
pub use problog::{
    annotate_edge_group, render_annotated_fact, render_problog_program, write_problog_program,
    AnnotatedFact, PROBLOG_PROGRAM_NAME,
};
pub use prolog::{render_program, write_program, PROLOG_PROGRAM_NAME};
pub use souffle::{
    render_souffle_program, souffle_facts, souffle_relations, write_souffle_facts, Relation,
    SOUFFLE_PROGRAM_NAME,
};

use crate::error::Error;
use crate::graph::Graph;
use crate::schema::CanonicalSchema;

/// A term that may appear as a predicate argument. Strings become symbolic
/// constants (atoms / quoted strings); ints and floats become numeric literals.
///
/// Mirrors culture-scrape's `Atom = str | int | float`.
#[derive(Debug, Clone, PartialEq)]
pub enum Atom {
    /// A symbolic constant — a csid, name, type label or code.
    Sym(String),
    /// A signed integer literal (a year; negative = BCE).
    Int(i64),
    /// A float literal (a coordinate, or an edge weight/confidence).
    Float(f64),
}

/// Target syntax for rendering.
///
/// [`Dialect::Prolog`] writes ISO-Prolog clauses (bare or single-quoted atoms, `%`
/// line comments); [`Dialect::Datalog`] writes Soufflé-style clauses (double-quoted
/// string constants, `//` line comments).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Prolog,
    Datalog,
}

/// One logical fact: `predicate(*args)` with optional provenance.
///
/// `source` records where the fact came from (an adapter id or source URL); when
/// present it is emitted as a trailing line comment, keeping the clause's arity
/// stable.
#[derive(Debug, Clone, PartialEq)]
pub struct Fact {
    pub predicate: String,
    pub args: Vec<Atom>,
    pub source: Option<String>,
}

impl Fact {
    /// Build a fact from a predicate, its args, and an optional source.
    pub fn new(predicate: &str, args: Vec<Atom>, source: Option<String>) -> Fact {
        Fact {
            predicate: predicate.to_string(),
            args,
            source,
        }
    }

    /// Render this fact as a terminated clause (see [`render_fact`]).
    pub fn render(&self, dialect: Dialect) -> Result<String, Error> {
        render_fact(self, dialect)
    }
}

/// A token that is a valid *unquoted* Prolog atom / predicate functor — a
/// lowercase-initial identifier `[a-z][a-zA-Z0-9_]*` (the intersection of what
/// Prolog and Soufflé accept as a bare relation name).
fn is_unquoted_atom(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Escape `text` for use inside `quote` delimiters (`'` or `"`).
///
/// Backslash and the C0 controls are escaped, as is the active `quote` character.
/// Printable Unicode is passed through verbatim (both engines read UTF-8 source).
fn escape_quoted(text: &str, quote: char) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch == quote {
            out.push('\\');
            out.push(quote);
        } else {
            match ch {
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\t' => out.push_str("\\t"),
                '\r' => out.push_str("\\r"),
                _ => out.push(ch),
            }
        }
    }
    out
}

/// Render `value` as a float literal valid in both dialects.
///
/// Both engines require a digit on each side of the decimal point and a mantissa
/// with a decimal point in exponent form, so `1e20` is normalised to `1.0e20`.
/// Rust's `f64` `Display` produces the shortest round-trip decimal — the same
/// convention as Python's `repr` for the finite magnitudes the projection emits.
pub(crate) fn render_float(value: f64) -> String {
    let text = format!("{value}");
    match text.split_once('e') {
        Some((mantissa, exponent)) => {
            let mantissa = if mantissa.contains('.') {
                mantissa.to_string()
            } else {
                format!("{mantissa}.0")
            };
            format!("{mantissa}e{exponent}")
        }
        None => {
            if text.contains('.') {
                text
            } else {
                format!("{text}.0")
            }
        }
    }
}

/// Render a single term as a valid atom/literal for `dialect`.
///
/// Strings become symbolic constants — a bare atom when Prolog allows it, otherwise
/// a quoted, escaped form (always double-quoted in Datalog). Ints and floats become
/// numeric literals.
pub fn render_atom(value: &Atom, dialect: Dialect) -> String {
    match value {
        Atom::Int(i) => i.to_string(),
        Atom::Float(f) => render_float(*f),
        Atom::Sym(s) => {
            if dialect == Dialect::Prolog && is_unquoted_atom(s) {
                s.clone()
            } else {
                let quote = if dialect == Dialect::Prolog { '\'' } else { '"' };
                format!("{quote}{}{quote}", escape_quoted(s, quote))
            }
        }
    }
}

/// Validate and return a predicate functor for `dialect`.
///
/// The functor must be a lowercase-initial identifier — the intersection of what
/// Prolog and Soufflé accept as a bare relation name — so it is returned unchanged.
/// Anything else is rejected rather than emitting a clause an engine would reject.
pub fn render_predicate(name: &str) -> Result<String, Error> {
    if !is_unquoted_atom(name) {
        return Err(Error::Datalog(format!(
            "predicate {name:?} is not a valid identifier \
             (expected a lowercase-initial name like 'located_in')"
        )));
    }
    Ok(name.to_string())
}

/// Render `fact` as a complete, `.`-terminated clause for `dialect`.
///
/// The functor is validated by [`render_predicate`] and each argument by
/// [`render_atom`]. A [`Fact::source`], if set, follows as a line comment (`%` for
/// Prolog, `//` for Datalog) with internal whitespace collapsed so it stays on one
/// line.
pub fn render_fact(fact: &Fact, dialect: Dialect) -> Result<String, Error> {
    if fact.args.is_empty() {
        return Err(Error::Datalog(format!(
            "fact {:?} has no arguments",
            fact.predicate
        )));
    }
    let functor = render_predicate(&fact.predicate)?;
    let rendered_args: Vec<String> = fact
        .args
        .iter()
        .map(|arg| render_atom(arg, dialect))
        .collect();
    let mut clause = format!("{functor}({}).", rendered_args.join(", "));
    if let Some(source) = &fact.source {
        let marker = if dialect == Dialect::Prolog { "%" } else { "//" };
        let comment = source.split_whitespace().collect::<Vec<_>>().join(" ");
        clause = format!("{clause}  {marker} source: {comment}");
    }
    Ok(clause)
}

/// Project a whole graph's node rows into facts, in canonical csid order.
///
/// Mirrors culture-scrape's `collect_facts` node pass over a single sorted
/// `nodes.tsv`: the rows are visited in the same order the TSV writer emits, so the
/// fact stream is byte-order-stable.
pub fn node_facts_for_graph(schema: &CanonicalSchema, graph: &Graph) -> Result<Vec<Fact>, Error> {
    let id_key = schema.node_id_key()?;
    let ordered = crate::tsv::sorted_by(&graph.nodes, &[id_key])?;
    let mut facts = Vec::new();
    for row in ordered {
        facts.extend(node_facts(schema, row)?);
    }
    Ok(facts)
}

/// Project a whole graph's edge rows into facts, in canonical
/// `(:START_ID, :END_ID, :TYPE)` order.
pub fn edge_facts_for_graph(graph: &Graph) -> Result<Vec<Fact>, Error> {
    let ordered = crate::tsv::sorted_by(&graph.edges, &[":START_ID", ":END_ID", ":TYPE"])?;
    let mut facts = Vec::new();
    for row in ordered {
        facts.extend(edge_facts(row)?);
    }
    Ok(facts)
}

/// The full fact stream for a graph: node facts first (entity-defining), then edge
/// facts — the order `export_dataset` projects a single-file dataset in.
pub fn facts_for_graph(schema: &CanonicalSchema, graph: &Graph) -> Result<Vec<Fact>, Error> {
    let mut facts = node_facts_for_graph(schema, graph)?;
    facts.extend(edge_facts_for_graph(graph)?);
    Ok(facts)
}

/// Project a graph into ProbLog annotated facts: certain node facts first, then each
/// edge row's facts with its confidence lifted onto the edge relation
/// ([`annotate_edge_group`]). Mirrors culture-scrape's `collect_problog_facts`.
pub fn problog_facts_for_graph(
    schema: &CanonicalSchema,
    graph: &Graph,
) -> Result<Vec<AnnotatedFact>, Error> {
    let mut out: Vec<AnnotatedFact> = node_facts_for_graph(schema, graph)?
        .into_iter()
        .map(AnnotatedFact::certain)
        .collect();
    let ordered = crate::tsv::sorted_by(&graph.edges, &[":START_ID", ":END_ID", ":TYPE"])?;
    for row in ordered {
        out.extend(annotate_edge_group(edge_facts(row)?));
    }
    Ok(out)
}
