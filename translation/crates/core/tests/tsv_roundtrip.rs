//! `read(write(x)) == x` on a canonical fixture, plus escape-map unit coverage.

use std::collections::BTreeMap;
use translation_core::{
    decode_value, decode_values, encode_value, encode_values, read_rows, write_edge_rows,
    write_node_rows, CanonicalSchema, Cell, Column, Graph, Row,
};

const FIXTURE: &str = include_str!("../fixtures/graph.json");

/// Fill every scalar column absent from `row` with `""` and every multi-value
/// column with `[]`, so the record carries a value for every schema key. `write`
/// emits an empty cell for a missing key and `read` decodes it back to `""` / `[]`,
/// so only a *complete* record is a fixed point of `read ∘ write`.
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
fn escape_map_round_trips_the_control_chars() {
    // backslash -> \\, TAB -> \t, CR -> \r, LF -> \n, decoded by a single scan.
    let raw = "a\\b\tc\rd\ne";
    let encoded = encode_value(raw);
    assert_eq!(encoded, "a\\\\b\\tc\\rd\\ne");
    assert_eq!(decode_value(&encoded).unwrap(), raw);
}

#[test]
fn escaped_backslash_t_is_a_literal_backslash_t_not_a_tab() {
    // `\\t` must decode to a literal backslash-t, never a tab (the single-scan rule).
    let raw = "\\t";
    let encoded = encode_value(raw); // -> "\\\\t"
    assert_eq!(encoded, "\\\\t");
    assert_eq!(decode_value(&encoded).unwrap(), "\\t");
}

#[test]
fn multi_value_cells_escape_the_delimiter() {
    let values = vec!["a;b".to_string(), "plain".to_string(), "x\ty".to_string()];
    let encoded = encode_values(&values);
    assert_eq!(encoded, "a\\;b;plain;x\\ty");
    assert_eq!(decode_values(&encoded).unwrap(), values);
    // An empty cell is the canonical "no values".
    assert_eq!(decode_values("").unwrap(), Vec::<String>::new());
}

#[test]
fn dangling_and_invalid_escapes_are_rejected() {
    assert!(decode_value("abc\\").is_err());
    assert!(decode_value("a\\xb").is_err());
}

#[test]
fn node_rows_round_trip() {
    let schema = CanonicalSchema::canonical().unwrap();
    let graph = Graph::from_json(FIXTURE).unwrap();
    let expected: Vec<Row> = graph
        .nodes
        .iter()
        .map(|r| complete(&schema.node_columns, r))
        .collect();

    let id_key = schema.node_id_key().unwrap();
    let mut buf: Vec<u8> = Vec::new();
    write_node_rows(&mut buf, &schema.node_columns, id_key, &expected).unwrap();
    let text = String::from_utf8(buf).unwrap();

    let (columns, rows) = read_rows(&text).unwrap();
    assert_eq!(columns, schema.node_columns);
    // `expected` is sorted by csid; the writer emits in that order too.
    let mut sorted = expected.clone();
    sorted.sort_by(|a, b| a[id_key].as_scalar("").unwrap().cmp(b[id_key].as_scalar("").unwrap()));
    assert_eq!(rows, sorted);
}

#[test]
fn edge_rows_round_trip() {
    let schema = CanonicalSchema::canonical().unwrap();
    let graph = Graph::from_json(FIXTURE).unwrap();
    let expected: Vec<Row> = graph
        .edges
        .iter()
        .map(|r| complete(&schema.edge_columns, r))
        .collect();

    let mut buf: Vec<u8> = Vec::new();
    write_edge_rows(&mut buf, &schema.edge_columns, &expected).unwrap();
    let text = String::from_utf8(buf).unwrap();

    let (columns, rows) = read_rows(&text).unwrap();
    assert_eq!(columns, schema.edge_columns);
    let key = |r: &Row| {
        (
            r[":START_ID"].as_scalar("").unwrap().to_string(),
            r[":END_ID"].as_scalar("").unwrap().to_string(),
            r[":TYPE"].as_scalar("").unwrap().to_string(),
        )
    };
    let mut sorted = expected.clone();
    sorted.sort_by_key(&key);
    assert_eq!(rows, sorted);
}
