//! PyO3 bindings for agora's translation core.
//!
//! This crate is the embeddable-first facade for Python consumers — pinakes and analyzer
//! call the engine *in-process* with zero network hop, dropping in for the pure-Python
//! culture-scrape exporters. It exposes the full canonical-graph translation matrix
//! (`to_tsv`/`to_csv`/`to_cypher`/`to_prolog`/`to_souffle`/`to_problog`) plus the two
//! higher-level exporters that return the culture-scrape result shapes: `to_datalog`
//! (with `fact_count`, mirroring `datalog/export.py`'s `export_dataset`) and
//! `to_neo4j_export` (with `node_count`/`edge_count`, mirroring `neo4j/export.py`'s
//! `export_to_tsv`).
//!
//! It is one facade over the single [`translation_core`] implementation — no second
//! codec lives here — so its bytes are identical to the native crate's (and,
//! transitively, culture-scrape's) for the same input, proven in
//! `crates/py/tests/test_parity.py` against the committed goldens. The whole surface
//! is pure in-memory serde: a canonical graph goes in as a JSON string, translated
//! bytes come out as `str`; the extension imports nothing outside its own package at
//! runtime.

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyDict;
use translation_core as core;

/// Map any core error to a Python `ValueError` carrying its display message.
fn to_py<E: std::fmt::Display>(err: E) -> PyErr {
    PyValueError::new_err(err.to_string())
}

/// Load the pinned canonical schema and parse the JSON interchange graph.
fn schema_and_graph(graph_json: &str) -> PyResult<(core::CanonicalSchema, core::Graph)> {
    let schema = core::CanonicalSchema::canonical().map_err(to_py)?;
    let graph = core::Graph::from_json(graph_json).map_err(to_py)?;
    Ok((schema, graph))
}

/// A `{predicate: body}` dict from a `BTreeMap` of `.facts` shard bodies.
fn shards<'py>(
    py: Python<'py>,
    files: std::collections::BTreeMap<String, String>,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    for (key, body) in files {
        dict.set_item(key, body)?;
    }
    Ok(dict)
}

/// Translate a canonical graph (JSON) to canonical TSV — `{"nodes": <tsv>, "edges":
/// <tsv>}`, the two sharded documents culture-scrape writes as `nodes/*.tsv` and
/// `edges/*.tsv`.
#[pyfunction]
fn to_tsv<'py>(py: Python<'py>, graph_json: &str) -> PyResult<Bound<'py, PyDict>> {
    let (schema, graph) = schema_and_graph(graph_json)?;
    let dict = PyDict::new(py);
    dict.set_item("nodes", core::nodes_to_tsv(&schema, &graph).map_err(to_py)?)?;
    dict.set_item("edges", core::edges_to_tsv(&schema, &graph).map_err(to_py)?)?;
    Ok(dict)
}

/// Translate a canonical graph (JSON) to the Neo4j-import CSV form — `{"nodes": <csv>,
/// "edges": <csv>}`.
#[pyfunction]
fn to_csv<'py>(py: Python<'py>, graph_json: &str) -> PyResult<Bound<'py, PyDict>> {
    let (schema, graph) = schema_and_graph(graph_json)?;
    let dict = PyDict::new(py);
    dict.set_item("nodes", core::nodes_to_csv(&schema, &graph).map_err(to_py)?)?;
    dict.set_item("edges", core::edges_to_csv(&schema, &graph).map_err(to_py)?)?;
    Ok(dict)
}

/// Translate a canonical graph (JSON) to an incremental `LOAD CSV ... MERGE` Cypher
/// load script (the `neo4j/load_csv.py` projection).
#[pyfunction]
fn to_cypher(graph_json: &str) -> PyResult<String> {
    let (schema, graph) = schema_and_graph(graph_json)?;
    core::graph_to_load_script(&schema, &graph).map_err(to_py)
}

/// Translate a canonical graph (JSON) to a loadable SWI-Prolog program (`graph.pl`).
#[pyfunction]
fn to_prolog(graph_json: &str) -> PyResult<String> {
    let (schema, graph) = schema_and_graph(graph_json)?;
    core::graph_to_prolog(&schema, &graph).map_err(to_py)
}

/// Translate a canonical graph (JSON) to a Soufflé program — `{"program": <graph.dl>,
/// "facts": {"<predicate>": <body>, ...}}`.
#[pyfunction]
fn to_souffle<'py>(py: Python<'py>, graph_json: &str) -> PyResult<Bound<'py, PyDict>> {
    let (schema, graph) = schema_and_graph(graph_json)?;
    let program = core::graph_to_souffle(&schema, &graph).map_err(to_py)?;
    let dict = PyDict::new(py);
    dict.set_item("program", program.program)?;
    dict.set_item("facts", shards(py, program.facts)?)?;
    Ok(dict)
}

/// Translate a canonical graph (JSON) to a ProbLog program (`graph.problog.pl`), the
/// confidence riding as a `W::` probability on the edge relation only.
#[pyfunction]
fn to_problog(graph_json: &str) -> PyResult<String> {
    let (schema, graph) = schema_and_graph(graph_json)?;
    core::graph_to_problog(&schema, &graph).map_err(to_py)
}

/// Export a canonical graph (JSON) to one or more logic programs — the `export_dataset`
/// shape. Returns `{"fact_count": int, "prolog": <graph.pl>, "problog":
/// <graph.problog.pl>, "souffle": {"program": ..., "facts": {...}}}`, `fact_count`
/// being the number of facts projected (shared by every engine, as in the reference).
#[pyfunction]
fn to_datalog<'py>(py: Python<'py>, graph_json: &str) -> PyResult<Bound<'py, PyDict>> {
    let (schema, graph) = schema_and_graph(graph_json)?;
    let facts = core::facts_for_graph(&schema, &graph).map_err(to_py)?;
    let souffle = core::graph_to_souffle(&schema, &graph).map_err(to_py)?;

    let dict = PyDict::new(py);
    dict.set_item("fact_count", facts.len())?;
    dict.set_item("prolog", core::graph_to_prolog(&schema, &graph).map_err(to_py)?)?;
    dict.set_item("problog", core::graph_to_problog(&schema, &graph).map_err(to_py)?)?;
    let souffle_dict = PyDict::new(py);
    souffle_dict.set_item("program", souffle.program)?;
    souffle_dict.set_item("facts", shards(py, souffle.facts)?)?;
    dict.set_item("souffle", souffle_dict)?;
    Ok(dict)
}

/// Export a canonical graph (JSON) back to sharded canonical TSV — the `export_to_tsv`
/// shape. Returns `{"node_count": int, "edge_count": int, "node_files": {"<label>":
/// <tsv>, ...}, "edge_files": {"<type>": <tsv>, ...}}`, the shards a driver-side Neo4j
/// export writes as `nodes/<label>.tsv` / `edges/<type>.tsv`.
#[pyfunction]
fn to_neo4j_export<'py>(py: Python<'py>, graph_json: &str) -> PyResult<Bound<'py, PyDict>> {
    let (schema, graph) = schema_and_graph(graph_json)?;
    let result = core::graph_to_neo4j_export(&schema, &graph).map_err(to_py)?;
    let dict = PyDict::new(py);
    dict.set_item("node_count", result.node_count)?;
    dict.set_item("edge_count", result.edge_count)?;
    dict.set_item("node_files", shards(py, result.node_files)?)?;
    dict.set_item("edge_files", shards(py, result.edge_files)?)?;
    Ok(dict)
}

/// The `translation_py` extension module — the full matrix, one facade over the core.
#[pymodule]
fn translation_py(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(to_tsv, m)?)?;
    m.add_function(wrap_pyfunction!(to_csv, m)?)?;
    m.add_function(wrap_pyfunction!(to_cypher, m)?)?;
    m.add_function(wrap_pyfunction!(to_prolog, m)?)?;
    m.add_function(wrap_pyfunction!(to_souffle, m)?)?;
    m.add_function(wrap_pyfunction!(to_problog, m)?)?;
    m.add_function(wrap_pyfunction!(to_datalog, m)?)?;
    m.add_function(wrap_pyfunction!(to_neo4j_export, m)?)?;
    Ok(())
}
