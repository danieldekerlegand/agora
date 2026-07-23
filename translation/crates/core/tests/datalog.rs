//! Unit-level pins for the logic-program projection: atom/fact rendering in both
//! dialects, the reversible `predicate_for_type` bijection, the "no null reaches the
//! logic program" rule, and the ProbLog confidence lift.

use translation_core::{
    edge_facts, node_facts, predicate_for_type, render_atom, render_fact, AnnotatedFact, Atom,
    CanonicalSchema, Cell, Dialect, Fact, Row,
};

fn sym(s: &str) -> Atom {
    Atom::Sym(s.to_string())
}

#[test]
fn render_atom_pins_both_dialects() {
    // A lowercase-initial token is a bare Prolog atom, a quoted Datalog string.
    assert_eq!(render_atom(&sym("dish"), Dialect::Prolog), "dish");
    assert_eq!(render_atom(&sym("dish"), Dialect::Datalog), "\"dish\"");
    // A csid / capital-initial name must be quoted in Prolog too.
    assert_eq!(render_atom(&sym("cs:dish:Q42"), Dialect::Prolog), "'cs:dish:Q42'");
    assert_eq!(render_atom(&sym("Ceviche"), Dialect::Prolog), "'Ceviche'");
    assert_eq!(
        render_atom(&sym("cs:dish:Q42"), Dialect::Datalog),
        "\"cs:dish:Q42\""
    );
    // Numeric literals.
    assert_eq!(render_atom(&Atom::Int(-1438), Dialect::Prolog), "-1438");
    assert_eq!(render_atom(&Atom::Float(0.5), Dialect::Prolog), "0.5");
    // The shared escape set (backslash, tab, newline, carriage return) plus the quote.
    assert_eq!(
        render_atom(&sym("a\tb\\c\n'd"), Dialect::Prolog),
        "'a\\tb\\\\c\\n\\'d'"
    );
    assert_eq!(
        render_atom(&sym("a\tb\\c\n\"d"), Dialect::Datalog),
        "\"a\\tb\\\\c\\n\\\"d\""
    );
}

#[test]
fn render_fact_pins_both_dialects() {
    let node = Fact::new("node", vec![sym("cs:dish:Q42"), sym("Dish"), sym("Ceviche")], None);
    assert_eq!(
        render_fact(&node, Dialect::Prolog).unwrap(),
        "node('cs:dish:Q42', 'Dish', 'Ceviche')."
    );
    assert_eq!(
        render_fact(&node, Dialect::Datalog).unwrap(),
        "node(\"cs:dish:Q42\", \"Dish\", \"Ceviche\")."
    );

    // A source rides as a trailing line comment (`%` for Prolog, `//` for Datalog),
    // with internal whitespace collapsed so it stays on one line.
    let timed = Fact::new(
        "time_start",
        vec![sym("cs:battle:Q7"), Atom::Int(-480)],
        Some("wiki  data".to_string()),
    );
    assert_eq!(
        render_fact(&timed, Dialect::Prolog).unwrap(),
        "time_start('cs:battle:Q7', -480).  % source: wiki data"
    );
    assert_eq!(
        render_fact(&timed, Dialect::Datalog).unwrap(),
        "time_start(\"cs:battle:Q7\", -480).  // source: wiki data"
    );
}

#[test]
fn predicate_for_type_is_a_reversible_bijection() {
    assert_eq!(predicate_for_type("LOCATED_IN").unwrap(), "located_in");
    assert_eq!(predicate_for_type("DERIVED_FROM").unwrap(), "derived_from");
    // An out-of-domain :TYPE (mixed case) is rejected rather than silently colliding.
    assert!(predicate_for_type("Located_In").is_err());
    assert!(predicate_for_type("located_in").is_err());
    assert!(predicate_for_type("").is_err());
}

fn node_row(pairs: &[(&str, &str)], labels: &[&str]) -> Row {
    let mut row = Row::new();
    for (k, v) in pairs {
        row.insert((*k).to_string(), Cell::Scalar((*v).to_string()));
    }
    row.insert(
        ":LABEL".to_string(),
        Cell::Multi(labels.iter().map(|s| s.to_string()).collect()),
    );
    row
}

#[test]
fn blank_source_emits_no_provenance_fact() {
    let schema = CanonicalSchema::canonical().unwrap();

    // A node with a populated source emits a queryable source/2 fact...
    let sourced = node_row(&[("csid", "cs:x:1"), ("name", "X"), ("source", "wikidata")], &["Place"]);
    let facts = node_facts(&schema, &sourced).unwrap();
    assert!(facts.iter().any(|f| f.predicate == "source"));

    // ...and one with a blank source emits none — no null reaches the logic program.
    let blank = node_row(&[("csid", "cs:x:1"), ("name", "X"), ("source", "")], &["Place"]);
    let facts = node_facts(&schema, &blank).unwrap();
    assert!(!facts.iter().any(|f| f.predicate == "source"));
    assert!(facts.iter().all(|f| f.source.is_none()));

    // The same for an edge's rel_source/4 provenance companion.
    let mut edge = Row::new();
    for (k, v) in [(":START_ID", "cs:a:1"), (":END_ID", "cs:b:2"), (":TYPE", "LOCATED_IN")] {
        edge.insert(k.to_string(), Cell::Scalar(v.to_string()));
    }
    let facts = edge_facts(&edge).unwrap();
    assert!(!facts.iter().any(|f| f.predicate == "rel_source"));
    // No confidence/weight either, so no rel_conf companion.
    assert!(!facts.iter().any(|f| f.predicate == "rel_conf"));
}

#[test]
fn confidence_falls_back_from_confidence_to_weight() {
    let mut edge = Row::new();
    for (k, v) in [
        (":START_ID", "cs:a:1"),
        (":END_ID", "cs:b:2"),
        (":TYPE", "SPOKEN_IN"),
        ("weight", "0.8"),
    ] {
        edge.insert(k.to_string(), Cell::Scalar(v.to_string()));
    }
    let facts = edge_facts(&edge).unwrap();
    let conf = facts.iter().find(|f| f.predicate == "rel_conf").unwrap();
    assert_eq!(conf.args.last(), Some(&Atom::Float(0.8)));
}

#[test]
fn problog_annotates_only_uncertain_edges() {
    // A confidence of exactly 1.0 is certain — written unannotated.
    let certain = AnnotatedFact {
        fact: Fact::new("rel", vec![sym("located_in"), sym("cs:a"), sym("cs:b")], None),
        probability: Some(1.0),
    };
    assert_eq!(
        translation_core::render_annotated_fact(&certain).unwrap(),
        "rel(located_in, 'cs:a', 'cs:b')."
    );

    // A confidence in (0, 1) rides as a W:: probability.
    let uncertain = AnnotatedFact {
        fact: Fact::new("rel", vec![sym("located_in"), sym("cs:a"), sym("cs:b")], None),
        probability: Some(0.8),
    };
    assert_eq!(
        translation_core::render_annotated_fact(&uncertain).unwrap(),
        "0.8::rel(located_in, 'cs:a', 'cs:b')."
    );

    // A confidence outside [0, 1] is an error.
    let bad = AnnotatedFact {
        fact: Fact::new("rel", vec![sym("located_in"), sym("cs:a"), sym("cs:b")], None),
        probability: Some(1.5),
    };
    assert!(translation_core::render_annotated_fact(&bad).is_err());
}
