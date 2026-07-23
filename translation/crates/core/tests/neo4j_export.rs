//! Driver-cursor export back to canonical TSV — mirrors culture-scrape's
//! `test_neo4j_export.py`. No live database: a fake cursor replays fixture records
//! (the shape `labels(n)` / `properties(n)` / `type(r)` return over Bolt) and the
//! exported shards are read back with the real TSV reader and asserted against the
//! canonical schema.

use std::collections::BTreeMap;

use translation_core::{
    export_to_tsv, read_rows, CanonicalSchema, Cell, GraphCursor, Neo4jEdge, Neo4jNode, PropValue,
};

const ENTITY_LABEL: &str = "Entity";

/// A cursor that replays a fixed list of node and edge records.
struct FakeCursor {
    nodes: Vec<Neo4jNode>,
    edges: Vec<Neo4jEdge>,
}

impl GraphCursor for FakeCursor {
    fn nodes(&self) -> Vec<Neo4jNode> {
        self.nodes.clone()
    }
    fn edges(&self) -> Vec<Neo4jEdge> {
        self.edges.clone()
    }
}

fn props(pairs: &[(&str, PropValue)]) -> BTreeMap<String, PropValue> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect()
}

fn node(labels: &[&str], p: &[(&str, PropValue)]) -> Neo4jNode {
    Neo4jNode {
        labels: labels.iter().map(|l| l.to_string()).collect(),
        props: props(p),
    }
}

#[test]
fn nodes_grouped_by_label_with_canonical_header_and_dropped_anchor() {
    let schema = CanonicalSchema::canonical().unwrap();
    let cursor = FakeCursor {
        nodes: vec![node(
            &["Cuisine", "Ingredient", ENTITY_LABEL],
            &[
                ("csid", PropValue::Str("cs:dish:ceviche".into())),
                ("name", PropValue::Str("Ceviche".into())),
                (
                    "aliases",
                    PropValue::List(vec![
                        PropValue::Str("cebiche".into()),
                        PropValue::Str("seviche".into()),
                    ]),
                ),
                ("time_start", PropValue::Int(1820)),
                ("lat", PropValue::Float(-12.04)),
                ("confidence", PropValue::Float(0.9)),
                ("source", PropValue::Str("wikidata".into())),
            ],
        )],
        edges: vec![],
    };

    let result = export_to_tsv(&schema, &cursor).unwrap();

    // Grouped/named by the alphabetically-first non-Entity label.
    assert_eq!(result.node_count, 1);
    let keys: Vec<&String> = result.node_files.keys().collect();
    assert_eq!(keys, vec!["Cuisine"]);

    let body = &result.node_files["Cuisine"];
    let (columns, rows) = read_rows(body).unwrap();
    // The shard carries the full canonical header.
    assert_eq!(columns, schema.node_columns);
    let row = &rows[0];
    // The Entity anchor is dropped; remaining labels are sorted in :LABEL.
    assert_eq!(
        row[":LABEL"],
        Cell::Multi(vec!["Cuisine".into(), "Ingredient".into()])
    );
    assert_eq!(
        row["aliases"],
        Cell::Multi(vec!["cebiche".into(), "seviche".into()])
    );
}

#[test]
fn typed_and_provenance_columns_survive_with_suffixes() {
    let schema = CanonicalSchema::canonical().unwrap();
    let cursor = FakeCursor {
        nodes: vec![node(
            &["Cuisine", ENTITY_LABEL],
            &[
                ("csid", PropValue::Str("cs:dish:ceviche".into())),
                ("name", PropValue::Str("Ceviche".into())),
                ("time_start", PropValue::Int(-50)),
                ("lat", PropValue::Float(-12.04)),
                ("confidence", PropValue::Float(0.95)),
                ("source", PropValue::Str("wikidata".into())),
                ("retrieved_at", PropValue::Str("2026-01-01T00:00:00Z".into())),
            ],
        )],
        edges: vec![],
    };

    let result = export_to_tsv(&schema, &cursor).unwrap();
    let body = &result.node_files["Cuisine"];
    let header = body.lines().next().unwrap();
    assert!(header.contains("time_start:int"));
    assert!(header.contains("lat:float"));
    assert!(header.contains("confidence:float"));

    let (_, rows) = read_rows(body).unwrap();
    let row = &rows[0];
    // BCE years (negative ints) and floats survive as their canonical text.
    assert_eq!(row["time_start"], Cell::Scalar("-50".into()));
    assert_eq!(row["lat"], Cell::Scalar("-12.04".into()));
    assert_eq!(row["confidence"], Cell::Scalar("0.95".into()));
    assert_eq!(row["source"], Cell::Scalar("wikidata".into()));
    assert_eq!(row["retrieved_at"], Cell::Scalar("2026-01-01T00:00:00Z".into()));
}

#[test]
fn edges_grouped_by_type_with_canonical_header() {
    let schema = CanonicalSchema::canonical().unwrap();
    let cursor = FakeCursor {
        nodes: vec![node(
            &["Place", ENTITY_LABEL],
            &[
                ("csid", PropValue::Str("cs:region:peru".into())),
                ("name", PropValue::Str("Peru".into())),
            ],
        )],
        edges: vec![
            Neo4jEdge {
                start: "cs:dish:ceviche".into(),
                end: "cs:region:peru".into(),
                edge_type: "ORIGINATES_FROM".into(),
                props: props(&[("weight", PropValue::Float(0.9))]),
            },
            Neo4jEdge {
                start: "cs:region:peru".into(),
                end: "cs:region:lima".into(),
                edge_type: "ORIGINATES_FROM".into(),
                props: props(&[("confidence", PropValue::Float(1.0))]),
            },
        ],
    };

    let result = export_to_tsv(&schema, &cursor).unwrap();
    assert_eq!(result.edge_count, 2);
    let body = &result.edge_files["ORIGINATES_FROM"];
    let (columns, rows) = read_rows(body).unwrap();
    assert_eq!(columns, schema.edge_columns);
    assert_eq!(rows.len(), 2);
    // A whole-valued float keeps its :float shape ("1.0", not "1").
    let confident = rows
        .iter()
        .find(|r| r[":START_ID"] == Cell::Scalar("cs:region:peru".into()))
        .unwrap();
    assert_eq!(confident["confidence"], Cell::Scalar("1.0".into()));
}

#[test]
fn a_node_without_a_type_label_is_rejected() {
    let schema = CanonicalSchema::canonical().unwrap();
    let cursor = FakeCursor {
        nodes: vec![node(
            &[ENTITY_LABEL],
            &[("csid", PropValue::Str("cs:mystery:1".into()))],
        )],
        edges: vec![],
    };
    let err = export_to_tsv(&schema, &cursor).unwrap_err();
    assert!(format!("{err}").contains("no type label"));
}
