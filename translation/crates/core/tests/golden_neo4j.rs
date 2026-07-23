//! Byte-identity against culture-scrape: the Rust `node_cypher` / `edge_cypher` must
//! produce exactly the bytes `neo4j/load_csv.py` produces for the canonical node and
//! edge headers. The goldens under `fixtures/golden/neo4j/` are captured by
//! `tools/gen_golden.py` from the reference package, so this is a verified port.

use translation_core::{edge_cypher, node_cypher, CanonicalSchema};

const GOLDEN_NODE_CYPHER: &str = include_str!("../fixtures/golden/neo4j/node_load.cypher");
const GOLDEN_EDGE_CYPHER: &str = include_str!("../fixtures/golden/neo4j/edge_load.cypher");

#[test]
fn node_cypher_matches_the_culture_scrape_golden() {
    let schema = CanonicalSchema::canonical().unwrap();
    let cypher = node_cypher(&schema.node_columns).unwrap();
    assert_eq!(
        cypher, GOLDEN_NODE_CYPHER,
        "node LOAD CSV cypher diverged from load_csv.py"
    );
}

#[test]
fn edge_cypher_matches_the_culture_scrape_golden() {
    let schema = CanonicalSchema::canonical().unwrap();
    let cypher = edge_cypher(&schema.edge_columns).unwrap();
    assert_eq!(
        cypher, GOLDEN_EDGE_CYPHER,
        "edge LOAD CSV cypher diverged from load_csv.py"
    );
}
