//! Emit a loadable SWI-Prolog program (`graph.pl`) from projected facts.
//!
//! A faithful port of culture-scrape's `datalog/prolog.py` for the base (rule-less)
//! export `export_dataset` writes by default. The program is a schema header, then a
//! `:- discontiguous` and a `:- dynamic` directive for every predicate/arity present
//! (facts may be interleaved by row; an empty relation answers `false` rather than
//! erroring), then one clause per fact in projection order.
//!
//! Recursive derived predicates would be TABLED (never `:- dynamic` on a tabled
//! head); the shared inference library is out of scope for this port, so no head is
//! tabled and the two directive blocks cover every fact predicate — byte-for-byte
//! the default `export_dataset` output.

use std::collections::BTreeSet;
use std::io::Write;

use crate::datalog::{render_fact, Dialect, Fact};
use crate::error::Error;

/// Filename of the generated SWI-Prolog program inside the output directory.
pub const PROLOG_PROGRAM_NAME: &str = "graph.pl";

/// The `%`-comment header documenting the emitted predicate schema. Static (the full
/// vocabulary the projection can emit) so the file is self-describing even for a
/// sparse graph. Ends with a newline, matching the reference triple-quoted string.
const HEADER: &str = "\
% culture-scrape — SWI-Prolog fact base
% =====================================
% Auto-generated from the canonical TSV graph (docs/data-model.md); a derived,
% mechanical projection — do not edit by hand.
%
% Predicate schema
% ----------------
%   node(Csid, Type, Name)        entity: csid, primary :LABEL, display name
%   instance_of(Csid, Label)      one per :LABEL (a multi-label node repeats)
%   located_at(Csid, Lat, Lon)    geographic coordinate (floats)
%   <dimension>(Csid, Value)      binary dimension facts, e.g. time_start/2,
%                                 time_end/2, part_of_period/2, language_code/2,
%                                 derived_from/2, ...
%   rel(Type, A, B)               generic edge: type atom + endpoint csids
%   <type>(A, B)                  typed edge, one binary predicate per :TYPE
%                                 (e.g. located_in/2, adjacent_to/2)
%   rel_conf(Type, A, B, Weight)  optional edge weight/confidence (float)
%
% Csids are carried verbatim as single-quoted atoms ('cs:dish:Q42'); the same
% csid always renders to the same atom, so the mapping is reversible.
%
% Load:  swipl this_file.pl
% Query: ?- node(X, 'Dish', Name).
";

/// The distinct `(predicate, arity)` pairs in `facts`, sorted.
///
/// One directive is emitted per pair, so two predicates sharing a name but differing
/// in arity each get their own (correct) declaration. The set is bounded by the
/// predicate vocabulary, not the corpus size, so accumulating it stays O(1) in the
/// number of facts.
fn signatures(facts: &[Fact]) -> BTreeSet<(String, usize)> {
    // Insert one at a time rather than `collect()`: `BTreeSet`'s `FromIterator`
    // buffers the whole iterator into a Vec to sort it (O(N) transient), which would
    // defeat the O(1)-peak-memory guarantee. A loop keeps only the bounded set (one
    // entry per distinct predicate/arity) plus one transient key resident.
    let mut sigs = BTreeSet::new();
    for fact in facts {
        sigs.insert((fact.predicate.clone(), fact.args.len()));
    }
    sigs
}

/// The bounded header + directive lines preceding the fact clauses.
fn preamble_lines(signatures: &BTreeSet<(String, usize)>) -> Vec<String> {
    let mut lines: Vec<String> = vec![HEADER.to_string(), String::new()];
    if !signatures.is_empty() {
        for (name, arity) in signatures {
            lines.push(format!(":- discontiguous {name}/{arity}."));
        }
        lines.push(String::new());
        for (name, arity) in signatures {
            lines.push(format!(":- dynamic {name}/{arity}."));
        }
        lines.push(String::new());
    }
    lines
}

/// Stream a SWI-Prolog program for `facts` to `sink`; return the fact count.
///
/// The preamble is bounded by the predicate vocabulary and each fact clause is
/// written then dropped, so peak memory is O(1) in the corpus size (the giant
/// program string is never built). Writing each logical line followed by `\n` is
/// byte-for-byte identical to [`render_program`]'s `join("\n") + "\n"`.
pub fn write_program<W: Write>(sink: &mut W, facts: &[Fact]) -> Result<usize, Error> {
    for line in preamble_lines(&signatures(facts)) {
        writeln!(sink, "{line}")?;
    }
    let mut count = 0;
    for fact in facts {
        writeln!(sink, "{}", render_fact(fact, Dialect::Prolog)?)?;
        count += 1;
    }
    Ok(count)
}

/// Render `facts` as a loadable SWI-Prolog program.
///
/// The text is the schema header, then `:- discontiguous` and `:- dynamic`
/// directives for every predicate/arity present, then one clause per fact in the
/// given order. The result ends with a trailing newline. This is the in-memory
/// convenience form; [`write_program`] streams the identical bytes to a sink.
pub fn render_program(facts: &[Fact]) -> Result<String, Error> {
    let mut buf: Vec<u8> = Vec::new();
    write_program(&mut buf, facts)?;
    Ok(String::from_utf8(buf).expect("prolog program is UTF-8"))
}
