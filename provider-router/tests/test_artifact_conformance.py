"""The Python half of agora's dual-ecosystem conformance gate (legacy-absorbed, ADR-0003).

The mirror image of ``schemas/src/conformance/conformance.test.ts``: the same five golden
fixtures, validated by the Python ``jsonschema`` twin instead of the TypeScript ``ajv`` one.
Both read the ONE derived koine-schema snapshot and the ONE fixtures directory, so an artifact
that passes/fails the TS suite passes/fails here — legacy ``conformance.yml``'s invariant that
a schema change "lands green only when BOTH agree".

Fixtures and schemas live one area over, in the source-first ``@agora/schemas`` package. As with
``test_manifest``'s registry pin and ``test_conformance_fixture``'s console capture, a standalone
router checkout without the sibling area skips rather than fails.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from agora_provider_router.artifact_validator import (
    ARTIFACT_SCHEMAS,
    SCHEMAS_DIR,
    main,
    validate,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
#: The five golden fixtures the TS conformance suite drives — the exact same files.
FIXTURES = REPO_ROOT / "schemas" / "src" / "conformance" / "fixtures"

#: The required spec-version key each artifact stamps its koine contract version into. koine kept
#: ``contractVersion`` on four of five but restructured grounding-pack's onto KGP §2's
#: ``kgp_version`` (ADR-0003) — the exact ``VERSION_KEY`` map ``conformance.test.ts`` carries.
VERSION_KEY = {
    "grounding-pack": "kgp_version",
    "canonical-world-export": "contractVersion",
    "entity-grounding-snapshot": "contractVersion",
    "analyzer-canonical-export": "contractVersion",
    "dataset-jsonl-header": "contractVersion",
}

#: Skip the whole module in a standalone router checkout with no sibling ``schemas/`` area.
pytestmark = pytest.mark.skipif(
    not (SCHEMAS_DIR.exists() and FIXTURES.exists()),
    reason=f"standalone checkout: {FIXTURES} (the @agora/schemas fixtures) is absent",
)


def load(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    return data


@pytest.mark.parametrize("name", sorted(ARTIFACT_SCHEMAS))
def test_golden_fixture_validates(name: str) -> None:
    """Positive gate: every golden fixture validates to [] — not only the negative cases."""
    errors = validate(name, load(name))
    assert errors == [], f"{name} fixture invalid: {errors}"


@pytest.mark.parametrize("name", sorted(ARTIFACT_SCHEMAS))
def test_missing_contract_version_rejects(name: str) -> None:
    instance = copy.deepcopy(load(name))
    del instance[VERSION_KEY[name]]
    assert validate(name, instance), f"{name} accepted a missing {VERSION_KEY[name]}"


def test_argos_export_rejects_bad_node_id() -> None:
    export = copy.deepcopy(load("analyzer-canonical-export"))
    export["nodes"][0]["id"] = "not-a-valid-id"
    assert validate("analyzer-canonical-export", export)


def test_unknown_schema_name_raises_listing_the_valid_names() -> None:
    with pytest.raises(KeyError) as excinfo:
        validate("not-a-schema", {})
    message = excinfo.value.args[0]
    for name in ARTIFACT_SCHEMAS:
        assert name in message


class TestTheCli:
    """Exit-code semantics, byte-identical to the TS CLI so US-4's smoke can loop both."""

    def test_valid_artifact_exits_zero(self) -> None:
        assert main(["prog", "grounding-pack", str(FIXTURES / "grounding-pack.json")]) == 0

    def test_invalid_artifact_exits_one(self, tmp_path: Path) -> None:
        broken = copy.deepcopy(load("analyzer-canonical-export"))
        broken["nodes"][0]["id"] = "not-a-valid-id"
        path = tmp_path / "broken.json"
        path.write_text(json.dumps(broken), encoding="utf-8")
        assert main(["prog", "analyzer-canonical-export", str(path)]) == 1

    def test_unknown_name_exits_two(self, tmp_path: Path) -> None:
        path = tmp_path / "any.json"
        path.write_text("{}", encoding="utf-8")
        assert main(["prog", "not-a-schema", str(path)]) == 2

    def test_missing_file_exits_two(self, tmp_path: Path) -> None:
        assert main(["prog", "grounding-pack", str(tmp_path / "nope.json")]) == 2

    def test_wrong_arg_count_exits_two(self) -> None:
        assert main(["prog"]) == 2
