"""The KCB capability manifest (koine/specs/capability-bus.md §2)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_provider_router import KCB_VERSION, ROUTER_IDENTITY
from agora_provider_router.a2a import A2A_PATH, A2A_PROTOCOL_VERSION
from agora_provider_router.app import app, get_router
from agora_provider_router.ladder import MODALITIES
from agora_provider_router.manifest import (
    BASE_URL_ENV,
    KCB_MANIFEST_EXTENSION_URI,
    capability_manifest,
)
from agora_provider_router.mcp import MCP_PATH
from conftest import router_for


def card_for(**env: str) -> dict[str, Any]:
    """The full A2A AgentCard the router publishes (capability-bus.md §2/§6)."""
    return capability_manifest(router_for(**env))


def kcb_params(card: dict[str, Any]) -> dict[str, Any]:
    """The KCB manifest body — the params of the card's one KCB extension."""
    extensions = card["capabilities"]["extensions"]
    (extension,) = [e for e in extensions if e["uri"] == KCB_MANIFEST_EXTENSION_URI]
    params = extension["params"]
    assert isinstance(params, dict)
    return params


def manifest_for(**env: str) -> dict[str, Any]:
    """The KCB manifest body alone — most assertions here are about the payload, not the card."""
    return kcb_params(card_for(**env))


def capability(manifest: dict[str, Any], name: str) -> dict[str, Any]:
    found = next(c for c in manifest["capabilities"] if c["name"] == name)
    assert isinstance(found, dict)
    return found


class TestShape:
    def test_it_declares_the_spec_version_and_a_kinp_identity(self) -> None:
        manifest = manifest_for()
        assert manifest["kcb_version"] == KCB_VERSION
        assert manifest["identity"] == ROUTER_IDENTITY
        assert manifest["identity"].startswith("agora:agent:")

    def test_one_invocable_capability_per_modality(self) -> None:
        manifest = manifest_for()
        assert [c["name"] for c in manifest["capabilities"]] == [
            f"generate.{m}" for m in MODALITIES
        ]

    def test_endpoints_follow_the_configured_public_base_url(self) -> None:
        manifest = manifest_for(**{BASE_URL_ENV: "https://router.example/"})
        assert manifest["endpoints"]["openai"] == "https://router.example/v1"
        assert capability(manifest, "generate.text")["endpoint"] == (
            "https://router.example/v1/chat/completions"
        )

    def test_it_advertises_no_endpoint_it_does_not_serve(self) -> None:
        """A manifest address is a promise a peer will dial directly (ADR-0001 decision 3).

        ``mcp`` and ``a2a`` joined this set in the same change that stood the two surfaces up;
        :class:`TestEveryAdvertisedAddressAnswers` is what keeps the pin honest, since a key
        can be added here without anything answering it.
        """
        assert set(manifest_for()["endpoints"]) == {
            "openai",
            "mcp",
            "a2a",
            "doctor",
            "manifest",
        }

    def test_the_transport_endpoints_are_the_paths_their_modules_serve(self) -> None:
        """Spelled from the surfaces' own constants, so the two cannot drift apart."""
        manifest = manifest_for(**{BASE_URL_ENV: "https://router.example"})
        assert manifest["endpoints"]["mcp"] == f"https://router.example{MCP_PATH}"
        assert manifest["endpoints"]["a2a"] == f"https://router.example{A2A_PATH}"

    def test_auth_declares_the_grant_shape_and_the_spend_ceiling(self) -> None:
        auth = manifest_for()["auth"]
        assert auth["scheme"] == "capability-token"
        assert "invoke:generate.text" in auth["grants_required"]
        assert auth["budget_units"]["supported"] is True
        assert auth["budget_units"]["request_key"] == "budget_units"


class TestCard:
    """The A2A AgentCard wrapper (capability-bus.md §2/§6) — the KCB body rides as one extension."""

    def test_the_card_names_the_router_and_carries_one_kcb_extension(self) -> None:
        card = card_for()
        assert card["name"] == ROUTER_IDENTITY
        extensions = card["capabilities"]["extensions"]
        kcb = [e for e in extensions if e["uri"] == KCB_MANIFEST_EXTENSION_URI]
        assert len(kcb) == 1, "exactly one KCB manifest extension"
        assert kcb[0]["required"] is False

    def test_the_extension_params_are_the_kcb_manifest_body(self) -> None:
        params = kcb_params(card_for())
        assert params["kcb_version"] == KCB_VERSION
        assert params["identity"] == ROUTER_IDENTITY
        assert [c["name"] for c in params["capabilities"]] == [f"generate.{m}" for m in MODALITIES]

    def test_the_card_advertises_no_a2a_endpoint_it_does_not_serve(self) -> None:
        """The card's ``url`` is the A2A surface the router actually answers (ADR-0001 d.3).

        A reader that never unpacks the KCB extension still gets a dialable address — and it
        gets no address the router does not serve, which is the same rule read from the card
        side. The transport is stated rather than assumed.
        """
        card = card_for(**{BASE_URL_ENV: "https://router.example"})
        assert card["url"] == f"https://router.example{A2A_PATH}"
        assert card["preferredTransport"] == "JSONRPC"
        assert card["protocolVersion"] == A2A_PROTOCOL_VERSION

    def test_the_card_url_and_the_body_a2a_endpoint_are_the_one_address(self) -> None:
        """Two spellings of the same promise; a peer must not have to choose between them."""
        card = card_for(**{BASE_URL_ENV: "https://router.example"})
        assert card["url"] == kcb_params(card)["endpoints"]["a2a"]


class TestEveryAdvertisedAddressAnswers:
    """The advertisement is only worth what a peer gets when it dials it.

    Pinning the endpoint *key set* (:meth:`TestShape.test_it_advertises_no_endpoint_it_does_not
    _serve`) says which promises are made; this dials every one of them against the real app and
    says they are kept. Together they are the invariant ADR-0001 decision 3 rests on: the
    registry hands out addresses, so a dead one is a peer's failed connection, not ours.
    """

    def dial_url(self, url: str, request: dict[str, Any] | None = None) -> httpx.Response:
        """Dial an advertised URL's path against the real app, as a peer would dial the URL."""
        path = urlsplit(url).path
        # A lambda, not ``router_for`` itself: FastAPI reads a dependency's signature, and
        # ``**env`` would be taken for query parameters (a 422 before the route is ever run).
        app.dependency_overrides[get_router] = lambda: router_for()
        try:
            client = TestClient(app)
            answered: httpx.Response = (
                client.get(path) if request is None else client.post(path, json=request)
            )
            return answered
        finally:
            app.dependency_overrides.pop(get_router, None)

    def dial(self, name: str, request: dict[str, Any] | None = None) -> httpx.Response:
        """Take the advertised address for ``name`` and dial it."""
        return self.dial_url(manifest_for()["endpoints"][name], request)

    def test_the_mcp_address_answers_the_mcp_handshake(self) -> None:
        response = self.dial("mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert response.status_code == 200
        tools = response.json()["result"]["tools"]
        assert {t["name"] for t in tools} == {f"generate.{m}" for m in MODALITIES}

    def test_the_a2a_address_answers_a_message_send(self) -> None:
        response = self.dial(
            "a2a",
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "message/send",
                "params": {
                    "message": {
                        "role": "user",
                        "messageId": "m-1",
                        "parts": [{"kind": "text", "text": "what is the agora commons?"}],
                    }
                },
            },
        )
        assert response.status_code == 200
        assert response.json()["result"]["status"]["state"] == "completed"

    def test_the_read_only_addresses_answer_too(self) -> None:
        for name in ("doctor", "manifest"):
            assert self.dial(name).status_code == 200

    def test_the_openai_address_hosts_the_capability_endpoints(self) -> None:
        """``endpoints.openai`` is a base, not a route — what a caller dials is under it."""
        manifest = manifest_for()
        for entry in manifest["capabilities"]:
            assert entry["endpoint"].startswith(manifest["endpoints"]["openai"] + "/")
        text = capability(manifest, "generate.text")["endpoint"]
        answered = self.dial_url(text, {"model": "placeholder-text", "messages": [], "n": 1})
        assert answered.status_code == 200


class TestPorts:
    def test_ports_span_planes_text_in_media_out(self) -> None:
        """KCB §2.1 delta F: a capability may consume knowledge and produce media."""
        speech = capability(manifest_for(), "generate.speech")
        assert speech["inputs"] == [{"plane": "knowledge", "shape": "prompt-text"}]
        assert speech["outputs"][0]["plane"] == "media"
        assert speech["outputs"][0]["media_types"] == ["audio/wav"]

    def test_media_ports_carry_a_world_pattern(self) -> None:
        """Delta J: without one the registry cannot answer 'media from world X'."""
        for name in ("generate.image", "generate.speech", "generate.music", "generate.video"):
            port = capability(manifest_for(), name)["outputs"][0]
            assert port["world_pattern"] == "*"

    def test_text_stays_on_the_knowledge_plane(self) -> None:
        text = capability(manifest_for(), "generate.text")
        assert text["inputs"][0] == {"plane": "knowledge", "shape": "chat-messages"}
        assert text["outputs"][0] == {"plane": "knowledge", "shape": "completion-text"}

    def test_top_level_produces_and_consumes_are_deduped(self) -> None:
        manifest = manifest_for()
        assert manifest["produces"].count({"plane": "knowledge", "shape": "completion-text"}) == 1
        assert len(manifest["consumes"]) == 2, "chat-messages and prompt-text, once each"


class TestCost:
    def test_a_keyless_router_advertises_a_zero_cost_placeholder_tier(self) -> None:
        """What makes the registry's zero-cost preference (KCB §3) truthful."""
        for entry in manifest_for()["capabilities"]:
            assert entry["cost"] == {
                **entry["cost"],
                "tier": "placeholder",
                "est_units": 0.0,
                "unpriced": False,
            }

    def test_a_keyed_router_advertises_the_paid_rate(self) -> None:
        cost = capability(manifest_for(OPENAI_API_KEY="sk-test"), "generate.text")["cost"]
        assert cost["tier"] == "paid"
        assert cost["est_units"] > 0

    def test_cost_states_the_request_it_was_priced_against(self) -> None:
        """A price is only comparable between providers if the reference request is fixed."""
        cost = capability(manifest_for(OPENAI_API_KEY="sk-test"), "generate.video")["cost"]
        assert cost["basis"] == "5 seconds of video"
        assert cost["quantity"] == 5.0
        assert cost["unit"] == "second"

    def test_a_rate_override_moves_the_advertised_cost(self) -> None:
        manifest = manifest_for(OPENAI_API_KEY="sk-test", AGORA_PRICE_TEXT_OPENAI="0.5")
        assert capability(manifest, "generate.text")["cost"]["est_units"] == 500.0


class TestSecrets:
    def test_the_manifest_never_carries_a_key(self) -> None:
        rendered = str(manifest_for(OPENAI_API_KEY="sk-live-should-never-appear"))
        assert "sk-live" not in rendered


class TestTheRegistryFixture:
    """The TypeScript registry (US-AG4) indexes a captured copy of this manifest.

    ``registry/src/fixtures/provider-router.manifest.json`` is the zero-spend manifest
    *body* (the KCB extension's ``params``) byte-for-byte — the registry indexes the KCB body
    it reads off a peer's card, so the fixture is that body, not the whole AgentCard wrapper.
    This asserts the capture is still current — the same cross-language pin as the KCB version,
    one level up.

    If this fails, regenerate the fixture rather than editing it:

        cd provider-router && uv run python -c "..."   # see the command in the failure
    """

    FIXTURE = (
        Path(__file__).resolve().parents[2]
        / "registry"
        / "src"
        / "fixtures"
        / "provider-router.manifest.json"
    )

    @pytest.mark.skipif(
        not FIXTURE.exists(),
        reason=f"standalone checkout: {FIXTURE} (the TS registry fixture) is absent",
    )
    def test_the_captured_fixture_still_matches_what_the_router_publishes(self) -> None:
        captured = json.loads(self.FIXTURE.read_text(encoding="utf-8"))
        assert captured == manifest_for(), (
            f"{self.FIXTURE} is stale; regenerate it with:\n"
            "  cd provider-router && uv run python -c 'import json;"
            "from agora_provider_router.config import RouterConfig;"
            "from agora_provider_router.router import Router;"
            "from agora_provider_router.manifest import manifest_body;"
            "print(json.dumps(manifest_body("
            "Router(RouterConfig.from_env({}, read_file=False))), indent=2))'"
            f" > {self.FIXTURE}"
        )
