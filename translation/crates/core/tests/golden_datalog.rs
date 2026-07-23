//! Byte-identity against culture-scrape: the Rust logic-program emitters must
//! produce exactly the bytes `datalog/export.py`'s `export_dataset` produces for the
//! shared fixture (SWI-Prolog `graph.pl`, Soufflé `graph.dl` + its `.facts`, and
//! ProbLog `graph.problog.pl`, all with no rules). The goldens under
//! `fixtures/golden/datalog/` are captured by `tools/gen_golden.py` from the
//! reference package, so this is a verified reimplementation, not an approximation.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use translation_core::{
    graph_to_problog, graph_to_prolog, graph_to_souffle, CanonicalSchema, Graph,
};

const FIXTURE: &str = include_str!("../fixtures/graph.json");
const GOLDEN_PL: &str = include_str!("../fixtures/golden/datalog/graph.pl");
const GOLDEN_DL: &str = include_str!("../fixtures/golden/datalog/graph.dl");
const GOLDEN_PROBLOG: &str = include_str!("../fixtures/golden/datalog/graph.problog.pl");

fn schema_and_graph() -> (CanonicalSchema, Graph) {
    (
        CanonicalSchema::canonical().unwrap(),
        Graph::from_json(FIXTURE).unwrap(),
    )
}

fn facts_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/golden/datalog/facts")
}

#[test]
fn prolog_matches_the_culture_scrape_golden() {
    let (schema, graph) = schema_and_graph();
    let pl = graph_to_prolog(&schema, &graph).unwrap();
    assert_eq!(pl, GOLDEN_PL, "graph.pl diverged from export_dataset");
}

#[test]
fn problog_matches_the_culture_scrape_golden() {
    let (schema, graph) = schema_and_graph();
    let problog = graph_to_problog(&schema, &graph).unwrap();
    assert_eq!(
        problog, GOLDEN_PROBLOG,
        "graph.problog.pl diverged from export_dataset"
    );
}

#[test]
fn souffle_program_matches_the_culture_scrape_golden() {
    let (schema, graph) = schema_and_graph();
    let souffle = graph_to_souffle(&schema, &graph).unwrap();
    assert_eq!(souffle.program, GOLDEN_DL, "graph.dl diverged from export_dataset");
}

#[test]
fn souffle_facts_match_the_culture_scrape_goldens() {
    let (schema, graph) = schema_and_graph();
    let souffle = graph_to_souffle(&schema, &graph).unwrap();

    // The golden `.facts` files are the source of truth for the relation set.
    let mut golden: BTreeMap<String, String> = BTreeMap::new();
    for entry in fs::read_dir(facts_dir()).unwrap() {
        let path = entry.unwrap().path();
        let predicate = path.file_stem().unwrap().to_str().unwrap().to_string();
        golden.insert(predicate, fs::read_to_string(&path).unwrap());
    }

    let produced: BTreeMap<String, String> = souffle.facts;
    let produced_keys: Vec<&String> = produced.keys().collect();
    let golden_keys: Vec<&String> = golden.keys().collect();
    assert_eq!(
        produced_keys, golden_keys,
        "the emitted relation set diverged from the golden .facts files"
    );
    for (predicate, body) in &produced {
        assert_eq!(
            body, &golden[predicate],
            "{predicate}.facts diverged from export_dataset"
        );
    }
}
