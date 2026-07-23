//! Neo4j projections — the Cypher import script and the driver-cursor export.
//!
//! Two faithful ports of culture-scrape's `neo4j/` package:
//!
//! * [`load_csv`] ports `neo4j/load_csv.py` — idempotent `LOAD CSV ... MERGE` Cypher
//!   that re-imports a canonical dataset into a live graph without duplicating nodes
//!   or relationships. Node statements `MERGE` on `csid` under the shared
//!   [`ENTITY_LABEL`] anchor and reattach the `:LABEL` cell with
//!   `apoc.create.addLabels`; edge statements `apoc.merge.relationship` on the
//!   data-driven `:TYPE`.
//! * [`export`] ports `neo4j/export.py` — a driver-side cursor export that streams a
//!   live graph back to canonical TSV, sharded into `nodes/<label>.tsv` and
//!   `edges/<type>.tsv`, closing the round trip the import path opens.

pub mod export;
pub mod load_csv;

/// The shared base label every node carries in Neo4j; the anchor for the global
/// `csid` uniqueness constraint (`constraints.ENTITY_LABEL`).
pub const ENTITY_LABEL: &str = "Entity";

pub use export::{
    export_to_tsv, ExportResult, GraphCursor, Neo4jEdge, Neo4jNode, PropValue, EDGE_QUERY,
    NODE_QUERY,
};
pub use load_csv::{
    build_statements, edge_cypher, graph_to_load_script, node_cypher, render_load_script,
    CypherStatement, ARRAY_DELIMITER, FIELD_TERMINATOR, FILE_PARAM, SCRIPT_NAME,
};
