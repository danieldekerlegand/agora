"""US-3 (agora:41) — the Python parity twin of ``schemas/src/conformance/finetune-job.test.ts``.

The KFT §3 job manifest joins the dual validator, so the same instances that pass/fail the TS
``ajv`` suite must pass/fail the Python ``jsonschema`` one — agora:40's invariant that a schema
change "lands green only when BOTH agree". This asserts, case for case against the TS file: a
well-formed fixture validates to ``[]``, dropping any one required top-level field is rejected,
and the STRUCTURAL negatives draft-2020-12 catches on its own (bad enum, missing nested required,
an unsatisfied ``anyOf``) are rejected.

Those negatives stay firmly on the STRUCTURAL side of the SCOPE BOUNDARY: what is deliberately
NOT tested is the SEMANTIC admission KFT defines — modality×method compatibility (FT-F), egress
feasibility / cross-boundary placement (§4.2), the admission-time cost ceiling (§7). Those are
PROVIDER behavior enforced at invoke (agora:90-finetune-trainer, pinakes:90-finetune-provider),
NOT schema shape, so a fixture like modality:text-to-image × method:dpo validates GREEN here by
design — its absence is intentional, not a coverage gap.

As with ``test_artifact_conformance``, a standalone router checkout with no sibling ``schemas/``
area skips rather than fails.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from agora_provider_router.artifact_validator import SCHEMAS_DIR, validate

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "schemas" / "src" / "conformance" / "fixtures"
FIXTURE = FIXTURES / "finetune-job.json"

#: The KFT §3 required top-level fields — dropping any one must be rejected.
REQUIRED = ["kft_version", "job", "base_model", "modality", "method", "dataset", "compute"]

pytestmark = pytest.mark.skipif(
    not (SCHEMAS_DIR.exists() and FIXTURE.exists()),
    reason=f"standalone checkout: {FIXTURE} (the @agora/schemas fixture) is absent",
)


def load() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return data


def test_a_well_formed_finetune_job_validates_to_empty() -> None:
    # Also exercises cross-schema $ref resolution: kft_version resolves through
    # provenance.schema.json, and dataset.header through dataset-jsonl-header.schema.json.
    assert validate("finetune-job", load()) == []


@pytest.mark.parametrize("field", REQUIRED)
def test_rejects_a_job_missing_a_required_field(field: str) -> None:
    instance = load()
    del instance[field]
    assert validate("finetune-job", instance), f"accepted a job missing {field}"


def test_rejects_a_bad_modality_enum_value() -> None:
    instance = load()
    instance["modality"] = "not-a-modality"
    assert validate("finetune-job", instance)


def test_rejects_a_bad_method_enum_value() -> None:
    instance = load()
    instance["method"] = "not-a-method"
    assert validate("finetune-job", instance)


def test_rejects_a_compute_block_missing_class() -> None:
    instance = load()
    del instance["compute"]["class"]
    assert validate("finetune-job", instance)


def test_rejects_a_dataset_with_neither_knowledge_nor_media() -> None:
    # The dataset anyOf requires the KEY be present, not non-empty — drop BOTH to violate it.
    instance = copy.deepcopy(load())
    instance["dataset"].pop("knowledge", None)
    instance["dataset"].pop("media", None)
    assert validate("finetune-job", instance)
