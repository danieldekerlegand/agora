//! agora's data-translation engine — the native Rust core.
//!
//! This crate is the one place in the commons where Rust earns its keep: CPU-bound
//! serde over the koine canonical node/edge graph. It is a faithful, byte-compatible
//! port of pinakes's culture-scrape exporters. US-1 establishes the foundation — the
//! canonical graph model, the schema read as data from `canonical-schema.json`, and
//! the lossless TSV codec. Later stories add the logic-program emitters (US-2), the
//! Neo4j/Cypher projections (US-3), and the WASM/PyO3/HTTP facades (US-4..6).
//!
//! Embeddable-first: the whole matrix is pure in-memory serde with no filesystem or
//! network dependency, so TS (WASM) and Python (PyO3) consumers translate locally
//! with zero network hop.

#![deny(clippy::all)]

mod error;
mod graph;
mod schema;
mod tsv;

pub use error::Error;
pub use graph::{Cell, Graph, Row};
pub use schema::{
    parse_column, CanonicalSchema, Column, EdgeType, NodeType, PropertyType, DELIMITER,
};
pub use tsv::{
    decode_value, decode_values, encode_value, encode_values, read_rows, write_edge_rows,
    write_node_rows, write_rows, MULTI_VALUE_KEYS,
};

/// Render a graph's nodes to canonical TSV (sorted by the id column).
pub fn nodes_to_tsv(schema: &CanonicalSchema, graph: &Graph) -> Result<String, Error> {
    let id_key = schema.node_id_key()?;
    let mut buf: Vec<u8> = Vec::new();
    write_node_rows(&mut buf, &schema.node_columns, id_key, &graph.nodes)?;
    Ok(String::from_utf8(buf).expect("TSV output is UTF-8"))
}

/// Render a graph's edges to canonical TSV (sorted by `(:START_ID, :END_ID, :TYPE)`).
pub fn edges_to_tsv(schema: &CanonicalSchema, graph: &Graph) -> Result<String, Error> {
    let mut buf: Vec<u8> = Vec::new();
    write_edge_rows(&mut buf, &schema.edge_columns, &graph.edges)?;
    Ok(String::from_utf8(buf).expect("TSV output is UTF-8"))
}
