//! Driver-side cursor export back to canonical TSV — a port of `neo4j/export.py`.
//!
//! This closes the round trip the import path opens: having seeded a graph from
//! `nodes/*.tsv` and `edges/*.tsv`, we pull it back out into byte-stable canonical
//! TSV. Rather than a server-side APOC export, culture-scrape uses a **driver-side
//! cursor export** — streaming nodes and relationships over the Bolt connection and
//! writing them locally with the same lossless TSV writers. The port keeps that shape
//! but stays embeddable: a [`GraphCursor`] abstracts the two primitive-only queries
//! ([`NODE_QUERY`] / [`EDGE_QUERY`]) so a fake in-memory cursor exercises it exactly
//! as culture-scrape mocks its driver, and the output is returned in memory rather
//! than written to disk.
//!
//! Files are grouped and named by type: nodes go to `nodes/<label>.tsv` keyed on
//! their primary (alphabetically-first) type label, with the [`ENTITY_LABEL`] base
//! label dropped and the remaining labels sorted in the `:LABEL` cell; relationships
//! go to `edges/<type>.tsv` keyed on their `:TYPE`. Every shard carries the full
//! canonical header and canonical sort order.

use super::ENTITY_LABEL;
use crate::error::Error;
use crate::graph::{Cell, Row};
use crate::schema::CanonicalSchema;
use crate::tsv::{write_edge_rows, write_node_rows, MULTI_VALUE_KEYS};
use std::collections::BTreeMap;

/// Cypher streaming every node as `(labels, properties)` primitive pairs.
pub const NODE_QUERY: &str = "MATCH (n) RETURN labels(n) AS labels, properties(n) AS props";

/// Cypher streaming every relationship as endpoint ids, type, and properties.
pub const EDGE_QUERY: &str = "MATCH (a)-[r]->(b) \
     RETURN a.csid AS start, b.csid AS end, type(r) AS type, properties(r) AS props";

/// A property value the driver returns — a native scalar or a list.
///
/// Neo4j returns typed values over Bolt (ints, floats, strings, lists); the exporter
/// stringifies each to the text form the typed canonical header (`time_start:int`,
/// `lat:float`) reads it back into. Mirrors culture-scrape's `_scalar(value) = str(value)`.
#[derive(Debug, Clone, PartialEq)]
pub enum PropValue {
    /// A string value, carried verbatim.
    Str(String),
    /// A signed integer (a year; negative = BCE).
    Int(i64),
    /// A floating-point value (a coordinate, a weight/confidence).
    Float(f64),
    /// A list value (the multi-value `aliases` column).
    List(Vec<PropValue>),
}

impl PropValue {
    /// This value as its canonical TSV string (`str(value)` in the reference).
    fn scalar(&self) -> String {
        match self {
            PropValue::Str(s) => s.clone(),
            PropValue::Int(i) => i.to_string(),
            PropValue::Float(f) => float_scalar(*f),
            // A list in scalar position stringifies elementwise; only reached if a
            // non-multi column is handed a list (the multi path handles the rest).
            PropValue::List(items) => items
                .iter()
                .map(PropValue::scalar)
                .collect::<Vec<_>>()
                .join(","),
        }
    }
}

/// Render `f` the way Python's `str(float)` does — shortest round-trip, always with a
/// decimal point (`1.0`, never `1`), so a whole-valued float keeps its `:float` shape.
fn float_scalar(f: f64) -> String {
    let text = format!("{f}");
    if text.contains('.') || text.contains('e') || text.contains("inf") || text.contains("NaN") {
        text
    } else {
        format!("{text}.0")
    }
}

/// One node as the driver returns it (`labels(n)`, `properties(n)`).
#[derive(Debug, Clone, PartialEq)]
pub struct Neo4jNode {
    pub labels: Vec<String>,
    pub props: BTreeMap<String, PropValue>,
}

/// One relationship as the driver returns it (endpoint csids, `:TYPE`, properties).
#[derive(Debug, Clone, PartialEq)]
pub struct Neo4jEdge {
    pub start: String,
    pub end: String,
    pub edge_type: String,
    pub props: BTreeMap<String, PropValue>,
}

/// A read cursor over a graph — the two primitive-only queries the exporter runs.
///
/// A live implementation streams these over Bolt; a fake one replays fixture records,
/// exactly as culture-scrape mocks its driver.
pub trait GraphCursor {
    /// The records [`NODE_QUERY`] returns.
    fn nodes(&self) -> Vec<Neo4jNode>;
    /// The records [`EDGE_QUERY`] returns.
    fn edges(&self) -> Vec<Neo4jEdge>;
}

/// What an [`export_to_tsv`] run produced: the shard bodies plus row counts.
///
/// Shards are returned in memory (label/`:TYPE` → TSV body) rather than written to
/// disk, keeping the core embeddable; a caller across a filesystem boundary writes
/// each `nodes/<label>.tsv` / `edges/<type>.tsv` itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportResult {
    /// Node shards keyed by primary label (`<label>` → `nodes/<label>.tsv` body).
    pub node_files: BTreeMap<String, String>,
    /// Edge shards keyed by `:TYPE` (`<type>` → `edges/<type>.tsv` body).
    pub edge_files: BTreeMap<String, String>,
    /// Total node rows written across all shards.
    pub node_count: usize,
    /// Total edge rows written across all shards.
    pub edge_count: usize,
}

/// Map one graph node to its primary type label and a writable TSV row (`_node_row`).
///
/// The shared [`ENTITY_LABEL`] anchor is dropped and the remaining labels are sorted;
/// the first becomes the shard key and all of them populate the `:LABEL` cell.
/// Multi-value properties (`aliases`) stay lists; every other value is stringified.
fn node_row(node: &Neo4jNode) -> Result<(String, Row), Error> {
    let mut type_labels: Vec<String> = node
        .labels
        .iter()
        .filter(|label| label.as_str() != ENTITY_LABEL)
        .cloned()
        .collect();
    type_labels.sort();
    if type_labels.is_empty() {
        let csid = node
            .props
            .get("csid")
            .map(PropValue::scalar)
            .unwrap_or_else(|| "<unknown>".to_string());
        return Err(Error::Neo4j(format!(
            "node {csid:?} has no type label beyond {ENTITY_LABEL:?}"
        )));
    }
    let mut row = Row::new();
    row.insert(":LABEL".to_string(), Cell::Multi(type_labels.clone()));
    for (key, value) in &node.props {
        if MULTI_VALUE_KEYS.contains(&key.as_str()) {
            let parts = match value {
                PropValue::List(items) => items.iter().map(PropValue::scalar).collect(),
                other => vec![other.scalar()],
            };
            row.insert(key.clone(), Cell::Multi(parts));
        } else {
            row.insert(key.clone(), Cell::Scalar(value.scalar()));
        }
    }
    Ok((type_labels[0].clone(), row))
}

/// Map one relationship to its `:TYPE` and a writable TSV row (`_edge_row`).
fn edge_row(edge: &Neo4jEdge) -> Row {
    let mut row = Row::new();
    row.insert(":START_ID".to_string(), Cell::Scalar(edge.start.clone()));
    row.insert(":END_ID".to_string(), Cell::Scalar(edge.end.clone()));
    row.insert(":TYPE".to_string(), Cell::Scalar(edge.edge_type.clone()));
    for (key, value) in &edge.props {
        row.insert(key.clone(), Cell::Scalar(value.scalar()));
    }
    row
}

/// Reconstruct the `labels(n)` / `properties(n)` records a driver returns from an
/// in-memory canonical node row — the embeddable stand-in for a live Bolt read.
///
/// Every non-`:LABEL` cell becomes a property (a scalar as a string, a multi-value
/// cell as a list, exactly the shapes [`export_to_tsv`] stringifies back), and the
/// [`ENTITY_LABEL`] anchor is appended to the label set so the export's drop-and-sort
/// runs the same way it does on a real graph. The output is independent of the input
/// label order (the export sorts), so a round-tripped row re-exports identically.
fn node_from_row(row: &Row) -> Neo4jNode {
    let mut labels: Vec<String> = Vec::new();
    let mut props: BTreeMap<String, PropValue> = BTreeMap::new();
    for (key, cell) in row {
        if key == ":LABEL" {
            match cell {
                Cell::Multi(values) => labels.extend(values.iter().cloned()),
                Cell::Scalar(value) => labels.push(value.clone()),
            }
            continue;
        }
        props.insert(key.clone(), prop_from_cell(cell));
    }
    labels.push(ENTITY_LABEL.to_string());
    Neo4jNode { labels, props }
}

/// Reconstruct the endpoint/type/properties record a driver returns from an in-memory
/// canonical edge row.
fn edge_from_row(row: &Row) -> Result<Neo4jEdge, Error> {
    let endpoint = |key: &str| -> Result<String, Error> {
        match row.get(key) {
            Some(Cell::Scalar(value)) => Ok(value.clone()),
            Some(Cell::Multi(_)) => Err(Error::Neo4j(format!("edge column {key:?} must be scalar"))),
            None => Err(Error::Neo4j(format!("edge row is missing {key:?}"))),
        }
    };
    let start = endpoint(":START_ID")?;
    let end = endpoint(":END_ID")?;
    let edge_type = endpoint(":TYPE")?;
    let mut props: BTreeMap<String, PropValue> = BTreeMap::new();
    for (key, cell) in row {
        if matches!(key.as_str(), ":START_ID" | ":END_ID" | ":TYPE") {
            continue;
        }
        props.insert(key.clone(), prop_from_cell(cell));
    }
    Ok(Neo4jEdge {
        start,
        end,
        edge_type,
        props,
    })
}

/// A canonical cell as the property value a driver would return for it.
fn prop_from_cell(cell: &Cell) -> PropValue {
    match cell {
        Cell::Scalar(value) => PropValue::Str(value.clone()),
        Cell::Multi(values) => {
            PropValue::List(values.iter().map(|v| PropValue::Str(v.clone())).collect())
        }
    }
}

/// Export an in-memory canonical [`Graph`] to sharded canonical TSV — the embeddable
/// equivalent of `neo4j/export.py` with no live driver.
///
/// Each canonical row is reconstructed into the `labels(n)` / `properties(n)` /
/// `type(r)` shape a Bolt cursor returns after a `load_csv` import, then handed to the
/// same [`export_to_tsv`] streaming pass. So a caller that imported a dataset and
/// exported it back through Neo4j gets byte-identical shards to one that never left the
/// process — one export implementation, two entry points.
pub fn graph_to_neo4j_export(
    schema: &CanonicalSchema,
    graph: &crate::graph::Graph,
) -> Result<ExportResult, Error> {
    struct GraphView {
        nodes: Vec<Neo4jNode>,
        edges: Vec<Neo4jEdge>,
    }
    impl GraphCursor for GraphView {
        fn nodes(&self) -> Vec<Neo4jNode> {
            self.nodes.clone()
        }
        fn edges(&self) -> Vec<Neo4jEdge> {
            self.edges.clone()
        }
    }
    let nodes = graph.nodes.iter().map(node_from_row).collect();
    let edges = graph
        .edges
        .iter()
        .map(edge_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    export_to_tsv(schema, &GraphView { nodes, edges })
}

/// Export a graph read over `cursor` to canonical TSV, sharded by label / `:TYPE`.
///
/// Nodes and edges are streamed and written in **separate passes** (the node buckets
/// released before the edge buckets are grouped), so peak memory is the larger of the
/// two shards, not the whole graph — the same streaming shape as the reference.
pub fn export_to_tsv<C: GraphCursor>(
    schema: &CanonicalSchema,
    cursor: &C,
) -> Result<ExportResult, Error> {
    let id_key = schema.node_id_key()?;

    let mut node_groups: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    for node in cursor.nodes() {
        let (label, row) = node_row(&node)?;
        node_groups.entry(label).or_default().push(row);
    }
    let mut node_files: BTreeMap<String, String> = BTreeMap::new();
    let mut node_count = 0;
    for (label, rows) in &node_groups {
        let mut buf: Vec<u8> = Vec::new();
        node_count += write_node_rows(&mut buf, &schema.node_columns, id_key, rows)?;
        node_files.insert(label.clone(), String::from_utf8(buf).expect("TSV output is UTF-8"));
    }
    drop(node_groups); // release node shards before grouping edges

    let mut edge_groups: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    for edge in cursor.edges() {
        edge_groups
            .entry(edge.edge_type.clone())
            .or_default()
            .push(edge_row(&edge));
    }
    let mut edge_files: BTreeMap<String, String> = BTreeMap::new();
    let mut edge_count = 0;
    for (ty, rows) in &edge_groups {
        let mut buf: Vec<u8> = Vec::new();
        edge_count += write_edge_rows(&mut buf, &schema.edge_columns, rows)?;
        edge_files.insert(ty.clone(), String::from_utf8(buf).expect("TSV output is UTF-8"));
    }

    Ok(ExportResult {
        node_files,
        edge_files,
        node_count,
        edge_count,
    })
}
