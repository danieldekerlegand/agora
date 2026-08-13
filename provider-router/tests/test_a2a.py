"""The A2A surface (KCB §4 ``invoke``, as a task) — dialed directly, over HTTP.

Every test sends a real ``message/send`` at the served address in the shapes
``console/src/kcs/a2a-wire.ts`` sends them (camelCase keys, ``kind``-tagged parts), and
reads the returned Task the way that wire reads it. The endpoint's promise is that a peer
who read the card can dial it and be answered — so the assertions are on the wire, not on
the handler.
"""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agora_provider_router import ROUTER_IDENTITY
from agora_provider_router.a2a import A2A_PATH, A2A_PROTOCOL_VERSION, SEND_METHOD
from agora_provider_router.app import app, get_router
from agora_provider_router.backends import Backend
from agora_provider_router.cost import BUDGET_HEADER
from agora_provider_router.invoke import INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND
from agora_provider_router.ladder import PLACEHOLDER
from agora_provider_router.router import Router
from conftest import config_for, recording_transport, router_for


@pytest.fixture(autouse=True)
def _clean_overrides() -> Iterator[None]:
    yield
    app.dependency_overrides.clear()


def client_for(router: Router) -> TestClient:
    app.dependency_overrides[get_router] = lambda: router
    return TestClient(app)


@pytest.fixture
def zero_spend() -> TestClient:
    return client_for(router_for())


def message(text: str = "what is the agora commons?", **fields: Any) -> dict[str, Any]:
    """One A2A Message, in the wire shape the console's a2a wire sends."""
    return {
        "role": "user",
        "parts": [{"kind": "text", "text": text}],
        "messageId": "agora-test-message",
        "protocolVersion": A2A_PROTOCOL_VERSION,
        "fromAgent": "agora-console",
        **fields,
    }


def send(client: TestClient, msg: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    """One ``message/send``; returns the whole JSON-RPC envelope, errors included."""
    body = {"jsonrpc": "2.0", "id": 1, "method": SEND_METHOD, "params": {"message": msg}}
    decoded: dict[str, Any] = client.post(A2A_PATH, json=body, **kwargs).json()
    return decoded


def task(client: TestClient, msg: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    envelope = send(client, msg, **kwargs)
    assert "error" not in envelope, envelope
    result: dict[str, Any] = envelope["result"]
    return result


def spoken(result: dict[str, Any]) -> str:
    """The text of the terminal status message, as an A2A client reads it."""
    parts = result["status"]["message"]["parts"]
    return "\n".join(p["text"] for p in parts if p["kind"] == "text")


class TestOneTaskPerMessage:
    def test_a_message_completes_a_task_carrying_the_answer(self, zero_spend: TestClient) -> None:
        result = task(zero_spend, message())

        assert result["kind"] == "task"
        assert result["status"]["state"] == "completed"
        assert result["status"]["message"]["role"] == "agent"
        assert "[agora placeholder]" in spoken(result)
        assert result["metadata"]["agora"]["tier"] == PLACEHOLDER
        assert result["metadata"]["agora"]["modality"] == "text"

    def test_a_task_is_finished_when_it_is_answered(self, zero_spend: TestClient) -> None:
        """No task store, so the state is terminal on the first (and only) answer."""
        assert task(zero_spend, message())["status"]["state"] == "completed"
        assert send(zero_spend, message())["result"]["status"]["state"] == "completed"

    def test_the_ids_are_derived_from_the_request_not_drawn(self, zero_spend: TestClient) -> None:
        first = task(zero_spend, message("the same question"))
        second = task(zero_spend, message("the same question"))
        other = task(zero_spend, message("a different question"))

        assert first == second, "nothing random rides on this wire"
        assert other["id"] != first["id"]

    def test_a_caller_context_is_echoed_rather_than_replaced(self, zero_spend: TestClient) -> None:
        result = task(zero_spend, message(contextId="a-conversation"))
        assert result["contextId"] == "a-conversation"

    def test_a_notification_is_answered_with_no_body(self, zero_spend: TestClient) -> None:
        response = zero_spend.post(
            A2A_PATH, json={"jsonrpc": "2.0", "method": SEND_METHOD, "params": {}}
        )
        assert response.status_code == 202
        assert response.content == b""


class TestSelectingACapability:
    def test_a_message_with_no_capability_is_read_as_conversation(
        self, zero_spend: TestClient
    ) -> None:
        assert task(zero_spend, message())["metadata"]["agora"]["modality"] == "text"

    def test_metadata_names_the_capability(self, zero_spend: TestClient) -> None:
        msg = message("a clay tablet", metadata={"capability": "generate.image"})
        result = task(zero_spend, msg)
        assert result["metadata"]["agora"]["modality"] == "image"

    def test_a_data_part_names_it_too_and_carries_the_rest_of_the_request(self) -> None:
        payloads: list[dict[str, Any]] = []

        async def transport(backend: Backend, payload: dict[str, Any]) -> dict[str, Any]:
            payloads.append(payload)
            return {"data": []}

        client = client_for(Router(config_for(OPENAI_API_KEY="sk-test"), transport))
        msg = message("a clay tablet")
        msg["parts"].append({"kind": "data", "data": {"modality": "image", "size": "512x512"}})

        task(client, msg)

        (sent,) = payloads
        assert sent["prompt"] == "a clay tablet", "text parts become the prompt"
        assert sent["size"] == "512x512", "data parts steer the generation"
        assert "modality" not in sent, "the selector picks a ladder; it is not forwarded"

    def test_a_capability_this_router_does_not_offer_is_refused_by_name(
        self, zero_spend: TestClient
    ) -> None:
        envelope = send(zero_spend, message(metadata={"capability": "summarize.text"}))
        assert envelope["error"]["code"] == INVALID_PARAMS
        assert "generate.text" in envelope["error"]["message"]


class TestArtifacts:
    def test_media_comes_back_as_a_digested_artifact(self, zero_spend: TestClient) -> None:
        result = task(
            zero_spend, message("a clay tablet", metadata={"capability": "generate.image"})
        )

        (artifact,) = result["artifacts"]
        (part,) = artifact["parts"]
        assert part["kind"] == "file"
        assert part["file"]["mimeType"] == "image/png"
        digest = hashlib.sha256(base64.b64decode(part["file"]["bytes"])).hexdigest()
        assert artifact["metadata"]["digest"] == f"sha256:{digest}"

    def test_a_file_part_carries_bytes_or_a_uri_never_both(self, zero_spend: TestClient) -> None:
        """A2A's file union — and this router serves no artifact address to point at."""
        result = task(zero_spend, message("a lyre", metadata={"capability": "generate.music"}))
        (file,) = [part["file"] for artifact in result["artifacts"] for part in artifact["parts"]]
        assert "uri" not in file

    def test_every_capability_answers(self, zero_spend: TestClient) -> None:
        for modality in ("text", "image", "speech", "music", "video"):
            result = task(
                zero_spend, message("a marketplace at dawn", metadata={"modality": modality})
            )
            assert result["status"]["state"] == "completed"
            assert result["status"].get("message") or result.get("artifacts")


class TestTheCeiling:
    """KCB §5 over A2A: metadata is where a transport with no headers carries the ceiling."""

    def test_a_zero_ceiling_in_the_message_metadata_never_contacts_the_paid_rung(self) -> None:
        calls: list[Backend] = []
        client = client_for(
            Router(config_for(OPENAI_API_KEY="sk-test"), recording_transport(calls))
        )

        result = task(client, message(metadata={BUDGET_HEADER: 0}))

        assert calls == [], "a ceilinged rung must not be dialed, not merely lose"
        assert result["metadata"]["agora"]["tier"] == PLACEHOLDER

    def test_the_plain_spelling_works_too(self) -> None:
        calls: list[Backend] = []
        client = client_for(
            Router(config_for(OPENAI_API_KEY="sk-test"), recording_transport(calls))
        )

        task(client, message(metadata={"budget_units": 0}))

        assert calls == []

    def test_the_transport_header_is_honoured(self) -> None:
        calls: list[Backend] = []
        client = client_for(
            Router(config_for(OPENAI_API_KEY="sk-test"), recording_transport(calls))
        )

        task(client, message(), headers={BUDGET_HEADER: "0"})

        assert calls == []

    def test_an_unreadable_ceiling_is_refused_not_read_as_unlimited(
        self, zero_spend: TestClient
    ) -> None:
        envelope = send(zero_spend, message(metadata={"budget_units": "abc"}))
        assert envelope["error"]["code"] == INVALID_PARAMS
        assert "budget_units" in envelope["error"]["message"]


class TestItNeverRelays:
    """ADR-0001 decisions 3/7: peers dial each other directly; nothing routes through here."""

    def test_a_message_addressed_to_another_peer_is_refused_not_forwarded(self) -> None:
        calls: list[Backend] = []
        client = client_for(Router(config_for(), recording_transport(calls)))

        envelope = send(client, message(toAgent="example:agent:somebody-else"))

        assert envelope["error"]["code"] == INVALID_PARAMS
        assert "relays nothing" in envelope["error"]["message"]
        assert calls == []

    def test_a_message_addressed_to_this_router_is_served(self, zero_spend: TestClient) -> None:
        result = task(zero_spend, message(toAgent=ROUTER_IDENTITY))
        assert result["status"]["state"] == "completed"

    def test_the_answer_comes_from_this_router_in_its_own_name(
        self, zero_spend: TestClient
    ) -> None:
        result = task(zero_spend, message())
        assert result["status"]["message"]["fromAgent"] == ROUTER_IDENTITY


class TestRefusals:
    def test_a_method_this_surface_does_not_serve_is_refused_by_name(
        self, zero_spend: TestClient
    ) -> None:
        for method in ("message/stream", "tasks/get", "tasks/cancel"):
            envelope = zero_spend.post(
                A2A_PATH, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": {}}
            ).json()
            assert envelope["error"]["code"] == METHOD_NOT_FOUND
            assert method in envelope["error"]["message"]

    def test_a_send_with_no_message_is_refused(self, zero_spend: TestClient) -> None:
        envelope = zero_spend.post(
            A2A_PATH, json={"jsonrpc": "2.0", "id": 1, "method": SEND_METHOD, "params": {}}
        ).json()
        assert envelope["error"]["code"] == INVALID_PARAMS

    def test_a_body_that_is_not_a_request_is_an_invalid_request(
        self, zero_spend: TestClient
    ) -> None:
        response = zero_spend.post(A2A_PATH, json="not a request")
        assert response.status_code == 400
        assert response.json()["error"]["code"] == INVALID_REQUEST


class TestSecrets:
    def test_no_key_reaches_the_a2a_surface(self) -> None:
        client = client_for(router_for(OPENAI_API_KEY="sk-live-should-never-appear"))
        assert "sk-live" not in str(send(client, message()))
