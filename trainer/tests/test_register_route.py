"""`register` — the §8 registration surface, gated by the §5.4 output-egress rule (FT-A).

A finetuned model is a KINP entity a capability can produce, so it is registered in the KCB
discovery registry like any other fabric node (§8) — and §5.4 makes that registration a
*decision*: a `local-only`-inheriting model MUST NOT cross the trust boundary, and the refusal is
reported rather than silently dropped. The module-level rule is covered by
``test_registration.py``; this asserts the HTTP verb an orchestrator dials applies it.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from agora_trainer.app import app, get_registrations, get_runs
from agora_trainer.journal import RunRegistry
from agora_trainer.manifest import REGISTER_PATH
from agora_trainer.registration import Registrations
from agora_trainer.telemetry import TelemetryEvent
from conftest import exhaust_job, valid_text_job

#: `valid_text_job` — an `exportable` corpus, so its model may cross the boundary (§5.4).
EXPORTABLE_JOB = "orchestrator:activity:ft-run/9f2a"
#: `exhaust_job` — a `local-only` producer exhaust, so its model inherits `local-only` (FT-A).
LOCAL_ONLY_JOB = "orchestrator:activity:ft-run/e9d7"


@pytest.fixture(autouse=True)
def state() -> Any:
    """A runs journal and a registration ledger per test — both are process state."""
    runs, registrations = RunRegistry(), Registrations()
    app.dependency_overrides[get_runs] = lambda: runs
    app.dependency_overrides[get_registrations] = lambda: registrations
    yield runs
    app.dependency_overrides.pop(get_runs, None)
    app.dependency_overrides.pop(get_registrations, None)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _completed(client: TestClient, job: dict[str, Any]) -> None:
    """Run ``job`` to its terminal event — registration answers only for a minted model."""
    assert client.post("/invoke", json=job).status_code == 200


class TestRegistering:
    def test_a_completed_run_registers_its_minted_model(self, client: TestClient) -> None:
        _completed(client, valid_text_job())
        response = client.post(REGISTER_PATH, json={"job": EXPORTABLE_JOB})
        assert response.status_code == 201
        body = response.json()
        assert body["ok"] is True
        entry = body["registration"]
        assert entry["model"].startswith("agora:model:ft-")
        assert entry["assets"]
        assert entry["across_boundary"] is False

    def test_the_registered_assets_are_the_runs_export_matrix(self, client: TestClient) -> None:
        """§8 indexes what §5.3 minted — one set of ids, not a registration-time re-mint."""
        _completed(client, valid_text_job())
        matrix = client.get("/exports", params={"job": EXPORTABLE_JOB}).json()
        entry = client.post(REGISTER_PATH, json={"job": EXPORTABLE_JOB}).json()["registration"]
        assert entry["model"] == matrix["model"]["id"]
        assert entry["assets"] == [export["id"] for export in matrix["exports"]]

    def test_a_registration_is_readable_afterwards(self, client: TestClient) -> None:
        _completed(client, valid_text_job())
        registered = client.post(REGISTER_PATH, json={"job": EXPORTABLE_JOB}).json()
        read_back = client.get(REGISTER_PATH, params={"job": EXPORTABLE_JOB})
        assert read_back.status_code == 200
        assert read_back.json()["registration"] == registered["registration"]

    def test_re_registering_the_same_run_is_idempotent(self, client: TestClient) -> None:
        """A re-registration mints nothing new — same run, same model, same entry (§5.2/FT-C)."""
        _completed(client, valid_text_job())
        first = client.post(REGISTER_PATH, json={"job": EXPORTABLE_JOB})
        second = client.post(REGISTER_PATH, json={"job": EXPORTABLE_JOB})
        assert (first.status_code, second.status_code) == (201, 200)
        assert first.json()["registration"] == second.json()["registration"]


class TestOutputEgress:
    def test_an_exportable_model_registers_across_the_boundary(self, client: TestClient) -> None:
        _completed(client, valid_text_job())
        response = client.post(REGISTER_PATH, json={"job": EXPORTABLE_JOB, "across_boundary": True})
        assert response.status_code == 201
        assert response.json()["registration"]["across_boundary"] is True

    def test_a_local_only_model_is_refused_a_cross_boundary_registration(
        self, client: TestClient
    ) -> None:
        """§5.4/FT-A: the registry refuses and *reports* it — never a silent drop."""
        _completed(client, exhaust_job())
        response = client.post(REGISTER_PATH, json={"job": LOCAL_ONLY_JOB, "across_boundary": True})
        assert response.status_code == 422
        body = response.json()
        assert body["ok"] is False
        assert [p["code"] for p in body["problems"]] == ["egress-output"]
        assert "local-only" in body["problems"][0]["message"]

    def test_a_refused_registration_indexes_nothing(self, client: TestClient) -> None:
        _completed(client, exhaust_job())
        client.post(REGISTER_PATH, json={"job": LOCAL_ONLY_JOB, "across_boundary": True})
        read_back = client.get(REGISTER_PATH, params={"job": LOCAL_ONLY_JOB})
        assert read_back.status_code == 404
        assert [p["code"] for p in read_back.json()["problems"]] == ["unregistered"]

    def test_a_local_only_model_registers_in_tier(self, client: TestClient) -> None:
        """§5.4 keeps `local-only` output in-tier — an in-tier registration is what it permits."""
        _completed(client, exhaust_job())
        response = client.post(REGISTER_PATH, json={"job": LOCAL_ONLY_JOB})
        assert response.status_code == 201
        assert response.json()["registration"]["across_boundary"] is False


class TestRefusals:
    def test_an_unknown_run_is_a_reported_404(self, client: TestClient) -> None:
        response = client.post(REGISTER_PATH, json={"job": "orchestrator:activity:ft-run/nope"})
        assert response.status_code == 404
        assert [p["code"] for p in response.json()["problems"]] == ["unknown-run"]

    def test_a_run_that_has_not_completed_has_no_model_to_register(
        self, client: TestClient, state: RunRegistry
    ) -> None:
        journal = state.open(EXPORTABLE_JOB)
        journal.append(TelemetryEvent(job=EXPORTABLE_JOB, step=0, ts="2026-08-13T00:00:00Z"))
        response = client.post(REGISTER_PATH, json={"job": EXPORTABLE_JOB})
        assert response.status_code == 409
        assert [p["code"] for p in response.json()["problems"]] == ["run-incomplete"]

    def test_a_body_without_a_job_is_a_usage_error(self, client: TestClient) -> None:
        response = client.post(REGISTER_PATH, json={"across_boundary": True})
        assert response.status_code == 400
        assert [p["code"] for p in response.json()["problems"]] == ["usage"]

    def test_a_body_that_is_not_a_json_object_is_a_usage_error(self, client: TestClient) -> None:
        assert client.post(REGISTER_PATH, json=[EXPORTABLE_JOB]).status_code == 400
        assert client.post(REGISTER_PATH, content=b"{ not json").status_code == 400

    def test_an_unregistered_run_reads_back_as_a_404(self, client: TestClient) -> None:
        _completed(client, valid_text_job())
        response = client.get(REGISTER_PATH, params={"job": EXPORTABLE_JOB})
        assert response.status_code == 404
        assert [p["code"] for p in response.json()["problems"]] == ["unregistered"]

    def test_the_manifest_advertises_the_register_endpoint_it_serves(
        self, client: TestClient
    ) -> None:
        manifest = client.get("/.well-known/kcb-manifest.json").json()
        assert manifest["endpoints"]["register"].endswith(REGISTER_PATH)
