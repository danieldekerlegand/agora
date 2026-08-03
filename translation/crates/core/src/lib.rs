//! agora's data-translation engine — the native Rust core.
//!
//! This crate is the one place in the commons where Rust earns its keep: CPU-bound
//! serde over the koine canonical node/edge graph. It is a faithful, byte-compatible
//! port of the culture-scrape exporters it was extracted from (attribution, not a
//! dependency — nothing here dials or names a producer). US-1 establishes the
//! foundation — the canonical graph model, the schema read as *data* (the bundled
//! `canonical-schema.json` is a working sample; any well-formed vocabulary parses),
//! and the lossless TSV codec. Later stories add the logic-program emitters (US-2),
//! the Neo4j/Cypher projections (US-3), and the WASM/PyO3/HTTP facades (US-4..6).
//!
//! Embeddable-first: the whole matrix is pure in-memory serde with no filesystem or
//! network dependency, so TS (WASM) and Python (PyO3) consumers translate locally
//! with zero network hop.
//!
//! Beside the knowledge-plane matrix sits the **media-timeline path** ([`media`]), which
//! is deliberately *not* a codec of ours: KMI §4 adopts OpenTimelineIO, so a timeline is
//! an OTIO document carried whole, and every conversion — CMX3600, FCP, AAF — is run by
//! OTIO's own adapters through the engine's Python facade. See [`media`] for the
//! mechanism and why there is no Rust binding to link. What agora *does* own on that path
//! is koine's additive layer over OTIO ([`media::koine`]): content-addressed asset
//! identity, the asset-lineage graph, and the analysis → knowledge bridge that turns media
//! findings into KGP assertions on this crate's own fact vocabulary.

#![deny(clippy::all)]

mod csv;
pub mod datalog;
mod error;
mod graph;
pub mod media;
pub mod neo4j;
mod schema;
mod tsv;

pub use datalog::{
    annotate_edge_group, edge_facts, facts_for_graph, node_facts, predicate_for_type,
    problog_facts_for_graph, render_annotated_fact, render_atom, render_fact,
    render_problog_program, render_program, render_souffle_program, souffle_facts,
    write_problog_program, write_program, write_souffle_facts, AnnotatedFact, Atom, Dialect, Fact,
    Relation, PROBLOG_PROGRAM_NAME, PROLOG_PROGRAM_NAME, SOUFFLE_PROGRAM_NAME,
};
pub use csv::{
    edges_to_csv, graph_from_csv, nodes_to_csv, read_csv, write_csv_edge_rows, write_csv_node_rows,
    write_csv_rows,
};
pub use error::Error;
pub use graph::{Cell, Graph, Row};
pub use media::{
    analysis_assertions, assertion_facts, AnalysisObservation, AssetEnvelope, AssetId,
    AssetReference, Assertion, Clip, LineageGraph, LineageLink, LineageRelation, MediaMap,
    MediaReference, NleAdapter, RationalTime, TimeRange, Timeline, Track,
    ANALYSIS_BRIDGE_INPUT_PLANE, ANALYSIS_BRIDGE_OUTPUT_PLANE, ASSET_KIND, DEFAULT_MEDIA_KEY,
    KMI_VERSION, KOINE_METADATA_KEY, LEGACY_EDL_MEDIA_TYPE, LINEAGE_DOMAIN, NLE_ADAPTERS,
    OTIO_BUNDLE_MEDIA_TYPE, OTIO_JSON_ADAPTER, OTIO_MEDIA_TYPE,
};
pub use neo4j::{
    build_statements, edge_cypher, export_to_tsv, graph_to_load_script, graph_to_neo4j_export,
    node_cypher, render_load_script, CypherStatement, ExportResult, GraphCursor, Neo4jEdge,
    Neo4jNode, PropValue, EDGE_QUERY, ENTITY_LABEL, NODE_QUERY,
};
pub use schema::{
    parse_column, CanonicalSchema, Column, EdgeType, NodeType, PropertyType, DELIMITER,
};
pub use tsv::{
    decode_value, decode_values, encode_value, encode_values, read_rows, write_edge_rows,
    write_node_rows, write_rows, MULTI_VALUE_KEYS,
};

use std::collections::BTreeMap;

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

/// Render a graph to a loadable SWI-Prolog program (`graph.pl`).
pub fn graph_to_prolog(schema: &CanonicalSchema, graph: &Graph) -> Result<String, Error> {
    render_program(&facts_for_graph(schema, graph)?)
}

/// Render a graph to a ProbLog probabilistic program (`graph.problog.pl`).
pub fn graph_to_problog(schema: &CanonicalSchema, graph: &Graph) -> Result<String, Error> {
    render_problog_program(&problog_facts_for_graph(schema, graph)?)
}

/// A rendered Soufflé program: the `.dl` source plus one `<predicate>.facts` body
/// per relation (keyed by predicate).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SouffleProgram {
    /// The `graph.dl` source (declarations + I/O directives).
    pub program: String,
    /// One `<predicate>.facts` file body per relation.
    pub facts: BTreeMap<String, String>,
}

/// Render a graph to a runnable Soufflé program (`graph.dl` + its `.facts` files).
pub fn graph_to_souffle(schema: &CanonicalSchema, graph: &Graph) -> Result<SouffleProgram, Error> {
    let facts = facts_for_graph(schema, graph)?;
    Ok(SouffleProgram {
        program: render_souffle_program(&facts)?,
        facts: souffle_facts(&facts)?,
    })
}
