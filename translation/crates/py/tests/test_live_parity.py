"""Live parity against the culture-scrape reference (US-5), when it is importable.

The committed goldens in ``test_parity.py`` ARE the reference exporters' output; this
module additionally re-runs the reference *live* and compares — the true drop-in
proof that ``translation_py`` replaces the pure-Python exporters byte-for-byte. It runs
only where ``culturescrape`` is importable in the test venv; the ephemeral gate venv
carries just maturin+pytest, so it skips there, mirroring culture-scrape's own
absent-sibling ``pytest.skip``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import translation_py

pytest.importorskip("culturescrape")

from culturescrape.datalog.export import Engine, export_dataset  # noqa: E402
from culturescrape.neo4j.constraints import ENTITY_LABEL  # noqa: E402
from culturescrape.neo4j.export import (  # noqa: E402
    EDGE_QUERY,
    NODE_QUERY,
    export_to_tsv,
)
from culturescrape.schema.headers import (  # noqa: E402
    EdgeSchema,
    NodeSchema,
    parse_column,
)
from culturescrape.schema.tsvio import write_edge_rows, write_node_rows  # noqa: E402

CORE = Path(__file__).resolve().parents[2] / "core"
SCHEMA_JSON = CORE / "canonical-schema.json"
FIXTURE = CORE / "fixtures" / "graph.json"


def _columns(spec: dict) -> tuple:
    return tuple(parse_column(col["header"]) for col in spec["columns"])


@pytest.fixture(scope="module")
def schema() -> dict:
    return json.loads(SCHEMA_JSON.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def graph() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def graph_json() -> str:
    # The exact fixture bytes the extension reads (json.loads(text) == the graph dict).
    return FIXTURE.read_text(encoding="utf-8")


def test_live_tsv_parity(schema, graph, graph_json, tmp_path) -> None:
    node_schema = NodeSchema(_columns(schema["node"]))
    edge_schema = EdgeSchema(_columns(schema["edge"]))
    nodes_tsv = tmp_path / "nodes.tsv"
    edges_tsv = tmp_path / "edges.tsv"
    write_node_rows(nodes_tsv, node_schema, graph["nodes"])
    write_edge_rows(edges_tsv, edge_schema, graph["edges"])

    tsv = translation_py.to_tsv(graph_json)
    assert tsv["nodes"] == nodes_tsv.read_text(encoding="utf-8")
    assert tsv["edges"] == edges_tsv.read_text(encoding="utf-8")


def test_live_datalog_parity(schema, graph, graph_json, tmp_path) -> None:
    node_schema = NodeSchema(_columns(schema["node"]))
    edge_schema = EdgeSchema(_columns(schema["edge"]))
    dataset = tmp_path / "dataset"
    (dataset / "nodes").mkdir(parents=True)
    (dataset / "edges").mkdir(parents=True)
    write_node_rows(dataset / "nodes" / "nodes.tsv", node_schema, graph["nodes"])
    write_edge_rows(dataset / "edges" / "edges.tsv", edge_schema, graph["edges"])
    out = tmp_path / "out"
    result = export_dataset(
        dataset, out, (Engine.SWIPL, Engine.SOUFFLE, Engine.PROBLOG)
    )

    datalog = translation_py.to_datalog(graph_json)
    assert datalog["fact_count"] == result.fact_count
    assert datalog["prolog"] == (out / "graph.pl").read_text(encoding="utf-8")
    assert datalog["problog"] == (out / "graph.problog.pl").read_text(encoding="utf-8")
    assert datalog["souffle"]["program"] == (out / "graph.dl").read_text(encoding="utf-8")
    for facts in sorted(out.glob("*.facts")):
        assert datalog["souffle"]["facts"][facts.stem] == facts.read_text(
            encoding="utf-8"
        )


class _FakeSession:
    def __init__(self, results: dict) -> None:
        self._results = results

    def __enter__(self) -> "_FakeSession":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def run(self, query: str) -> list:
        return self._results[query]


class _FakeDriver:
    def __init__(self, results: dict) -> None:
        self._results = results

    def session(self) -> _FakeSession:
        return _FakeSession(self._results)

    def close(self) -> None:
        return None


def _node_record(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "labels": [ENTITY_LABEL] + list(row.get(":LABEL", [])),
        "props": {k: v for k, v in row.items() if k != ":LABEL"},
    }


def _edge_record(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "start": row[":START_ID"],
        "end": row[":END_ID"],
        "type": row[":TYPE"],
        "props": {
            k: v for k, v in row.items() if k not in (":START_ID", ":END_ID", ":TYPE")
        },
    }


def test_live_neo4j_export_parity(schema, graph, graph_json, tmp_path, monkeypatch) -> None:
    node_schema = NodeSchema(_columns(schema["node"]))
    edge_schema = EdgeSchema(_columns(schema["edge"]))
    # export_to_tsv reads NodeSchema.canonical()/EdgeSchema.canonical(), which hard-code
    # a parent_code column absent from the vendored schema (the US-1 discrepancy) — patch
    # them to the JSON-derived schema the Rust core reads, keeping one canonical header.
    monkeypatch.setattr(NodeSchema, "canonical", classmethod(lambda cls: node_schema))
    monkeypatch.setattr(EdgeSchema, "canonical", classmethod(lambda cls: edge_schema))

    driver = _FakeDriver(
        {
            NODE_QUERY: [_node_record(row) for row in graph["nodes"]],
            EDGE_QUERY: [_edge_record(row) for row in graph["edges"]],
        }
    )
    result = export_to_tsv(tmp_path, driver=driver)

    export = translation_py.to_neo4j_export(graph_json)
    assert export["node_count"] == result.node_count
    assert export["edge_count"] == result.edge_count
    for path in result.node_files:
        assert export["node_files"][path.stem] == path.read_text(encoding="utf-8")
    for path in result.edge_files:
        assert export["edge_files"][path.stem] == path.read_text(encoding="utf-8")
