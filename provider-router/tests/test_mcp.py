"""The MCP surface (KCB §4 ``invoke``, as a tool call) — dialed directly, over HTTP.

Every test here drives the real handshake through the app: ``initialize`` →
``notifications/initialized`` → ``tools/list`` → ``tools/call``, the sequence
``console/src/kcs/mcp-wire.ts`` performs. That is deliberate — the endpoint's promise is
that a peer who read the manifest can dial *this address* and be answered, so asserting on
the handler alone would prove the wrong thing.
"""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agora_provider_router import ROUTER_IDENTITY, __version__
from agora_provider_router.app import app, get_router
from agora_provider_router.backends import Backend
from agora_provider_router.cost import BUDGET_HEADER
from agora_provider_router.invoke import (
    CAPABILITIES,
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
)
from agora_provider_router.ladder import PLACEHOLDER
from agora_provider_router.mcp import (
    LATEST_PROTOCOL_VERSION,
    MCP_PATH,
    META_ROUTING_KEY,
    PROTOCOL_VERSIONS,
)
from agora_provider_router.router import Router, Transport
from conftest import config_for, recording_transport, router_for


@pytest.fixture(autouse=True)
def _clean_overrides() -> Iterator[None]:
    yield
    app.dependency_overrides.clear()


def client_for(router: Router) -> TestClient:
    """A client whose requests are served by ``router`` instead of the process's."""
    app.dependency_overrides[get_router] = lambda: router
    return TestClient(app)


@pytest.fixture
def zero_spend() -> TestClient:
    return client_for(router_for())


def _recorder(payloads: list[dict[str, Any]]) -> Transport:
    """A transport that records the body each rung was dialed with, and answers with text."""

    async def transport(backend: Backend, payload: dict[str, Any]) -> dict[str, Any]:
        payloads.append(payload)
        return {"choices": [{"message": {"role": "assistant", "content": "an answer"}}]}

    return transport


def rpc(
    client: TestClient, method: str, params: dict[str, Any] | None = None, **kwargs: Any
) -> dict[str, Any]:
    """One JSON-RPC call at the MCP address. Returns the whole envelope, errors included."""
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    response = client.post(MCP_PATH, json=body, **kwargs)
    decoded: dict[str, Any] = response.json()
    return decoded


def call_tool(
    client: TestClient, tool: str, arguments: dict[str, Any] | None = None, **kwargs: Any
) -> dict[str, Any]:
    envelope = rpc(client, "tools/call", {"name": tool, "arguments": arguments or {}}, **kwargs)
    assert "error" not in envelope, envelope
    result: dict[str, Any] = envelope["result"]
    return result


def blocks(result: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [block for block in result["content"] if block["type"] == kind]


class TestTheHandshake:
    """What an MCP client does before it can call anything (mcp-wire.ts steps 1-3)."""

    def test_initialize_answers_in_the_version_the_client_asked_for(
        self, zero_spend: TestClient
    ) -> None:
        for version in PROTOCOL_VERSIONS:
            result = rpc(zero_spend, "initialize", {"protocolVersion": version})["result"]
            assert result["protocolVersion"] == version

    def test_an_unknown_protocol_version_is_answered_in_this_servers_latest(
        self, zero_spend: TestClient
    ) -> None:
        """What the transport spec requires of a server that cannot meet the request."""
        result = rpc(zero_spend, "initialize", {"protocolVersion": "1999-01-01"})["result"]
        assert result["protocolVersion"] == LATEST_PROTOCOL_VERSION

    def test_initialize_names_the_router_and_declares_its_tool_capability(
        self, zero_spend: TestClient
    ) -> None:
        result = rpc(zero_spend, "initialize", {"protocolVersion": LATEST_PROTOCOL_VERSION})[
            "result"
        ]
        assert result["serverInfo"] == {"name": ROUTER_IDENTITY, "version": __version__}
        assert result["capabilities"]["tools"] == {"listChanged": False}
        assert "relays" in result["instructions"], "the surface says what it will not do"

    def test_a_notification_is_answered_with_no_body(self, zero_spend: TestClient) -> None:
        """``notifications/initialized`` carries no id, so JSON-RPC says answer nothing."""
        response = zero_spend.post(
            MCP_PATH, json={"jsonrpc": "2.0", "method": "notifications/initialized"}
        )
        assert response.status_code == 202
        assert response.content == b""

    def test_ping_answers_empty(self, zero_spend: TestClient) -> None:
        assert rpc(zero_spend, "ping")["result"] == {}

    def test_no_session_is_issued(self, zero_spend: TestClient) -> None:
        """Stateless: nothing per-caller accumulates, so there is no session id to echo."""
        response = zero_spend.post(
            MCP_PATH, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
        )
        assert "mcp-session-id" not in response.headers

    def test_the_get_stream_is_refused_rather_than_left_hanging(
        self, zero_spend: TestClient
    ) -> None:
        response = zero_spend.get(MCP_PATH)
        assert response.status_code == 405
        assert response.json()["error"]["code"] == METHOD_NOT_FOUND


class TestTheToolCatalogue:
    def test_one_tool_per_capability_named_as_the_manifest_names_it(
        self, zero_spend: TestClient
    ) -> None:
        """The advertised capability IS the tool name — no second vocabulary to drift."""
        tools = rpc(zero_spend, "tools/list")["result"]["tools"]
        assert [tool["name"] for tool in tools] == list(CAPABILITIES)

    def test_every_tool_declares_an_input_schema_and_requires_nothing(
        self, zero_spend: TestClient
    ) -> None:
        """Nothing is required because the ladder completes whatever it is handed."""
        for tool in rpc(zero_spend, "tools/list")["result"]["tools"]:
            schema = tool["inputSchema"]
            assert schema["type"] == "object"
            assert "prompt" in schema["properties"]
            assert "budget_units" in schema["properties"]
            assert "required" not in schema

    def test_the_text_tool_also_takes_an_openai_transcript(self, zero_spend: TestClient) -> None:
        tools = rpc(zero_spend, "tools/list")["result"]["tools"]
        (text,) = [t for t in tools if t["name"] == "generate.text"]
        assert text["inputSchema"]["properties"]["messages"]["type"] == "array"


class TestInvoking:
    def test_a_text_tool_call_answers_with_the_completion_and_its_routing(
        self, zero_spend: TestClient
    ) -> None:
        result = call_tool(zero_spend, "generate.text", {"prompt": "what is the agora commons?"})

        (spoken,) = blocks(result, "text")
        assert "[agora placeholder]" in spoken["text"]
        assert result.get("isError") is None
        routing = result["_meta"][META_ROUTING_KEY]
        assert routing["tier"] == PLACEHOLDER
        assert routing["modality"] == "text"
        assert routing["cost"]["actual_units"] == 0

    def test_a_prompt_argument_becomes_the_transcript_the_backend_is_dialed_with(self) -> None:
        """A client that knows only "prompt" still reaches an OpenAI-shaped backend."""
        payloads: list[dict[str, Any]] = []
        client = client_for(Router(config_for(OPENAI_API_KEY="sk-test"), _recorder(payloads)))

        call_tool(client, "generate.text", {"prompt": "spelled the plain way", "max_tokens": 8})

        (sent,) = payloads
        assert sent["messages"] == [{"role": "user", "content": "spelled the plain way"}]
        assert sent["max_tokens"] == 8, "every non-prompt argument steers the generation"
        assert "prompt" not in sent

    def test_an_openai_shaped_transcript_wins_over_a_prompt(self) -> None:
        payloads: list[dict[str, Any]] = []
        client = client_for(Router(config_for(OPENAI_API_KEY="sk-test"), _recorder(payloads)))

        call_tool(
            client,
            "generate.text",
            {"messages": [{"role": "user", "content": "the OpenAI way"}], "prompt": "ignored"},
        )

        (sent,) = payloads
        assert sent["messages"] == [{"role": "user", "content": "the OpenAI way"}]

    def test_a_media_tool_call_answers_with_a_digested_resource(
        self, zero_spend: TestClient
    ) -> None:
        """The digest is over the bytes, so a caller can verify what it was handed."""
        result = call_tool(zero_spend, "generate.image", {"prompt": "a clay tablet"})

        (resource,) = [block["resource"] for block in blocks(result, "resource")]
        assert resource["mimeType"] == "image/png"
        digest = hashlib.sha256(base64.b64decode(resource["blob"])).hexdigest()
        assert resource["uri"] == f"agora:artifact:sha256:{digest}"

    def test_every_capability_is_callable(self, zero_spend: TestClient) -> None:
        for capability in CAPABILITIES:
            result = call_tool(zero_spend, capability, {"prompt": "a lyre at dawn"})
            assert result["content"], f"{capability} answered with nothing"
            assert result["_meta"][META_ROUTING_KEY]["tier"] == PLACEHOLDER

    def test_the_same_call_twice_is_byte_identical(self, zero_spend: TestClient) -> None:
        """Nothing random rides on the wire — the corpus (agora:80) needs that to hold."""
        first = call_tool(zero_spend, "generate.image", {"prompt": "a clay tablet"})
        second = call_tool(zero_spend, "generate.image", {"prompt": "a clay tablet"})
        assert first == second


class TestTheCeiling:
    """KCB §5 over MCP: the header the manifest advertises is the one the wire carries."""

    def test_a_zero_ceiling_in_the_header_never_contacts_the_paid_rung(self) -> None:
        calls: list[Backend] = []
        client = client_for(
            Router(config_for(OPENAI_API_KEY="sk-test"), recording_transport(calls))
        )

        result = call_tool(client, "generate.text", {"prompt": "hi"}, headers={BUDGET_HEADER: "0"})

        assert calls == [], "a ceilinged rung must not be dialed, not merely lose"
        assert result["_meta"][META_ROUTING_KEY]["tier"] == PLACEHOLDER

    def test_a_zero_ceiling_in_the_arguments_does_the_same(self) -> None:
        calls: list[Backend] = []
        client = client_for(
            Router(config_for(OPENAI_API_KEY="sk-test"), recording_transport(calls))
        )

        call_tool(client, "generate.text", {"prompt": "hi", "budget_units": 0})

        assert calls == []

    def test_an_unreadable_ceiling_is_a_tool_error_not_an_unbudgeted_call(
        self, zero_spend: TestClient
    ) -> None:
        result = rpc(
            zero_spend,
            "tools/call",
            {"name": "generate.text", "arguments": {"prompt": "hi", "budget_units": "abc"}},
        )["result"]

        assert result["isError"] is True
        assert "budget_units" in result["content"][0]["text"]


class TestRefusals:
    def test_an_unknown_tool_is_refused_by_name(self, zero_spend: TestClient) -> None:
        envelope = rpc(zero_spend, "tools/call", {"name": "summarize.text", "arguments": {}})
        assert envelope["error"]["code"] == INVALID_PARAMS
        assert "generate.text" in envelope["error"]["message"], "the refusal lists what exists"

    def test_an_unknown_method_is_refused(self, zero_spend: TestClient) -> None:
        assert rpc(zero_spend, "resources/list")["error"]["code"] == METHOD_NOT_FOUND

    def test_a_body_that_is_not_json_is_a_parse_error(self, zero_spend: TestClient) -> None:
        response = zero_spend.post(
            MCP_PATH, content=b"{not json", headers={"content-type": "application/json"}
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == PARSE_ERROR

    def test_a_body_that_is_not_a_request_is_an_invalid_request(
        self, zero_spend: TestClient
    ) -> None:
        response = zero_spend.post(MCP_PATH, json=["not", "a", "request"])
        assert response.status_code == 400
        assert response.json()["error"]["code"] == INVALID_REQUEST


class TestItNeverRelays:
    """ADR-0001 decisions 3/7: peers dial each other directly; nothing routes through here."""

    def test_no_tool_takes_a_peer_address(self, zero_spend: TestClient) -> None:
        tools = rpc(zero_spend, "tools/list")["result"]["tools"]
        for tool in tools:
            declared = set(tool["inputSchema"]["properties"])
            assert not declared & {"url", "endpoint", "base_url", "peer", "target"}

    def test_an_argument_naming_a_peer_is_never_dialed(self) -> None:
        """A forwarding address in the arguments is just an argument — it dials nothing."""
        calls: list[Backend] = []
        client = client_for(Router(config_for(), recording_transport(calls)))

        result = call_tool(
            client,
            "generate.text",
            {"prompt": "hi", "base_url": "http://peer.invalid/v1", "url": "http://peer.invalid"},
        )

        assert calls == [], "the only backends this surface dials are its own ladder's"
        assert result["_meta"][META_ROUTING_KEY]["tier"] == PLACEHOLDER


class TestSecrets:
    def test_no_key_reaches_the_mcp_surface(self) -> None:
        client = client_for(router_for(OPENAI_API_KEY="sk-live-should-never-appear"))

        rendered = "".join(
            str(rpc(client, method, params))
            for method, params in (
                ("initialize", {}),
                ("tools/list", {}),
                ("tools/call", {"name": "generate.text", "arguments": {"prompt": "hi"}}),
            )
        )

        assert "sk-live" not in rendered
