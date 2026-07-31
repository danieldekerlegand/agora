//! WASM (wasm-bindgen) bindings for agora's translation core.
//!
//! This crate is the embeddable-first facade for TypeScript consumers — the
//! console, any TS participant, anything running on Node or in a browser. It exposes
//! the full canonical-graph translation matrix
//! (`toTsv`/`toCsv`/`toCypher`/`toProlog`/`toSouffle`/`toProblog`) so a TS caller
//! translates *in-process* with zero network hop. It is one facade over the single
//! [`translation_core`] implementation — no second codec lives here — so its bytes
//! are identical to the native crate's for the same input (verified in
//! `crates/wasm/test.js` against the US-2/US-3 goldens).
//!
//! The whole surface is pure in-memory serde: a canonical graph goes in as JSON
//! text, translated bytes come out as strings. There is no wasm-side filesystem or
//! network dependency, so the module is self-contained.

use translation_core as core;
use wasm_bindgen::prelude::*;

/// Load the pinned canonical schema, mapping a core error to a JS exception.
fn schema() -> Result<core::CanonicalSchema, JsError> {
    core::CanonicalSchema::canonical().map_err(to_js)
}

/// Parse the JSON interchange form of a canonical graph.
fn graph(graph_json: &str) -> Result<core::Graph, JsError> {
    core::Graph::from_json(graph_json).map_err(to_js)
}

/// Render any error to a JS exception carrying its display message.
fn to_js<E: std::fmt::Display>(err: E) -> JsError {
    JsError::new(&err.to_string())
}

/// Serialize a serde value to a JSON string, mapping the (unreachable) error to JS.
fn to_json<T: serde::Serialize>(value: &T) -> Result<String, JsError> {
    serde_json::to_string(value).map_err(to_js)
}

/// Translate a canonical graph (JSON) to canonical TSV. Returns a JSON object
/// `{"nodes": <tsv>, "edges": <tsv>}` — the two sharded TSV documents culture-scrape
/// writes as `nodes/*.tsv` and `edges/*.tsv`, byte-identical to the native crate.
#[wasm_bindgen(js_name = toTsv)]
pub fn to_tsv(graph_json: &str) -> Result<String, JsError> {
    let (schema, graph) = (schema()?, graph(graph_json)?);
    let nodes = core::nodes_to_tsv(&schema, &graph).map_err(to_js)?;
    let edges = core::edges_to_tsv(&schema, &graph).map_err(to_js)?;
    to_json(&NodesEdges { nodes, edges })
}

/// Translate a canonical graph (JSON) to the Neo4j-import CSV form. Returns a JSON
/// object `{"nodes": <csv>, "edges": <csv>}`.
#[wasm_bindgen(js_name = toCsv)]
pub fn to_csv(graph_json: &str) -> Result<String, JsError> {
    let (schema, graph) = (schema()?, graph(graph_json)?);
    let nodes = core::nodes_to_csv(&schema, &graph).map_err(to_js)?;
    let edges = core::edges_to_csv(&schema, &graph).map_err(to_js)?;
    to_json(&NodesEdges { nodes, edges })
}

/// Translate a canonical graph (JSON) to an incremental `LOAD CSV ... MERGE` Cypher
/// load script (the `neo4j/load_csv.py` projection).
#[wasm_bindgen(js_name = toCypher)]
pub fn to_cypher(graph_json: &str) -> Result<String, JsError> {
    let (schema, graph) = (schema()?, graph(graph_json)?);
    core::graph_to_load_script(&schema, &graph).map_err(to_js)
}

/// Translate a canonical graph (JSON) to a loadable SWI-Prolog program (`graph.pl`).
#[wasm_bindgen(js_name = toProlog)]
pub fn to_prolog(graph_json: &str) -> Result<String, JsError> {
    let (schema, graph) = (schema()?, graph(graph_json)?);
    core::graph_to_prolog(&schema, &graph).map_err(to_js)
}

/// Translate a canonical graph (JSON) to a Soufflé program. Returns a JSON object
/// `{"program": <graph.dl>, "facts": {"<predicate>": <body>, ...}}`.
#[wasm_bindgen(js_name = toSouffle)]
pub fn to_souffle(graph_json: &str) -> Result<String, JsError> {
    let (schema, graph) = (schema()?, graph(graph_json)?);
    let program = core::graph_to_souffle(&schema, &graph).map_err(to_js)?;
    to_json(&SouffleOut {
        program: program.program,
        facts: program.facts,
    })
}

/// Translate a canonical graph (JSON) to a ProbLog program (`graph.problog.pl`),
/// the confidence riding as a `W::` probability on the edge relation only.
#[wasm_bindgen(js_name = toProblog)]
pub fn to_problog(graph_json: &str) -> Result<String, JsError> {
    let (schema, graph) = (schema()?, graph(graph_json)?);
    core::graph_to_problog(&schema, &graph).map_err(to_js)
}

/// The `{nodes, edges}` shape shared by the sharded TSV and CSV facades.
#[derive(serde::Serialize)]
struct NodesEdges {
    nodes: String,
    edges: String,
}

/// The `{program, facts}` shape of a rendered Soufflé program (mirrors
/// `translation_core::SouffleProgram`, which does not derive `Serialize`).
#[derive(serde::Serialize)]
struct SouffleOut {
    program: String,
    facts: std::collections::BTreeMap<String, String>,
}
