"""The console's conformance fixture is a *capture* of this router, and this pins it.

US-AG5's console runs one KCS scenario against the provider-router. Its gate must not
open a socket, so the console replays a captured session — the manifest it crawls and the
one exchange it dials — from
``console/src/fixtures/provider-router.session.json``.

A capture is only worth anything while it is current, so this asserts the file still
matches what a zero-spend router publishes and answers. It is the same cross-language pin
as ``test_manifest.py::TestTheRegistryFixture``, one plane over: there the registry
indexes a real manifest, here the console dials a real exchange.

Regenerate rather than hand-edit — the failure message carries the command.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from agora_provider_router.app import app, get_router
from agora_provider_router.config import RouterConfig
from agora_provider_router.manifest import capability_manifest
from agora_provider_router.router import Router

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "console"
    / "src"
    / "fixtures"
    / "provider-router.session.json"
)

#: The console builds exactly this body: ``model`` echoed back from the capability the
#: manifest advertises, the chat-messages port, and the one wire hint the scenario states.
REQUEST: dict[str, Any] = {
    "model": "placeholder-text",
    "messages": [{"role": "user", "content": "In one sentence, what is the agora commons?"}],
    "max_tokens": 64,
}
#: The spend ceiling rides in the header the manifest advertises, so the body the router
#: hashes is the request itself — a ceiling is not part of what was asked for.
HEADERS = {"X-Agora-Budget-Units": "0"}
PATH = "/v1/chat/completions"


def zero_spend_router() -> Router:
    """A router with no keys and no local servers — the always-completes configuration."""
    return Router(RouterConfig.from_env({}, read_file=False))


def captured_session() -> dict[str, Any]:
    """The session the console replays: the crawled manifest plus the one exchange."""
    router = zero_spend_router()
    app.dependency_overrides[get_router] = zero_spend_router
    try:
        response = TestClient(app).post(PATH, json=REQUEST, headers=HEADERS)
    finally:
        app.dependency_overrides.pop(get_router, None)
    return {
        "captured_from": "http://127.0.0.1:8000",
        "manifest": capability_manifest(router),
        "exchange": {
            "method": "POST",
            "path": PATH,
            "headers": HEADERS,
            "request": REQUEST,
            "status": response.status_code,
            "response": response.json(),
        },
    }


class TestTheConsoleFixture:
    def test_the_captured_session_still_matches_what_the_router_answers(self) -> None:
        captured = json.loads(FIXTURE.read_text(encoding="utf-8"))
        assert captured == captured_session(), (
            f"{FIXTURE} is stale; regenerate it with:\n"
            '  cd provider-router && uv run python -c "import json,sys;'
            "sys.path.insert(0,'tests');"
            "from test_conformance_fixture import captured_session;"
            'print(json.dumps(captured_session(), indent=2))" '
            f"> {FIXTURE}"
        )

    def test_the_captured_exchange_is_the_zero_spend_tier(self) -> None:
        """The scenario's whole point: no keys, no servers, and it still completed free."""
        routing = captured_session()["exchange"]["response"]["agora"]
        assert routing["tier"] == "placeholder"
        assert routing["cost"]["actual_units"] == 0.0
        assert not any(attempt["dialed"] for attempt in routing["attempts"][:-1])
