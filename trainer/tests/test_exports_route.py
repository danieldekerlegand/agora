"""`exports` — a completed run's §5.3 export matrix, served rather than 404ed (KFT §5.3).

The matrix *is* the KMI lineage graph: every weight/export is an asset with a registered media
type, a ``media:derived_from`` / ``media:variant_of`` link, and the §5.4 envelope it inherited.
This asserts the HTTP surface serves exactly what :mod:`agora_trainer.lineage` minted for the run
the caller `invoke`d — no second projection of the matrix that could drift from it.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agora_trainer.app import app, get_runs
from agora_trainer.journal import RunRegistry
from agora_trainer.lineage import (
    MEDIA_DERIVED_FROM,
    MEDIA_VARIANT_OF,
    PRIMARY_ARTIFACT,
    mint_asset_id,
)
from agora_trainer.manifest import EXPORTS_PATH
from agora_trainer.telemetry import TelemetryEvent
from conftest import exhaust_job, valid_text_job

JOB = "orchestrator:activity:ft-run/9f2a"
BASE = "pinakes:model:qwen2.5-3b-instruct"


@pytest.fixture(autouse=True)
def runs() -> Any:
    """A registry per test — runs are process state, and no test may see another's."""
    registry = RunRegistry()
    app.dependency_overrides[get_runs] = lambda: registry
    yield registry
    app.dependency_overrides.pop(get_runs, None)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _run(client: TestClient, job: dict[str, Any] | None = None) -> dict[str, Any]:
    """`invoke` a job to completion (the stream must be drained) and return its export matrix."""
    payload = valid_text_job() if job is None else job
    assert client.post("/invoke", json=payload).status_code == 200
    response = client.get(EXPORTS_PATH, params={"job": payload["job"]})
    assert response.status_code == 200
    body: dict[str, Any] = response.json()
    return body


class TestTheExportMatrix:
    def test_a_completed_run_serves_its_minted_model_and_assets(self, client: TestClient) -> None:
        body = _run(client)
        assert body["ok"] is True
        assert body["job"] == JOB
        assert body["model"]["id"].startswith("agora:model:ft-")
        assert body["model"]["type"] == ["model", "text-generation"]
        assert [link["target"] for link in body["model"]["lineage"]] == [BASE, BASE]
        # The primary adapter plus each *distinct* requested export (the job asks for
        # `safetensors-adapter` too, which is the primary — `planned_artifacts` dedupes it).
        assert len(body["exports"]) == 2

    def test_every_export_carries_its_kmi_media_type_and_lineage_link(
        self, client: TestClient
    ) -> None:
        """§5.3: the export matrix *is* the KMI lineage graph, not a bespoke export registry."""
        body = _run(client)
        model = body["model"]["id"]
        primary = mint_asset_id(model, PRIMARY_ARTIFACT)
        assert body["exports"][0]["id"] == primary
        assert body["exports"][0]["media_type"] == "application/vnd.koine.model+safetensors"
        # The adapter derives from the base weights; each further export is a byte-encoding
        # variant of that adapter.
        assert body["exports"][0]["lineage"] == [{"relation": MEDIA_DERIVED_FROM, "target": BASE}]
        for export in body["exports"][1:]:
            assert export["lineage"] == [{"relation": MEDIA_VARIANT_OF, "target": primary}]
        gguf = next(e for e in body["exports"] if e["role"] == "gguf")
        assert gguf["media_type"] == "application/vnd.koine.model+gguf"

    def test_the_matrix_matches_the_ids_the_terminal_telemetry_event_announced(
        self, client: TestClient
    ) -> None:
        """One minting authority: what §6 announced is what §5.3 serves (no second projection)."""
        response = client.post("/invoke", json=valid_text_job())
        last = json.loads(response.text.splitlines()[-1])  # the terminal §6 event
        body = client.get(EXPORTS_PATH, params={"job": JOB}).json()
        assert body["model"]["id"] == last["model"]
        assert [export["id"] for export in body["exports"]] == last["weights"]

    def test_the_run_activity_rides_along_as_the_reproducibility_anchor(
        self, client: TestClient
    ) -> None:
        """§5.2/FT-C: the matrix is only meaningful against the run that generated it."""
        activity = _run(client)["activity"]
        assert activity["activity"] == JOB
        assert activity["seed"] == 42
        assert activity["config_hash"] == "sha256-cfg9f2a"
        assert BASE in activity["used"]
        assert activity["generated"][0].startswith("agora:model:ft-")

    def test_every_asset_carries_the_inherited_egress_and_union_license(
        self, client: TestClient
    ) -> None:
        """§5.4/FT-A: inheritance travels with the bytes, answerable without the corpus."""
        body = _run(client)
        assert body["model"]["egress"] == "exportable"
        assert body["model"]["license"] == ["CC-BY-4.0"]
        for export in body["exports"]:
            assert export["egress"] == "exportable"
            assert export["license"] == ["CC-BY-4.0"]

    def test_a_local_only_corpus_stamps_local_only_on_the_whole_matrix(
        self, client: TestClient
    ) -> None:
        body = _run(client, exhaust_job())
        assert body["model"]["egress"] == "local-only"
        assert [export["egress"] for export in body["exports"]] == ["local-only"]


class TestRefusals:
    def test_an_unknown_run_is_a_reported_404(self, client: TestClient) -> None:
        response = client.get(EXPORTS_PATH, params={"job": "orchestrator:activity:ft-run/nope"})
        assert response.status_code == 404
        assert [p["code"] for p in response.json()["problems"]] == ["unknown-run"]

    def test_a_run_that_has_not_completed_is_a_409_not_an_empty_matrix(
        self, client: TestClient, runs: RunRegistry
    ) -> None:
        """The §5 outputs are minted at completion — before that there is nothing to serve."""
        journal = runs.open(JOB)
        journal.append(TelemetryEvent(job=JOB, step=0, ts="2026-08-13T00:00:00Z"))
        response = client.get(EXPORTS_PATH, params={"job": JOB})
        assert response.status_code == 409
        assert [p["code"] for p in response.json()["problems"]] == ["run-incomplete"]

    def test_a_rejected_job_leaves_nothing_to_export(self, client: TestClient) -> None:
        job = valid_text_job()
        del job["base_model"]
        assert client.post("/invoke", json=job).status_code == 422
        assert client.get(EXPORTS_PATH, params={"job": JOB}).status_code == 404

    def test_the_manifest_advertises_the_exports_endpoint_it_serves(
        self, client: TestClient
    ) -> None:
        manifest = client.get("/.well-known/kcb-manifest.json").json()
        assert manifest["endpoints"]["exports"].endswith(EXPORTS_PATH)
