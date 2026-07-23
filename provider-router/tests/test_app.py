"""The HTTP surface: OpenAI-compatible routes, /doctor, and no secrets anywhere on it."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agora_provider_router import KCB_VERSION, ROUTER_IDENTITY
from agora_provider_router.app import app, get_router
from agora_provider_router.backends import Backend
from agora_provider_router.cost import BUDGET_HEADER
from agora_provider_router.ladder import MODALITIES, PLACEHOLDER
from agora_provider_router.manifest import MANIFEST_PATH
from agora_provider_router.router import Router
from conftest import config_for, recording_transport, router_for

MLX = "http://localhost:8080/v1"


@pytest.fixture(autouse=True)
def _clean_overrides() -> Iterator[None]:
    """Undo any dependency override after each test — the app is module-level state."""
    yield
    app.dependency_overrides.clear()


def client_for(router: Router) -> TestClient:
    """A client whose requests are served by ``router`` instead of the process's."""
    app.dependency_overrides[get_router] = lambda: router
    return TestClient(app)


@pytest.fixture
def zero_spend() -> TestClient:
    """A client on a bare environment — the state every deployment starts in."""
    return client_for(router_for())


def test_chat_completions_is_openai_shaped_and_reports_its_tier(zero_spend: TestClient) -> None:
    response = zero_spend.post(
        "/v1/chat/completions",
        json={"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"]["role"] == "assistant"
    # The routing report rides alongside the OpenAI envelope, in the body and the headers.
    assert body["agora"]["tier"] == PLACEHOLDER
    assert body["agora"]["modality"] == "text"
    assert response.headers["x-agora-tier"] == PLACEHOLDER


def test_every_modality_has_a_route_and_all_of_them_answer(zero_spend: TestClient) -> None:
    routes = {
        "text": "/v1/chat/completions",
        "image": "/v1/images/generations",
        "speech": "/v1/audio/speech",
        "music": "/v1/audio/music-generations",
        "video": "/v1/video/generations",
    }
    assert set(routes) == set(MODALITIES)
    for modality, path in routes.items():
        response = zero_spend.post(path, json={"prompt": "a cat"})
        assert response.status_code == 200, path
        assert response.json()["agora"]["modality"] == modality


def test_doctor_reports_the_resolved_ladder_per_modality() -> None:
    dialed: list[Backend] = []
    router = Router(
        config_for(OPENAI_API_KEY="sk-live", MLX_SERVE_BASE_URL=MLX, AGORA_IMAGE_LADDER="mlx"),
        recording_transport(dialed),
    )
    client = client_for(router)

    report = client.get("/doctor").json()

    text = report["modalities"]["text"]
    assert text["ladder"] == ["paid", "mlx", "local", PLACEHOLDER]
    assert text["resolves_to"]["tier"] == "paid"
    assert [t["status"] for t in text["tiers"]] == ["ready", "ready", "unconfigured", "ready"]
    assert report["modalities"]["image"]["ladder"] == ["mlx", PLACEHOLDER]
    assert report["ladders"]["image"]["source"] == "env"
    # Diagnostics only: /doctor dials nothing.
    assert dialed == []


def test_no_endpoint_leaks_a_configured_key() -> None:
    client = client_for(router_for(OPENAI_API_KEY="sk-super-secret", MLX_SERVE_BASE_URL=MLX))
    for path in ("/health", "/doctor", "/v1/models", "/v1/providers", MANIFEST_PATH):
        assert "sk-super-secret" not in client.get(path).text, path


def test_the_kcb_manifest_is_served_for_the_registry_to_crawl(zero_spend: TestClient) -> None:
    manifest = zero_spend.get(MANIFEST_PATH).json()
    assert manifest["identity"] == ROUTER_IDENTITY
    assert manifest["kcb_version"] == KCB_VERSION
    assert [c["name"] for c in manifest["capabilities"]] == [f"generate.{m}" for m in MODALITIES]


def test_a_bare_deployment_prices_every_capability_at_the_placeholder(
    zero_spend: TestClient,
) -> None:
    """The deployable image's ZERO-SPEND contract, seen over the wire (US-5).

    A bare artifact — no keys, no local servers, exactly what the Dockerfile runs by
    default — must answer ``/doctor`` and the KCB manifest with every modality resolved
    to the placeholder tier at ``est_units`` 0. This is the always-completes invariant
    (`tests/test_zero_spend.py`) as a deployer observes it, not just as the router resolves
    it internally.
    """
    doctor = zero_spend.get("/doctor").json()
    for modality in MODALITIES:
        assert doctor["modalities"][modality]["resolves_to"]["tier"] == PLACEHOLDER

    manifest = zero_spend.get(MANIFEST_PATH).json()
    assert [c["name"] for c in manifest["capabilities"]] == [f"generate.{m}" for m in MODALITIES]
    for capability in manifest["capabilities"]:
        assert capability["cost"]["tier"] == PLACEHOLDER
        assert capability["cost"]["est_units"] == 0


def test_every_response_reports_what_it_cost(zero_spend: TestClient) -> None:
    response = zero_spend.post("/v1/chat/completions", json={"messages": []})
    cost = response.json()["agora"]["cost"]
    assert cost["currency"] == "budget_units"
    assert cost["actual_units"] == 0.0
    assert cost["budget_units"] is None
    assert response.headers["x-agora-cost-units"] == "0"


def test_a_budget_ceiling_in_the_body_downshifts_the_ladder() -> None:
    dialed: list[Backend] = []
    router = Router(config_for(OPENAI_API_KEY="sk-live"), recording_transport(dialed))
    client = client_for(router)

    body = client.post(
        "/v1/chat/completions", json={"messages": [], "max_tokens": 1000, "budget_units": 0}
    ).json()

    assert body["agora"]["tier"] == PLACEHOLDER
    assert body["agora"]["cost"]["budget_units"] == 0.0
    assert dialed == [], "a refused rung is never contacted"


def test_the_ceiling_can_arrive_as_a_header_for_a_stock_openai_client() -> None:
    dialed: list[Backend] = []
    router = Router(config_for(OPENAI_API_KEY="sk-live"), recording_transport(dialed))
    client = client_for(router)

    body = client.post(
        "/v1/chat/completions",
        json={"messages": [], "max_tokens": 1000},
        headers={BUDGET_HEADER: "0"},
    ).json()

    assert body["agora"]["tier"] == PLACEHOLDER
    assert dialed == []


def test_an_unreadable_ceiling_is_refused_rather_than_ignored(zero_spend: TestClient) -> None:
    """Dropping it would turn a typo into unlimited spend authority."""
    body = zero_spend.post("/v1/chat/completions", json={"messages": [], "budget_units": "lots"})
    assert body.status_code == 422
    header = zero_spend.post(
        "/v1/chat/completions", json={"messages": []}, headers={BUDGET_HEADER: "lots"}
    )
    assert header.status_code == 422


def test_models_lists_what_the_ladder_can_currently_resolve(zero_spend: TestClient) -> None:
    body = zero_spend.get("/v1/models").json()
    assert body["object"] == "list"
    # Bare environment: exactly one resolvable model per modality, all placeholders.
    assert [entry["agora"]["tier"] for entry in body["data"]] == [PLACEHOLDER] * len(MODALITIES)


def test_a_served_request_returns_the_backend_body_verbatim() -> None:
    upstream: dict[str, Any] = {"id": "chatcmpl-real", "object": "chat.completion", "choices": []}
    router = Router(
        config_for(MLX_SERVE_BASE_URL=MLX, AGORA_TEXT_LADDER="mlx"),
        recording_transport([], response=upstream),
    )
    client = client_for(router)

    body = client.post("/v1/chat/completions", json={"messages": []}).json()

    assert {k: v for k, v in body.items() if k != "agora"} == upstream
    assert body["agora"]["provider"] == "mlx-serve"


def test_a_non_object_body_is_a_client_error(zero_spend: TestClient) -> None:
    assert zero_spend.post("/v1/chat/completions", json=["not", "an", "object"]).status_code == 422
