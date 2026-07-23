//! The Neo4j-import CSV codec: canonical-graph <-> CSV round-trips losslessly, and a
//! corpus seeded from CSV re-exports byte-for-byte — closing the admin_import.py /
//! load_csv.py round trip in Rust. The CSV form is the comma-delimited sibling of the
//! canonical TSV (same header, same multi-value `;` join), with RFC-4180 quoting for
//! the fields that carry a `,` or a `"`.

use std::collections::BTreeMap;

use translation_core::{
    edges_to_csv, graph_from_csv, nodes_to_csv, read_csv, write_csv_edge_rows, write_csv_node_rows,
    CanonicalSchema, Cell, Column, Graph, Row,
};

const FIXTURE: &str = include_str!("../fixtures/graph.json");

fn complete(columns: &[Column], row: &Row) -> Row {
    let mut out: Row = BTreeMap::new();
    for column in columns {
        let key = column.key();
        let cell = row.get(key).cloned().unwrap_or_else(|| {
            if key == ":LABEL" || key == "aliases" {
                Cell::Multi(Vec::new())
            } else {
                Cell::Scalar(String::new())
            }
        });
        out.insert(key.to_string(), cell);
    }
    out
}

#[test]
fn node_rows_round_trip_through_csv() {
    let schema = CanonicalSchema::canonical().unwrap();
    let graph = Graph::from_json(FIXTURE).unwrap();
    let expected: Vec<Row> = graph
        .nodes
        .iter()
        .map(|r| complete(&schema.node_columns, r))
        .collect();

    let id_key = schema.node_id_key().unwrap();
    let mut buf: Vec<u8> = Vec::new();
    write_csv_node_rows(&mut buf, &schema.node_columns, id_key, &expected).unwrap();
    let text = String::from_utf8(buf).unwrap();

    let (columns, rows) = read_csv(&text).unwrap();
    assert_eq!(columns, schema.node_columns);
    let mut sorted = expected.clone();
    sorted.sort_by(|a, b| a[id_key].as_scalar("").unwrap().cmp(b[id_key].as_scalar("").unwrap()));
    assert_eq!(rows, sorted);
}

#[test]
fn edge_rows_round_trip_through_csv() {
    let schema = CanonicalSchema::canonical().unwrap();
    let graph = Graph::from_json(FIXTURE).unwrap();
    let expected: Vec<Row> = graph
        .edges
        .iter()
        .map(|r| complete(&schema.edge_columns, r))
        .collect();

    let mut buf: Vec<u8> = Vec::new();
    write_csv_edge_rows(&mut buf, &schema.edge_columns, &expected).unwrap();
    let text = String::from_utf8(buf).unwrap();

    let (columns, rows) = read_csv(&text).unwrap();
    assert_eq!(columns, schema.edge_columns);
    assert_eq!(rows.len(), expected.len());
}

#[test]
fn a_corpus_seeded_from_csv_re_exports_byte_identically() {
    let schema = CanonicalSchema::canonical().unwrap();
    let graph = Graph::from_json(FIXTURE).unwrap();

    // First projection to CSV.
    let nodes_csv = nodes_to_csv(&schema, &graph).unwrap();
    let edges_csv = edges_to_csv(&schema, &graph).unwrap();

    // Seed a fresh corpus from that CSV, then re-export.
    let seeded = graph_from_csv(&nodes_csv, &edges_csv).unwrap();
    let nodes_csv_again = nodes_to_csv(&schema, &seeded).unwrap();
    let edges_csv_again = edges_to_csv(&schema, &seeded).unwrap();

    assert_eq!(nodes_csv, nodes_csv_again, "node CSV re-export diverged");
    assert_eq!(edges_csv, edges_csv_again, "edge CSV re-export diverged");
}

#[test]
fn csv_is_comma_delimited_with_rfc4180_quoting() {
    let schema = CanonicalSchema::canonical().unwrap();
    let graph = Graph::from_json(FIXTURE).unwrap();
    let nodes_csv = nodes_to_csv(&schema, &graph).unwrap();

    // The header is comma-, not tab-delimited.
    let header = nodes_csv.lines().next().unwrap();
    assert!(header.starts_with("csid:ID,:LABEL,"));
    assert!(!header.contains('\t'));
}

#[test]
fn a_field_bearing_a_comma_or_quote_round_trips_via_quoting() {
    let schema = CanonicalSchema::canonical().unwrap();
    // A node whose name carries a comma and a double quote — the CSV special chars.
    let json = r#"{
        "nodes": [
            {
                "csid": "cs:dish:x",
                ":LABEL": ["Cuisine"],
                "name": "Ragù \"alla, bolognese\"",
                "aliases": ["a,b", "c\"d"],
                "source": "editorial",
                "license": "CC0"
            }
        ],
        "edges": []
    }"#;
    let graph = Graph::from_json(json).unwrap();
    let nodes_csv = nodes_to_csv(&schema, &graph).unwrap();

    // The name field is quoted (it holds a comma and a quote) with the quote doubled.
    assert!(nodes_csv.contains("\"Ragù \"\"alla, bolognese\"\"\""));

    // An empty (header-only) edge CSV, so graph_from_csv has a valid edge header.
    let mut buf: Vec<u8> = Vec::new();
    write_csv_edge_rows(&mut buf, &schema.edge_columns, &[]).unwrap();
    let edges_csv = String::from_utf8(buf).unwrap();

    let seeded = graph_from_csv(&nodes_csv, &edges_csv).unwrap();
    let row = &seeded.nodes[0];
    assert_eq!(row["name"], Cell::Scalar("Ragù \"alla, bolognese\"".into()));
    assert_eq!(
        row["aliases"],
        Cell::Multi(vec!["a,b".into(), "c\"d".into()])
    );
}
