"""The dataset bridge over HTTP — ``POST /datasets`` (KFT §4.1, the producer-facing intake).

The whole point of this route is that an application's thin adapter (ADR-0008) speaks to it over
the wire, in whatever language it happens to be written in. So these drive it exactly as such a
producer would: an HTTP POST carrying a job manifest whose training data is *referenced*, and
nothing else.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agora_trainer.app import BRIDGE_PATH, BUDGET_HEADER, PROVIDER_HEADER, app, get_directory
from agora_trainer.bridge import Dispatch, ProviderOffer, Selection
from agora_trainer.grant import Grant
from conftest import exhaust_header, exhaust_job

client = TestClient(app)

SPECIALIST = ProviderOffer(
    identity="mediastore:agent:slm-trainer",
    address="http://127.0.0.1:9100/invoke",
    in_tier=True,
    cost_tier="local",
)
CLOUD = ProviderOffer(
    identity="agora:agent:trainer",
    address="http://127.0.0.1:8001/invoke",
    in_tier=False,
    cost_tier="paid",
)


class Dialed:
    def __init__(self) -> None:
        self.identities: list[str] = []
        self.grants: list[Grant] = []
        self.specs: list[dict[str, Any]] = []

    def dispatch(self) -> Dispatch:
        def _dispatch(provider: ProviderOffer, job: dict[str, Any], grant: Grant) -> dict[str, Any]:
            self.identities.append(provider.identity)
            self.grants.append(grant)
            return {"provider": provider.identity, "status": 202}

        return _dispatch


@pytest.fixture
def dialed() -> Iterator[Dialed]:
    """Override the discovery + dispatch seams; nothing here opens a real socket."""
    recorder = Dialed()

    def _directory() -> Any:
        def _select(spec: dict[str, Any]) -> Selection:
            recorder.specs.append(spec)
            return Selection(outcome="selected", provider=SPECIALIST, reason="specialized")

        return _select

    app.dependency_overrides[get_directory] = _directory
    from agora_trainer.app import get_dispatch

    app.dependency_overrides[get_dispatch] = recorder.dispatch
    yield recorder
    app.dependency_overrides.clear()


def test_an_admitted_exhaust_is_accepted_and_routed(dialed: Dialed) -> None:
    response = client.post(BRIDGE_PATH, json=exhaust_job())
    assert response.status_code == 202
    body = response.json()
    assert body["ok"] is True
    assert body["provider"]["identity"] == "mediastore:agent:slm-trainer"
    assert body["plan"]["effective_egress"] == "local-only"
    assert body["plan"]["cardinality"] == 300
    assert dialed.identities == ["mediastore:agent:slm-trainer"]


def test_the_grant_ceiling_rides_through_to_the_provider(dialed: Dialed) -> None:
    """The bridge gates, and the provider re-gates against the same grant (§7)."""
    response = client.post(BRIDGE_PATH, json=exhaust_job(), headers={BUDGET_HEADER: "500000"})
    assert response.status_code == 202
    assert dialed.grants[0].budget_units == 500000.0


def test_an_over_ceiling_job_is_refused_before_any_provider_is_contacted(dialed: Dialed) -> None:
    response = client.post(BRIDGE_PATH, json=exhaust_job(), headers={BUDGET_HEADER: "1"})
    assert response.status_code == 422
    assert [p["code"] for p in response.json()["problems"]] == ["budget"]
    assert dialed.identities == []


def test_an_explicit_target_rides_the_provider_header(dialed: Dialed) -> None:
    client.post(
        BRIDGE_PATH,
        json=exhaust_job(),
        headers={PROVIDER_HEADER: "mediastore:agent:slm-trainer"},
    )
    assert dialed.specs[0]["provider"] == "mediastore:agent:slm-trainer"


def test_an_undescribed_record_file_is_a_graded_422(dialed: Dialed) -> None:
    job = exhaust_job(dataset={"records": ["ns:asset:blake3-a1", "ns:asset:blake3-b2"]})
    response = client.post(BRIDGE_PATH, json=job)
    assert response.status_code == 422
    assert [p["code"] for p in response.json()["problems"]] == [
        "header-missing",
        "header-missing",
    ]
    assert dialed.identities == []


def test_inlined_rows_are_refused(dialed: Dialed) -> None:
    job = exhaust_job(
        dataset={
            "records": ["ns:asset:blake3-a1"],
            "header": [exhaust_header(rows=[{"instruction": "x"}])],
        }
    )
    response = client.post(BRIDGE_PATH, json=job)
    assert response.status_code == 422
    assert response.json()["problems"][0]["code"] == "records-inlined"
    assert dialed.identities == []


def test_an_unreadable_body_is_a_usage_error() -> None:
    response = client.post(BRIDGE_PATH, content=b"not json")
    assert response.status_code == 400
    assert response.json()["status"] == "usage"


def test_a_non_object_body_is_a_usage_error() -> None:
    response = client.post(BRIDGE_PATH, json=[1, 2, 3])
    assert response.status_code == 400


def test_a_local_only_corpus_is_refused_a_cross_boundary_provider() -> None:
    """§4.2 on provider choice — and nothing is dialed to discover it."""
    dialed = Dialed()

    def _directory() -> Any:
        return lambda _spec: Selection(outcome="selected", provider=CLOUD, reason="sole")

    from agora_trainer.app import get_dispatch

    app.dependency_overrides[get_directory] = _directory
    app.dependency_overrides[get_dispatch] = dialed.dispatch
    try:
        response = client.post(BRIDGE_PATH, json=exhaust_job())
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 422
    assert response.json()["problems"][0]["code"] == "provider-egress"
    assert dialed.identities == []


def test_with_no_registry_configured_the_trainer_is_its_own_candidate() -> None:
    """The offline default: a deployment that indexes nothing still has one provider."""
    from agora_trainer.config import TrainerConfig

    selection = get_directory(TrainerConfig())({})
    assert selection.outcome == "selected"
    assert selection.provider is not None
    assert selection.provider.address == "http://127.0.0.1:8001/invoke"
    assert selection.provider.in_tier is True
