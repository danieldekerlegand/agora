#!/usr/bin/env python3
"""Capture goldens from culture-scrape's reference exporters.

Run from a venv where ``culturescrape`` is importable (the pinakes culture-scrape
package). It builds the node/edge schemas from the *same* vendored
``canonical-schema.json`` the Rust core reads, loads the shared ``graph.json``
fixture, and writes:

* ``fixtures/golden/{nodes,edges}.tsv`` — the exact bytes ``schema/tsvio.py``'s
  ``write_node_rows`` / ``write_edge_rows`` produce (US-1);
* ``fixtures/golden/datalog/{graph.pl,graph.dl,graph.problog.pl}`` plus
  ``fixtures/golden/datalog/facts/<predicate>.facts`` — the exact bytes
  ``datalog/export.py``'s ``export_dataset`` produces for the SWI-Prolog, Soufflé
  and ProbLog engines with **no rules** (US-2).

The Rust golden tests then assert byte-identity against these committed files — so
the port is verified against the reference, not merely self-consistent.

Usage (from repo root)::

    cd /path/to/pinakes/packages/culture-scrape && \
      uv run python /path/to/agora/translation/tools/gen_golden.py
"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from culturescrape.datalog.export import Engine, export_dataset
from culturescrape.datalog.souffle import SOUFFLE_PROGRAM_NAME
from culturescrape.neo4j.constraints import ENTITY_LABEL
from culturescrape.neo4j.export import EDGE_QUERY, NODE_QUERY, export_to_tsv
from culturescrape.neo4j.load_csv import edge_cypher, node_cypher
from culturescrape.schema.headers import (
    EdgeSchema,
    NodeSchema,
    parse_column,
)
from culturescrape.schema.tsvio import write_edge_rows, write_node_rows

HERE = Path(__file__).resolve().parent
CORE = HERE.parent / "crates" / "core"
SCHEMA_JSON = CORE / "canonical-schema.json"
FIXTURE = CORE / "fixtures" / "graph.json"
GOLDEN = CORE / "fixtures" / "golden"
DATALOG_GOLDEN = GOLDEN / "datalog"
NEO4J_GOLDEN = GOLDEN / "neo4j"


def _columns(spec: dict) -> tuple:
    return tuple(parse_column(col["header"]) for col in spec["columns"])


def _write_tsv_goldens(schema: dict, graph: dict) -> None:
    node_schema = NodeSchema(_columns(schema["node"]))
    edge_schema = EdgeSchema(_columns(schema["edge"]))

    GOLDEN.mkdir(parents=True, exist_ok=True)
    n = write_node_rows(GOLDEN / "nodes.tsv", node_schema, graph["nodes"])
    e = write_edge_rows(GOLDEN / "edges.tsv", edge_schema, graph["edges"])
    print(f"wrote {n} node rows -> {GOLDEN / 'nodes.tsv'}")
    print(f"wrote {e} edge rows -> {GOLDEN / 'edges.tsv'}")


def _write_datalog_goldens(schema: dict, graph: dict) -> None:
    """Capture the SWI-Prolog / Soufflé / ProbLog programs export_dataset emits.

    ``export_dataset`` reads a dataset directory (``nodes/*.tsv``, ``edges/*.tsv``),
    so the fixture is first materialised into a temp dataset (one ``nodes.tsv`` and
    one ``edges.tsv``, both canonically sorted by the reference writers), then all
    three engines are exported with **no rules** — the exact default path the Rust
    port reproduces over its in-memory graph.
    """
    node_schema = NodeSchema(_columns(schema["node"]))
    edge_schema = EdgeSchema(_columns(schema["edge"]))

    with tempfile.TemporaryDirectory() as tmp:
        dataset = Path(tmp) / "dataset"
        (dataset / "nodes").mkdir(parents=True)
        (dataset / "edges").mkdir(parents=True)
        write_node_rows(dataset / "nodes" / "nodes.tsv", node_schema, graph["nodes"])
        write_edge_rows(dataset / "edges" / "edges.tsv", edge_schema, graph["edges"])

        out = Path(tmp) / "out"
        result = export_dataset(
            dataset, out, (Engine.SWIPL, Engine.SOUFFLE, Engine.PROBLOG)
        )

        if DATALOG_GOLDEN.exists():
            shutil.rmtree(DATALOG_GOLDEN)
        facts_dir = DATALOG_GOLDEN / "facts"
        facts_dir.mkdir(parents=True)

        for name in ("graph.pl", SOUFFLE_PROGRAM_NAME, "graph.problog.pl"):
            shutil.copyfile(out / name, DATALOG_GOLDEN / name)
            print(f"wrote {name} -> {DATALOG_GOLDEN / name}")

        for facts in sorted(out.glob("*.facts")):
            shutil.copyfile(facts, facts_dir / facts.name)
            print(f"wrote facts {facts.name} -> {facts_dir / facts.name}")

        (DATALOG_GOLDEN / "fact_count.txt").write_text(
            f"{result.fact_count}\n", encoding="utf-8"
        )
        print(f"export_dataset projected {result.fact_count} facts")


def _write_neo4j_goldens(schema: dict) -> None:
    """Capture the idempotent LOAD CSV Cypher `load_csv.py` emits for the canonical
    node/edge headers (US-3).

    ``node_cypher`` / ``edge_cypher`` are pure functions of the schema (they read each
    row through the ``$file`` parameter, so they do not depend on any dataset), so the
    goldens are byte-stable and the Rust port asserts equality against them.
    """
    node_schema = NodeSchema(_columns(schema["node"]))
    edge_schema = EdgeSchema(_columns(schema["edge"]))

    NEO4J_GOLDEN.mkdir(parents=True, exist_ok=True)
    (NEO4J_GOLDEN / "node_load.cypher").write_text(
        node_cypher(node_schema), encoding="utf-8"
    )
    (NEO4J_GOLDEN / "edge_load.cypher").write_text(
        edge_cypher(edge_schema), encoding="utf-8"
    )
    print(f"wrote node/edge LOAD CSV cypher -> {NEO4J_GOLDEN}")


class _FakeSession:
    """Replays a per-query list of fixture records, like a real Bolt cursor."""

    def __init__(self, results: dict) -> None:
        self._results = results

    def __enter__(self) -> "_FakeSession":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def run(self, query: str) -> list:
        return self._results[query]


class _FakeDriver:
    """A driver whose ``session().run(query)`` replays the fixture graph as the
    ``labels(n)`` / ``properties(n)`` / ``type(r)`` records a real read returns."""

    def __init__(self, results: dict) -> None:
        self._results = results

    def session(self) -> _FakeSession:
        return _FakeSession(self._results)

    def close(self) -> None:
        return None


def _node_record(row: dict) -> dict:
    labels = [ENTITY_LABEL] + list(row.get(":LABEL", []))
    props = {k: v for k, v in row.items() if k != ":LABEL"}
    return {"labels": labels, "props": props}


def _edge_record(row: dict) -> dict:
    props = {k: v for k, v in row.items() if k not in (":START_ID", ":END_ID", ":TYPE")}
    return {
        "start": row[":START_ID"],
        "end": row[":END_ID"],
        "type": row[":TYPE"],
        "props": props,
    }


def _write_neo4j_export_goldens(schema: dict, graph: dict) -> None:
    """Capture what ``neo4j/export.py``'s ``export_to_tsv`` writes for the shared
    fixture (US-5), so the PyO3 ``to_neo4j_export`` — and the native core adapter it
    forwards to — can assert byte-identity against the reference exporter.

    The fixture graph is replayed over a **fake driver** exactly as culture-scrape's
    own ``test_neo4j_export.py`` mocks its cursor: each node becomes a
    ``labels(n)``/``properties(n)`` record (the ``ENTITY_LABEL`` anchor prepended,
    dropped again by the export), each edge an endpoint/type/properties record.
    ``export_to_tsv`` builds its schema from ``NodeSchema.canonical()`` /
    ``EdgeSchema.canonical()``, which hard-code a ``parent_code`` column absent from
    the vendored ``canonical-schema.json`` (the US-1 discrepancy) — so those are
    patched to the JSON-derived schema the Rust core reads, keeping both sides on the
    one canonical header.
    """
    node_schema = NodeSchema(_columns(schema["node"]))
    edge_schema = EdgeSchema(_columns(schema["edge"]))
    NodeSchema.canonical = classmethod(lambda cls: node_schema)  # type: ignore[assignment]
    EdgeSchema.canonical = classmethod(lambda cls: edge_schema)  # type: ignore[assignment]

    driver = _FakeDriver(
        {
            NODE_QUERY: [_node_record(row) for row in graph["nodes"]],
            EDGE_QUERY: [_edge_record(row) for row in graph["edges"]],
        }
    )

    export_dir = NEO4J_GOLDEN / "export"
    if export_dir.exists():
        shutil.rmtree(export_dir)
    with tempfile.TemporaryDirectory() as tmp:
        result = export_to_tsv(tmp, driver=driver)
        (export_dir / "nodes").mkdir(parents=True)
        (export_dir / "edges").mkdir(parents=True)
        for path in result.node_files:
            shutil.copyfile(path, export_dir / "nodes" / path.name)
        for path in result.edge_files:
            shutil.copyfile(path, export_dir / "edges" / path.name)
    print(
        f"export_to_tsv wrote {result.node_count} node / {result.edge_count} "
        f"edge rows -> {export_dir}"
    )


def main() -> None:
    schema = json.loads(SCHEMA_JSON.read_text(encoding="utf-8"))
    graph = json.loads(FIXTURE.read_text(encoding="utf-8"))
    _write_tsv_goldens(schema, graph)
    _write_datalog_goldens(schema, graph)
    _write_neo4j_goldens(schema)
    _write_neo4j_export_goldens(schema, graph)


if __name__ == "__main__":
    main()
