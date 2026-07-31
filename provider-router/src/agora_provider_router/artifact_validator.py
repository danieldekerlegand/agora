#!/usr/bin/env python3
"""The Python half of agora's dual interchange validator (legacy-absorbed, ADR-0003).

legacy was the ecosystem's load-bearing contract library; ADR-0001 rehomes contracts to
koine and runtime to agora. koine:10 ported legacy's six draft-2020-12 schemas into
``koine/schemas/`` (rebased off ``https://legacy.ecosystem/schemas/`` onto koine's id
space), ``@agora/schemas``'s ``validator.ts`` is the TypeScript-ecosystem validator over
them, and this is its Python twin — a faithful port of ``legacy/validators/validate.py``.

The two exist so a schema change "lands green only when BOTH agree": the same golden
fixtures validate identically under ajv (Node) and jsonschema (Python), or the gate is red.
Both read the SAME derived koine-schema snapshot (``schemas/src/koine-schemas/``, regenerated
by ``regen-koine-schemas.mjs`` — never hand-edited), so neither ecosystem can fork the contract.

Usage:
    python -m agora_provider_router.artifact_validator <schema-name> <artifact.json>

Schema names: grounding-pack, canonical-world-export, entity-grounding-snapshot,
canonical-graph-export, dataset-jsonl-header, finetune-job.

Exit 0 = valid; exit 1 = invalid (errors printed); exit 2 = usage/load error — the same
exit-code semantics as ``validator.ts``'s CLI, so a CI smoke can loop both ecosystems.
Requires: jsonschema>=4.21, referencing.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

#: The derived koine-schema snapshot lives one area over, inside the source-first
#: ``@agora/schemas`` package (``provider-router`` → repo root → ``schemas/src/koine-schemas``).
#: Reading the ONE snapshot both validators share is what keeps the ecosystems from forking;
#: a standalone router wheel without the sibling area simply has nothing to validate against.
_REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMAS_DIR = _REPO_ROOT / "schemas" / "src" / "koine-schemas"

#: The interchange artifacts, each mapped to the koine schema file that governs it — the same
#: names ``validator.ts`` (and legacy's ``validate.mjs``) expose: the five legacy artifacts plus
#: ``finetune-job``, the KFT §3 job manifest agora:41 added (it ``$ref``s provenance +
#: dataset-jsonl-header, both already registered). This validator checks STRUCTURE only — the
#: SEMANTIC admission KFT defines (modality×method compatibility, egress feasibility, cost ceiling)
#: is PROVIDER behavior at invoke, not schema shape. ``provenance`` is absent: it is the shared
#: ``$defs`` library every artifact ``$ref``s, never validated directly.
#: Every name is a CAPABILITY, never a producer: ``canonical-graph-export`` is any producer's
#: predicate web projected onto the canonical graph, whoever produced it.
ARTIFACT_SCHEMAS = {
    "grounding-pack": "grounding-pack.schema.json",
    "canonical-world-export": "canonical-world-export.schema.json",
    "entity-grounding-snapshot": "entity-grounding-snapshot.schema.json",
    "canonical-graph-export": "canonical-graph-export.schema.json",
    "dataset-jsonl-header": "dataset-jsonl-header.schema.json",
    "finetune-job": "finetune-job.schema.json",
}

#: The koine schema id base. Every ported schema declares ``$id``
#: ``https://koine.ecosystem/schemas/<file>``, so a relative ``$ref`` like
#: ``provenance.schema.json#/$defs/provenance`` resolves against it.
BASE_URI = "https://koine.ecosystem/schemas/"

_USAGE = "usage: python -m agora_provider_router.artifact_validator <schema-name> <artifact.json>"


def build_registry() -> Registry[Any]:
    """A referencing registry with every koine schema dual-registered.

    Each ``*.schema.json`` is registered under both its declared ``$id`` and the base-URI +
    filename so relative ``$ref``s resolve either way — the same dual registration as
    ``validator.ts``'s two ``ajv.addSchema`` calls. For the ported koine schemas
    ``$id == BASE_URI + file``, so the guard collapses the pair to one entry.
    """
    registry: Registry[Any] = Registry()
    for path in sorted(SCHEMAS_DIR.glob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        resource = Resource.from_contents(schema)
        registry = registry.with_resource(schema["$id"], resource)
        if schema["$id"] != BASE_URI + path.name:
            registry = registry.with_resource(BASE_URI + path.name, resource)
    return registry


def validator_for(name: str) -> Draft202012Validator:
    """Build a draft-2020-12 validator for one artifact name, or raise on an unknown name."""
    if name not in ARTIFACT_SCHEMAS:
        raise KeyError(f"unknown schema '{name}' (valid: {', '.join(sorted(ARTIFACT_SCHEMAS))})")
    schema = json.loads((SCHEMAS_DIR / ARTIFACT_SCHEMAS[name]).read_text(encoding="utf-8"))
    return Draft202012Validator(schema, registry=build_registry())


def validate(name: str, instance: object) -> list[str]:
    """Validate ``instance`` against the koine schema ``name``; return sorted error strings.

    Each error is ``<instance/path or <root>>: <message>``, sorted by path — byte-for-byte the
    same shape ``validate.py`` returned, so the Python and TypeScript suites agree fixture for
    fixture. An empty list means the artifact conforms. Raises ``KeyError`` for an unknown name.
    """
    v = validator_for(name)
    return [
        f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}"
        for e in sorted(v.iter_errors(instance), key=lambda e: list(e.absolute_path))
    ]


def main(argv: list[str]) -> int:
    """CLI entry point: 0 = valid, 1 = invalid (errors printed), 2 = usage/load error."""
    if len(argv) != 3:
        print(_USAGE, file=sys.stderr)
        return 2
    name, artifact_path = argv[1], Path(argv[2])
    try:
        instance = json.loads(artifact_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot load {artifact_path}: {exc}", file=sys.stderr)
        return 2
    try:
        errors = validate(name, instance)
    except KeyError as exc:
        print(exc.args[0], file=sys.stderr)
        return 2
    if errors:
        for err in errors:
            print(f"INVALID {err}")
        return 1
    contract = "?"
    if isinstance(instance, dict):
        # grounding-pack stamps its version into `kgp_version` (KGP §2) and finetune-job into
        # `kft_version` (KFT §3); the other four keep `contractVersion`. Show whichever it carries.
        contract = (
            instance.get("contractVersion")
            or instance.get("kgp_version")
            or instance.get("kft_version")
            or "?"
        )
    print(f"VALID {artifact_path} against {name} (contract {contract})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
