//! Emit a ProbLog probabilistic logic program (`graph.problog.pl`) from facts.
//!
//! A faithful port of culture-scrape's `datalog/problog.py` for the base (rule-less)
//! export. ProbLog is Prolog with **annotated facts**: a fact may carry a
//! probability, written `0.8::edge(a, b).`. Two things distinguish it from the plain
//! SWI-Prolog emitter:
//!
//! * **Confidence becomes probability.** An edge's confidence (carried by the
//!   `rel_conf/4` companion) is lifted onto the edge relation itself: `rel(t, A, B)`
//!   and the typed `t(A, B)` are emitted as `W::` annotated facts. A confidence of
//!   `1.0` — or an absent one — is a *certain* fact, written unannotated, as are node,
//!   dimension and provenance facts.
//! * **No Prolog directives.** ProbLog's parser rejects `:- dynamic` /
//!   `:- discontiguous` / `:- table`, so the program is just a header comment and the
//!   facts.

use std::io::Write;

use crate::datalog::{render_fact, render_float, Dialect, Fact};
use crate::error::Error;

/// Filename of the generated ProbLog program inside the output directory. Distinct
/// from the SWI-Prolog `graph.pl` so both dialects can be written side by side.
pub const PROBLOG_PROGRAM_NAME: &str = "graph.problog.pl";

/// The edge companion facts (`rel_conf/4`, `rel_source/4`) that ride alongside the
/// edge relation but are *metadata*, so they stay certain (unannotated).
const EDGE_COMPANIONS: &[&str] = &["rel_conf", "rel_source"];

/// The `%`-comment header documenting the ProbLog dialect. Ends with a newline,
/// matching the reference triple-quoted string.
const HEADER: &str = "\
% culture-scrape — ProbLog probabilistic fact base
% ================================================
% Auto-generated from the canonical TSV graph (docs/data-model.md); a derived,
% mechanical projection — do not edit by hand.
%
% ProbLog dialect (https://dtai.cs.kuleuven.be/problog/): Prolog syntax with
% annotated facts. An edge's confidence becomes the fact's probability:
%   0.8::located_in('cs:dish:Q42', 'cs:place:Q123').
% A confidence of 1.0 (or none) is a certain fact, written unannotated. Node,
% dimension and provenance facts are certain. The shared Horn inference rules
% (--rules) are ProbLog-compatible verbatim.
%
% Predicate schema (see graph.pl's header for the full vocabulary):
%   node(Csid, Type, Name)        entity: csid, primary label, display name
%   instance_of(Csid, Label)      one per label
%   <dimension>(Csid, Value)      time_start/2, language_code/2, derived_from/2, ...
%   W::rel(Type, A, B)            generic edge, W = confidence (omitted when 1.0)
%   W::<type>(A, B)               typed edge, one binary predicate per :TYPE
%   rel_conf(Type, A, B, W)       queryable confidence companion (certain)
%   rel_source(Type, A, B, Src)   queryable provenance companion (certain)
%
% Query: add e.g. `query(within_region('cs:dish:Q42', X)).`, then run
%        `problog this_file.problog.pl` (pip install problog).
";

/// A [`Fact`] paired with an optional ProbLog probability.
///
/// `probability` is the annotation written before `::`. `None` (or exactly `1.0`)
/// marks a *certain* fact, rendered as a bare clause with no annotation. Any other
/// value must lie in `[0, 1]` or rendering errors.
#[derive(Debug, Clone, PartialEq)]
pub struct AnnotatedFact {
    pub fact: Fact,
    pub probability: Option<f64>,
}

impl AnnotatedFact {
    /// A certain (unannotated) fact — node, dimension and provenance facts.
    pub fn certain(fact: Fact) -> AnnotatedFact {
        AnnotatedFact {
            fact,
            probability: None,
        }
    }
}

/// Render `annotated` as a ProbLog clause (annotated iff it is uncertain).
///
/// The clause body is the ordinary [`render_fact`] output in the Prolog dialect; a
/// probability other than `None` or `1.0` is prefixed as `W::`.
pub fn render_annotated_fact(annotated: &AnnotatedFact) -> Result<String, Error> {
    let clause = render_fact(&annotated.fact, Dialect::Prolog)?;
    // None or exactly 1.0 → a certain fact, rendered as a bare clause.
    let Some(probability) = annotated.probability else {
        return Ok(clause);
    };
    if probability == 1.0 {
        return Ok(clause);
    }
    if !(0.0..=1.0).contains(&probability) {
        return Err(Error::Datalog(format!(
            "confidence {probability} for {:?} is not a probability in [0, 1]",
            annotated.fact.predicate
        )));
    }
    Ok(format!("{}::{clause}", render_float(probability)))
}

/// Annotate one edge row's facts with that edge's confidence.
///
/// `facts` is the group [`crate::datalog::edge_facts`] projects from a single row.
/// The confidence carried by `rel_conf/4` (its last argument) is lifted onto the two
/// edge-relation facts; the companions stay certain. A group with no `rel_conf/4`
/// leaves the edge unannotated (absent confidence → certain).
pub fn annotate_edge_group(facts: Vec<Fact>) -> Vec<AnnotatedFact> {
    let confidence: Option<f64> = facts.iter().find_map(|fact| {
        if fact.predicate == "rel_conf" {
            match fact.args.last() {
                Some(crate::datalog::Atom::Float(f)) => Some(*f),
                Some(crate::datalog::Atom::Int(i)) => Some(*i as f64),
                _ => None,
            }
        } else {
            None
        }
    });
    facts
        .into_iter()
        .map(|fact| {
            if EDGE_COMPANIONS.contains(&fact.predicate.as_str()) {
                AnnotatedFact::certain(fact)
            } else {
                AnnotatedFact {
                    fact,
                    probability: confidence,
                }
            }
        })
        .collect()
}

/// Stream a ProbLog program for `facts` to `sink`; return the fact count.
///
/// ProbLog needs no directive preamble, so `facts` is visited once and only one
/// clause is held in memory at a time — peak memory is O(1) in the corpus size.
/// Writing the header then each clause followed by `\n` is byte-for-byte identical
/// to [`render_problog_program`]'s `join("\n") + "\n"`.
pub fn write_problog_program<W: Write>(
    sink: &mut W,
    facts: &[AnnotatedFact],
) -> Result<usize, Error> {
    write!(sink, "{HEADER}")?;
    writeln!(sink)?;
    let mut count = 0;
    for annotated in facts {
        writeln!(sink, "{}", render_annotated_fact(annotated)?)?;
        count += 1;
    }
    Ok(count)
}

/// Render `facts` as a loadable ProbLog program.
///
/// The text is the schema header, then one clause per annotated fact in the given
/// order (an edge annotated `W::` when its confidence is neither absent nor `1.0`).
/// The result ends with a trailing newline. This is the in-memory convenience form;
/// [`write_problog_program`] streams the identical bytes to a sink.
pub fn render_problog_program(facts: &[AnnotatedFact]) -> Result<String, Error> {
    let mut buf: Vec<u8> = Vec::new();
    write_problog_program(&mut buf, facts)?;
    Ok(String::from_utf8(buf).expect("problog program is UTF-8"))
}
