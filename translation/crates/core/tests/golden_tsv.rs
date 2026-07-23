//! Byte-identity against culture-scrape: the Rust writers must produce exactly the
//! bytes `schema/tsvio.py`'s `write_node_rows` / `write_edge_rows` produce for the
//! shared fixture. The goldens under `fixtures/golden/` are captured by
//! `tools/gen_golden.py` from the reference package, so this is a verified port.

use translation_core::{edges_to_tsv, nodes_to_tsv, CanonicalSchema, Graph};

const FIXTURE: &str = include_str!("../fixtures/graph.json");
const GOLDEN_NODES: &str = include_str!("../fixtures/golden/nodes.tsv");
const GOLDEN_EDGES: &str = include_str!("../fixtures/golden/edges.tsv");

#[test]
fn nodes_match_the_culture_scrape_golden() {
    let schema = CanonicalSchema::canonical().unwrap();
    let graph = Graph::from_json(FIXTURE).unwrap();
    let tsv = nodes_to_tsv(&schema, &graph).unwrap();
    assert_eq!(tsv, GOLDEN_NODES, "node TSV diverged from the reference writer");
}

#[test]
fn edges_match_the_culture_scrape_golden() {
    let schema = CanonicalSchema::canonical().unwrap();
    let graph = Graph::from_json(FIXTURE).unwrap();
    let tsv = edges_to_tsv(&schema, &graph).unwrap();
    assert_eq!(tsv, GOLDEN_EDGES, "edge TSV diverged from the reference writer");
}

#[test]
fn header_carries_typed_suffixes_and_provenance() {
    let schema = CanonicalSchema::canonical().unwrap();
    let graph = Graph::from_json(FIXTURE).unwrap();
    let nodes = nodes_to_tsv(&schema, &graph).unwrap();
    let header = nodes.lines().next().unwrap();
    for cell in ["csid:ID", ":LABEL", "time_start:int", "lat:float", "confidence:float"] {
        assert!(header.contains(cell), "node header missing {cell}");
    }
    for prov in ["source", "source_url", "retrieved_at", "confidence:float", "license"] {
        assert!(header.contains(prov), "node header missing provenance {prov}");
    }
    let edges = edges_to_tsv(&schema, &graph).unwrap();
    let edge_header = edges.lines().next().unwrap();
    for cell in [":START_ID", ":END_ID", ":TYPE"] {
        assert!(edge_header.contains(cell), "edge header missing {cell}");
    }
}
