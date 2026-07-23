#!/usr/bin/env python3
"""Capture TSV goldens from culture-scrape's reference writers.

Run from a venv where ``culturescrape`` is importable (the pinakes culture-scrape
package). It builds the node/edge schemas from the *same* vendored
``canonical-schema.json`` the Rust core reads, loads the shared ``graph.json``
fixture, and writes ``fixtures/golden/{nodes,edges}.tsv`` with the exact bytes
``schema/tsvio.py``'s ``write_node_rows`` / ``write_edge_rows`` produce. The Rust
golden test then asserts byte-identity against these committed files — so the port
is verified against the reference, not merely self-consistent.

Usage (from repo root)::

    cd /path/to/pinakes/packages/culture-scrape && \
      uv run python /path/to/agora/translation/tools/gen_golden.py
"""

from __future__ import annotations

import json
from pathlib import Path

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


def _columns(spec: dict) -> tuple:
    return tuple(parse_column(col["header"]) for col in spec["columns"])


def main() -> None:
    schema = json.loads(SCHEMA_JSON.read_text(encoding="utf-8"))
    graph = json.loads(FIXTURE.read_text(encoding="utf-8"))

    node_schema = NodeSchema(_columns(schema["node"]))
    edge_schema = EdgeSchema(_columns(schema["edge"]))

    GOLDEN.mkdir(parents=True, exist_ok=True)
    n = write_node_rows(GOLDEN / "nodes.tsv", node_schema, graph["nodes"])
    e = write_edge_rows(GOLDEN / "edges.tsv", edge_schema, graph["edges"])
    print(f"wrote {n} node rows -> {GOLDEN / 'nodes.tsv'}")
    print(f"wrote {e} edge rows -> {GOLDEN / 'edges.tsv'}")


if __name__ == "__main__":
    main()
