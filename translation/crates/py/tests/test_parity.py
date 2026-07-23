"""Byte-identity parity for the translation_py PyO3 bindings (US-5).

Asserts the extension's emitted TSV / datalog / neo4j-export bytes equal the committed
culture-scrape goldens under ``crates/core/fixtures/golden/`` — those goldens ARE the
reference exporters' output (``datalog/export.py``'s ``export_dataset``,
``neo4j/export.py``'s ``export_to_tsv``, ``schema/tsvio.py``'s writers), captured by
``tools/gen_golden.py``. So a green run proves a Python caller can drop in
``translation_py`` for the pure-Python culture-scrape exporters. One core, two facades:
these same goldens back the native Rust tests, so the PyO3 path produces the same bytes
as the native path.
"""

from __future__ import annotations

import importlib.machinery
from pathlib import Path

import pytest

import translation_py

CORE = Path(__file__).resolve().parents[2] / "core"
FIXTURES = CORE / "fixtures"
GOLDEN = FIXTURES / "golden"


def _golden(*parts: str) -> str:
    return GOLDEN.joinpath(*parts).read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def graph_json() -> str:
    return (FIXTURES / "graph.json").read_text(encoding="utf-8")


def test_to_tsv_matches_golden(graph_json: str) -> None:
    tsv = translation_py.to_tsv(graph_json)
    assert tsv["nodes"] == _golden("nodes.tsv")
    assert tsv["edges"] == _golden("edges.tsv")


def test_to_prolog_matches_golden(graph_json: str) -> None:
    assert translation_py.to_prolog(graph_json) == _golden("datalog", "graph.pl")


def test_to_problog_matches_golden(graph_json: str) -> None:
    assert translation_py.to_problog(graph_json) == _golden("datalog", "graph.problog.pl")


def test_to_souffle_matches_golden(graph_json: str) -> None:
    souffle = translation_py.to_souffle(graph_json)
    assert souffle["program"] == _golden("datalog", "graph.dl")
    for path in sorted((GOLDEN / "datalog" / "facts").glob("*.facts")):
        assert souffle["facts"][path.stem] == path.read_text(encoding="utf-8")


def test_to_datalog_result_shape_and_bytes(graph_json: str) -> None:
    result = translation_py.to_datalog(graph_json)
    # fact_count mirrors export_dataset's ExportResult.fact_count.
    assert result["fact_count"] == int(_golden("datalog", "fact_count.txt").strip())
    assert result["prolog"] == _golden("datalog", "graph.pl")
    assert result["problog"] == _golden("datalog", "graph.problog.pl")
    assert result["souffle"]["program"] == _golden("datalog", "graph.dl")
    for path in sorted((GOLDEN / "datalog" / "facts").glob("*.facts")):
        assert result["souffle"]["facts"][path.stem] == path.read_text(encoding="utf-8")


def test_to_neo4j_export_matches_golden(graph_json: str) -> None:
    result = translation_py.to_neo4j_export(graph_json)
    # node_count / edge_count mirror export_to_tsv's ExportResult.
    assert result["node_count"] == 3
    assert result["edge_count"] == 3
    for path in sorted((GOLDEN / "neo4j" / "export" / "nodes").glob("*.tsv")):
        assert result["node_files"][path.stem] == path.read_text(encoding="utf-8")
    for path in sorted((GOLDEN / "neo4j" / "export" / "edges").glob("*.tsv")):
        assert result["edge_files"][path.stem] == path.read_text(encoding="utf-8")


def test_to_csv_shape(graph_json: str) -> None:
    # CSV is the new Neo4j-import format (no committed golden — see the wasm harness);
    # assert the facade runs and produces the expected typed headers.
    csv = translation_py.to_csv(graph_json)
    assert csv["nodes"].startswith("csid:ID,:LABEL")
    assert csv["edges"].startswith(":START_ID,:END_ID,:TYPE")


def test_to_cypher_emits_apoc_projection(graph_json: str) -> None:
    cypher = translation_py.to_cypher(graph_json)
    assert "apoc.create.addLabels" in cypher
    assert "apoc.merge.relationship" in cypher


def test_invalid_json_raises_value_error() -> None:
    with pytest.raises(ValueError):
        translation_py.to_prolog("not json")


def test_extension_is_a_self_contained_native_module() -> None:
    # "Imports nothing outside its own package at runtime": the whole surface is a
    # compiled extension bundled inside the translation_py package (pure in-process serde
    # over the core), and the package's own __init__ only re-exports from it — no
    # culturescrape, no network/filesystem client is imported at runtime.
    package_dir = Path(translation_py.__file__).parent
    suffixes = tuple(importlib.machinery.EXTENSION_SUFFIXES)
    compiled = [p.name for p in package_dir.iterdir() if p.name.endswith(suffixes)]
    assert compiled, f"no compiled extension found in {package_dir}"
    init_source = (package_dir / "__init__.py").read_text(encoding="utf-8")
    assert "culturescrape" not in init_source
    # Every matrix entry point resolved into the one native module.
    for name in ("to_tsv", "to_csv", "to_cypher", "to_prolog", "to_souffle",
                 "to_problog", "to_datalog", "to_neo4j_export"):
        assert callable(getattr(translation_py, name)), name
