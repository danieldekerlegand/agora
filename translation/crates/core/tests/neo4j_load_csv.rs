//! The idempotent `LOAD CSV` Cypher generation — mirrors culture-scrape's
//! `test_neo4j_load_csv.py`: the Cypher is generated and asserted on, never run
//! against a live database. `node_cypher` / `edge_cypher` are pinned byte-for-byte by
//! `golden_neo4j.rs`; here we assert the MERGE-not-CREATE structure and that
//! `build_statements` orders node shards before edge shards.

use translation_core::{
    build_statements, edge_cypher, graph_to_load_script, node_cypher, CanonicalSchema, Graph,
};

const FIXTURE: &str = include_str!("../fixtures/graph.json");

fn schema_and_graph() -> (CanonicalSchema, Graph) {
    (
        CanonicalSchema::canonical().unwrap(),
        Graph::from_json(FIXTURE).unwrap(),
    )
}

#[test]
fn node_cypher_merges_on_csid_not_create() {
    let schema = CanonicalSchema::canonical().unwrap();
    let cypher = node_cypher(&schema.node_columns).unwrap();
    // Idempotent: a MERGE keyed on csid under the shared Entity anchor, never a CREATE.
    assert!(cypher.contains("MERGE (n:Entity {`csid`: row.`csid:ID`})"));
    assert!(!cypher.contains("CREATE"));
    assert!(cypher.contains("LOAD CSV WITH HEADERS FROM $file AS row"));
    assert!(cypher.contains("FIELDTERMINATOR '\\t'"));
    // Labels reattached from the :LABEL cell; typed columns coerced per suffix.
    assert!(cypher.contains("CALL apoc.create.addLabels(n, split(row.`:LABEL`, ';'))"));
    assert!(cypher.contains("`time_start`: toInteger(row.`time_start:int`)"));
    assert!(cypher.contains("`lat`: toFloat(row.`lat:float`)"));
    assert!(cypher.contains("`name`: row.`name`"));
    assert!(cypher.contains("`aliases`: split(row.`aliases`, ';')"));
}

#[test]
fn edge_cypher_merges_on_start_end_type_not_create() {
    let schema = CanonicalSchema::canonical().unwrap();
    let cypher = edge_cypher(&schema.edge_columns).unwrap();
    // Relationships merge on (:START_ID, :END_ID, :TYPE) via APOC, never created.
    assert!(cypher.contains("apoc.merge.relationship("));
    assert!(cypher.contains("row.`:START_ID`"));
    assert!(cypher.contains("row.`:END_ID`"));
    assert!(cypher.contains("row.`:TYPE`"));
    assert!(!cypher.contains("CREATE"));
    assert!(cypher.contains("`weight`: toFloat(row.`weight:float`)"));
}

#[test]
fn build_statements_orders_nodes_before_edges() {
    let (schema, graph) = schema_and_graph();
    let statements = build_statements(&schema, &graph).unwrap();

    let kinds: Vec<&str> = statements.iter().map(|s| s.kind.as_str()).collect();
    // Every node statement precedes every edge statement.
    let first_edge = kinds.iter().position(|k| *k == "edge").unwrap();
    assert!(kinds[..first_edge].iter().all(|k| *k == "node"));
    assert!(kinds[first_edge..].iter().all(|k| *k == "edge"));

    // The fixture has three primary node labels (Cuisine, Language, Place — the
    // alphabetically-first :LABEL of each node) and three edge types.
    let node_files: Vec<&str> = statements
        .iter()
        .filter(|s| s.kind == "node")
        .map(|s| s.file.as_str())
        .collect();
    assert_eq!(
        node_files,
        vec!["nodes/Cuisine.tsv", "nodes/Language.tsv", "nodes/Place.tsv"]
    );
    let edge_files: Vec<&str> = statements
        .iter()
        .filter(|s| s.kind == "edge")
        .map(|s| s.file.as_str())
        .collect();
    assert_eq!(
        edge_files,
        vec![
            "edges/DERIVED_FROM.tsv",
            "edges/LOCATED_IN.tsv",
            "edges/SPOKEN_IN.tsv"
        ]
    );

    // Each node statement carries the canonical node cypher (identical across shards).
    let node_cy = node_cypher(&schema.node_columns).unwrap();
    for stmt in statements.iter().filter(|s| s.kind == "node") {
        assert_eq!(stmt.cypher, node_cy);
    }
}

#[test]
fn load_script_is_runnable_and_references_every_shard() {
    let (schema, graph) = schema_and_graph();
    let script = graph_to_load_script(&schema, &graph).unwrap();
    // A cypher-shell-runnable script: APOC note, one :param binding per shard.
    assert!(script.contains("cypher-shell -f neo4j-load-csv.cypher"));
    assert!(script.contains(":param file => 'nodes/Language.tsv';"));
    assert!(script.contains(":param file => 'edges/SPOKEN_IN.tsv';"));
    // Node blocks come before edge blocks in the emitted order.
    let node_pos = script.find("// node: nodes/Language.tsv").unwrap();
    let edge_pos = script.find("// edge: edges/SPOKEN_IN.tsv").unwrap();
    assert!(node_pos < edge_pos);
}
