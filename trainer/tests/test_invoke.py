"""The `invoke` HTTP surface — admission verdicts + the §6 telemetry stream (KCB §4)."""

from __future__ import annotations

import json
from typing import Any

import httpx
from fastapi.testclient import TestClient

from agora_trainer.app import app
from conftest import valid_text_job

client = TestClient(app)


def _stream(response: httpx.Response) -> list[dict[str, Any]]:
    """Parse a newline-delimited telemetry response into its events."""
    return [json.loads(line) for line in response.text.splitlines() if line]


class TestAdmitted:
    def test_a_valid_job_streams_telemetry_to_a_terminal_event(self) -> None:
        response = client.post("/invoke", json=valid_text_job())
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        assert response.headers["x-agora-job"] == "orchestrator:activity:ft-run/9f2a"
        events = _stream(response)
        steps = [e["step"] for e in events]
        assert steps == sorted(steps)  # monotonic
        assert events[-1]["terminal"] is True
        assert events[-1]["model"].startswith("agora:model:ft-")
        assert events[-1]["weights"]

    def test_every_event_carries_its_idempotency_key(self) -> None:
        events = _stream(client.post("/invoke", json=valid_text_job()))
        assert all(e["id"].startswith("ft-event:sha256-") for e in events)
        assert len({e["id"] for e in events}) == len(events)  # unique per step


class TestRejected:
    def test_an_invalid_job_is_422_with_the_structured_report(self) -> None:
        job = valid_text_job()
        del job["base_model"]
        response = client.post("/invoke", json=job)
        assert response.status_code == 422
        body = response.json()
        assert body["ok"] is False
        assert body["status"] == "invalid"
        assert body["exit_code"] == 1
        assert body["problems"]

    def test_an_incompatible_pair_is_422(self) -> None:
        job = valid_text_job(
            modality="text-to-image", method="dpo", dataset={"media": ["analyzer:asset:blake3-aa"]}
        )
        response = client.post("/invoke", json=job)
        assert response.status_code == 422
        assert any(p["code"] == "modality-method" for p in response.json()["problems"])

    def test_unreadable_body_is_a_400_usage_error(self) -> None:
        response = client.post("/invoke", content=b"{ not json")
        assert response.status_code == 400
        assert response.json()["status"] == "usage"

    def test_a_non_object_payload_is_a_400_usage_error(self) -> None:
        response = client.post("/invoke", json=["not", "a", "job"])
        assert response.status_code == 400
        assert response.json()["status"] == "usage"

    def test_a_compatible_but_unwired_modality_is_501(self) -> None:
        """image-text-to-text is admissible (FT-F) but has no US-2 engine — a 501, not a 422."""
        job = valid_text_job(
            modality="image-text-to-text",
            method="qlora",
            dataset={"knowledge": ["kgp:pack:sha256-7b1e"], "media": ["analyzer:asset:blake3-aa"]},
        )
        response = client.post("/invoke", json=job)
        assert response.status_code == 501
        assert response.json()["status"] == "unsupported"

    def test_a_local_only_cloud_placement_is_422(self) -> None:
        job = valid_text_job(compute={"class": "single-gpu-a100-80gb", "egress": "local-only"})
        response = client.post("/invoke", json=job)
        assert response.status_code == 422
        assert any(p["code"] == "egress-cross-boundary" for p in response.json()["problems"])

    def test_an_over_ceiling_grant_header_is_422(self) -> None:
        # The X-Agora-Budget-Units header carries the §7 ceiling; a run over it is rejected (FT-E).
        response = client.post(
            "/invoke", json=valid_text_job(), headers={"X-Agora-Budget-Units": "1"}
        )
        assert response.status_code == 422
        assert any(p["code"] == "budget" for p in response.json()["problems"])
