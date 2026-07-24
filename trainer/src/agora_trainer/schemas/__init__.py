"""The koine JSON Schemas the trainer validates finetune jobs against (KFT §3).

These `.json` files are a **vendored snapshot** of ``koine/schemas/`` — the trainer loads a
copy it ships rather than reaching into the sibling koine checkout at runtime (a deployed
service has no ``../koine`` beside it, ADR-0001). The snapshot is pinned byte-for-byte to
koine by ``tests/test_schema_drift.py`` (the same discipline the TS side keeps for the koine
registry fixture); a ``koine:*`` bump that advanced the schema is red there until the copy is
refreshed. **Never hand-edit these files** — recopy them from koine.

``finetune-job.schema.json`` cross-refs ``provenance.schema.json`` (``kft_version`` +
``dataset.header`` fields) and ``dataset-jsonl-header.schema.json`` (the per-record header),
so all three travel together; :func:`load_registry` builds the ``referencing`` registry that
resolves those refs offline.
"""

from __future__ import annotations

import json
from functools import lru_cache
from importlib import resources
from typing import Any

from referencing import Registry, Resource

#: The vendored schema file names, in dependency order (finetune-job refs the other two).
SCHEMA_FILES: tuple[str, ...] = (
    "provenance.schema.json",
    "dataset-jsonl-header.schema.json",
    "finetune-job.schema.json",
)

#: The ``$id`` of the finetune-job schema — the root the admission validator resolves against.
FINETUNE_JOB_ID = "https://koine.ecosystem/schemas/finetune-job.schema.json"


def load_schema(name: str) -> dict[str, Any]:
    """The parsed contents of a vendored schema file (e.g. ``finetune-job.schema.json``)."""
    text = resources.files(__name__).joinpath(name).read_text(encoding="utf-8")
    parsed: dict[str, Any] = json.loads(text)
    return parsed


@lru_cache(maxsize=1)
def load_registry() -> Registry:
    """A ``referencing`` registry of every vendored schema, keyed by its ``$id``.

    The finetune-job schema's relative ``$ref``s (``provenance.schema.json#/…``) resolve
    against its own ``$id`` base, so keying each resource by ``$id`` is all the registry needs
    to dereference them without a network fetch.
    """
    resources_: list[tuple[str, Resource[Any]]] = []
    for name in SCHEMA_FILES:
        schema = load_schema(name)
        resource = Resource.from_contents(schema)
        resources_.append((schema["$id"], resource))
    return Registry().with_resources(resources_)
