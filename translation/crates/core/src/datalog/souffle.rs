//! Emit a runnable Soufflé Datalog program (`graph.dl` + `.facts`) from facts.
//!
//! A faithful port of culture-scrape's `datalog/souffle.py` for the base (rule-less)
//! export. Soufflé splits a program into two artefacts:
//!
//! * a **`.dl` source file** — declarations and I/O directives only. For every
//!   predicate that appears it emits a `.decl` with typed attributes, a `.input`
//!   directive and a `.output` directive;
//! * one **`<predicate>.facts` file** per relation — the rows themselves, in
//!   Soufflé's native tab-separated format, written through the strict TSV encoder so
//!   a field containing a tab, newline or backslash cannot corrupt the file.
//!
//! Soufflé is strongly typed: every attribute is a `symbol` (string), `number`
//! (signed int) or `float`. Each attribute's type is inferred from the values that
//! occur at that position, widening on conflict (`number` ⊑ `float` ⊑ `symbol`).
//! Soufflé relations are keyed by name (not name/arity), so a predicate appearing
//! with two arities is a hard error.

use std::collections::BTreeMap;
use std::io::Write;

use crate::datalog::{render_predicate, Atom, Fact};
use crate::error::Error;
use crate::schema::DELIMITER;
use crate::tsv::encode_value;

/// Filename of the generated Soufflé program inside the output directory.
pub const SOUFFLE_PROGRAM_NAME: &str = "graph.dl";

/// The `//`-comment header documenting the emitted program. Static so the file is
/// self-describing. Ends *without* a trailing newline, matching the reference.
const HEADER: &str = "\
// culture-scrape — Soufflé Datalog program
// =========================================
// Auto-generated from the canonical TSV graph (docs/data-model.md); a derived,
// mechanical projection — do not edit by hand.
//
// Layout
// ------
//   This .dl declares each predicate (.decl) and marks it .input (rows are
//   loaded from <predicate>.facts at start-up) and .output (running the program
//   materialises it). The rows live in the sibling <predicate>.facts files,
//   tab-separated in Soufflé's native format.
//
// Attribute types
// ---------------
//   symbol  — a string constant (csids like cs:dish:Q42, names, type labels)
//   number  — a signed integer (e.g. a year; negative = BCE)
//   float   — a coordinate or edge weight/confidence
//
// Run:  souffle graph.dl -F <dir-holding-the-.facts> -D <output-dir>";

/// A Soufflé primitive attribute type, ranked most specific to most general for the
/// type-join: a position mixing ints and floats widens to `float`; mixing in any
/// string widens to `symbol`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SouffleType {
    Number,
    Float,
    Symbol,
}

impl SouffleType {
    fn rank(self) -> u8 {
        match self {
            SouffleType::Number => 0,
            SouffleType::Float => 1,
            SouffleType::Symbol => 2,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            SouffleType::Number => "number",
            SouffleType::Float => "float",
            SouffleType::Symbol => "symbol",
        }
    }

    /// The Soufflé attribute type a single `value` implies.
    fn of(value: &Atom) -> SouffleType {
        match value {
            Atom::Int(_) => SouffleType::Number,
            Atom::Float(_) => SouffleType::Float,
            Atom::Sym(_) => SouffleType::Symbol,
        }
    }
}

/// The narrowest Soufflé type admitting values of both `left` and `right`.
fn join(left: SouffleType, right: SouffleType) -> SouffleType {
    if left.rank() >= right.rank() {
        left
    } else {
        right
    }
}

/// A Soufflé relation: a predicate functor and its per-position types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relation {
    pub predicate: String,
    types: Vec<SouffleType>,
}

impl Relation {
    /// The `.decl` line for this relation (attributes named `x0..xN`).
    pub fn declaration(&self) -> String {
        let attrs: Vec<String> = self
            .types
            .iter()
            .enumerate()
            .map(|(i, t)| format!("x{i}: {}", t.as_str()))
            .collect();
        format!(".decl {}({})", self.predicate, attrs.join(", "))
    }
}

/// Derive the typed relations present in `facts`, sorted by predicate.
///
/// Each argument position's type is inferred from the values that occur there and
/// widened on conflict ([`join`]). A predicate appearing with two different arities
/// is rejected, since Soufflé keys relations by name alone.
pub fn souffle_relations(facts: &[Fact]) -> Result<Vec<Relation>, Error> {
    let mut by_name: BTreeMap<String, Vec<SouffleType>> = BTreeMap::new();
    for fact in facts {
        if fact.args.is_empty() {
            return Err(Error::Datalog(format!(
                "fact {:?} has no arguments",
                fact.predicate
            )));
        }
        render_predicate(&fact.predicate)?; // validate the functor
        let types: Vec<SouffleType> = fact.args.iter().map(SouffleType::of).collect();
        match by_name.get_mut(&fact.predicate) {
            None => {
                by_name.insert(fact.predicate.clone(), types);
            }
            Some(existing) if existing.len() != types.len() => {
                return Err(Error::Datalog(format!(
                    "predicate {:?} appears with arity {} and {}; Soufflé relations \
                     are keyed by name, so a single arity is required",
                    fact.predicate,
                    existing.len(),
                    types.len()
                )));
            }
            Some(existing) => {
                for (slot, incoming) in existing.iter_mut().zip(types) {
                    *slot = join(*slot, incoming);
                }
            }
        }
    }
    Ok(by_name
        .into_iter()
        .map(|(predicate, types)| Relation { predicate, types })
        .collect())
}

/// Render the `.dl` declarations and I/O directives for `facts`.
///
/// The text is the schema header, then one `.decl`/`.input`/`.output` block per fact
/// relation (sorted by predicate). The facts themselves are *not* inlined — they
/// belong in the sibling `.facts` files. The result ends with a trailing newline.
pub fn render_souffle_program(facts: &[Fact]) -> Result<String, Error> {
    let relations = souffle_relations(facts)?;
    let mut lines: Vec<String> = vec![HEADER.to_string(), String::new()];
    for relation in &relations {
        lines.push(relation.declaration());
        lines.push(format!(".input {}", relation.predicate));
        lines.push(format!(".output {}", relation.predicate));
        lines.push(String::new());
    }
    Ok(format!("{}\n", lines.join("\n").trim_end_matches('\n')))
}

/// Render one `value` for a `.facts` cell under its resolved `col_type`.
///
/// Rendering follows the relation's resolved column type, not the value's own type,
/// so an int sitting in a `float` column is written `5.0` and matches its `.decl`.
/// `symbol` cells go through the strict TSV encoder so a tab, newline or backslash
/// in the string cannot break the tab-separated format.
fn render_cell(value: &Atom, col_type: SouffleType) -> String {
    match col_type {
        SouffleType::Symbol => {
            let text = match value {
                Atom::Sym(s) => s.clone(),
                Atom::Int(i) => i.to_string(),
                Atom::Float(f) => crate::datalog::render_float(*f),
            };
            encode_value(&text)
        }
        SouffleType::Number => match value {
            Atom::Int(i) => i.to_string(),
            Atom::Float(f) => (*f as i64).to_string(),
            Atom::Sym(s) => s.clone(),
        },
        SouffleType::Float => {
            let f = match value {
                Atom::Float(f) => *f,
                Atom::Int(i) => *i as f64,
                Atom::Sym(s) => s.parse::<f64>().unwrap_or(0.0),
            };
            let text = format!("{f}");
            if text.contains(['.', 'e', 'E']) {
                text
            } else {
                format!("{text}.0") // keep a decimal point so it reads as a float
            }
        }
    }
}

/// Stream one `<predicate>.facts` file per relation, each opened via `make_sink`.
///
/// `make_sink(predicate)` yields the sink a relation's rows are written to (a file
/// handle in production, an in-memory buffer or `io::sink()` in tests). One sink is
/// held open per relation — bounded by the predicate vocabulary, not the corpus —
/// and each fact's row is written then dropped, so peak memory is O(1) in the corpus
/// size. The opened sinks are returned so a buffer-backed caller can read the bytes.
///
/// Cells are encoded with the strict TSV writer, so the files are lossless; facts
/// keep their given (canonical) order, and each file is headerless as Soufflé's
/// native fact format expects.
pub fn write_souffle_facts<W, F>(
    facts: &[Fact],
    mut make_sink: F,
) -> Result<BTreeMap<String, W>, Error>
where
    W: Write,
    F: FnMut(&str) -> std::io::Result<W>,
{
    let types: BTreeMap<String, Vec<SouffleType>> = souffle_relations(facts)?
        .into_iter()
        .map(|r| (r.predicate, r.types))
        .collect();
    let mut sinks: BTreeMap<String, W> = BTreeMap::new();
    for predicate in types.keys() {
        sinks.insert(predicate.clone(), make_sink(predicate)?);
    }
    let delimiter = DELIMITER.to_string();
    for fact in facts {
        let col_types = &types[&fact.predicate];
        let cells: Vec<String> = fact
            .args
            .iter()
            .zip(col_types)
            .map(|(arg, col_type)| render_cell(arg, *col_type))
            .collect();
        let sink = sinks.get_mut(&fact.predicate).expect("relation is present");
        sink.write_all(cells.join(&delimiter).as_bytes())?;
        sink.write_all(b"\n")?;
    }
    Ok(sinks)
}

/// Build one `<predicate>.facts` file body per relation.
///
/// Returns a map from predicate to the file's full text — the in-memory convenience
/// form over the streaming [`write_souffle_facts`], so the two are byte-identical by
/// construction.
pub fn souffle_facts(facts: &[Fact]) -> Result<BTreeMap<String, String>, Error> {
    let sinks = write_souffle_facts(facts, |_| Ok(Vec::<u8>::new()))?;
    sinks
        .into_iter()
        .map(|(predicate, bytes)| {
            String::from_utf8(bytes)
                .map(|text| (predicate, text))
                .map_err(|e| Error::Datalog(format!("facts body is not UTF-8: {e}")))
        })
        .collect()
}
