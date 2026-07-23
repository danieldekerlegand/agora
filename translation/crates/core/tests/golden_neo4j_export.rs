//! Byte-identity against culture-scrape: `graph_to_neo4j_export` must produce exactly
//! the shard bytes `neo4j/export.py`'s `export_to_tsv` writes for the shared fixture,
//! and `facts_for_graph` must project exactly the fact count `datalog/export.py`'s
//! `export_dataset` reports. The goldens under `fixtures/golden/neo4j/export/` and
//! `fixtures/golden/datalog/fact_count.txt` are captured by `tools/gen_golden.py` from
//! the reference package (the fixture replayed over a fake driver, exactly as
//! culture-scrape mocks its cursor), so this is a verified port, not an approximation.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use translation_core::{facts_for_graph, graph_to_neo4j_export, CanonicalSchema, Graph};

const FIXTURE: &str = include_str!("../fixtures/graph.json");

fn schema_and_graph() -> (CanonicalSchema, Graph) {
    (
        CanonicalSchema::canonical().unwrap(),
        Graph::from_json(FIXTURE).unwrap(),
    )
}

fn golden_shards(subdir: &str) -> BTreeMap<String, String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/golden/neo4j/export")
        .join(subdir);
    let mut shards = BTreeMap::new();
    for entry in fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let key = path.file_stem().unwrap().to_str().unwrap().to_string();
        shards.insert(key, fs::read_to_string(&path).unwrap());
    }
    shards
}

#[test]
fn node_shards_match_the_culture_scrape_golden() {
    let (schema, graph) = schema_and_graph();
    let result = graph_to_neo4j_export(&schema, &graph).unwrap();
    let golden = golden_shards("nodes");
    assert_eq!(
        result.node_files, golden,
        "neo4j node shards diverged from export_to_tsv"
    );
    assert_eq!(result.node_count, 3);
}

#[test]
fn edge_shards_match_the_culture_scrape_golden() {
    let (schema, graph) = schema_and_graph();
    let result = graph_to_neo4j_export(&schema, &graph).unwrap();
    let golden = golden_shards("edges");
    assert_eq!(
        result.edge_files, golden,
        "neo4j edge shards diverged from export_to_tsv"
    );
    assert_eq!(result.edge_count, 3);
}

#[test]
fn fact_count_matches_export_dataset() {
    let (schema, graph) = schema_and_graph();
    let expected: usize = include_str!("../fixtures/golden/datalog/fact_count.txt")
        .trim()
        .parse()
        .unwrap();
    let facts = facts_for_graph(&schema, &graph).unwrap();
    assert_eq!(
        facts.len(),
        expected,
        "projected fact count diverged from export_dataset's ExportResult.fact_count"
    );
}
