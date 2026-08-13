"""Capture the Python router's external surface, byte for byte, as ct test data.

``apr_conformance_SUITE`` replays this corpus against the Erlang router and asserts the
answers are **identical bytes**, not merely equivalent JSON — key order, float spelling and
separators are all contract (a relayed body must survive a round trip unchanged).

The capture is taken through ``fastapi.testclient`` rather than a socket so it needs no
running server, and each environment is applied to ``os.environ`` wholesale so the record is
a function of the file alone: no ambient ``OPENAI_API_KEY`` or ``.env`` on the capturing host
can leak into it. ``AGORA_ENV_FILE`` names a path that does not exist, which pins the one
otherwise host-dependent byte on the surface — ``/doctor``'s ``config.env_file.path``.

The keyed environment never dials: every one of its exchanges carries a ``budget_units: 0``
ceiling — in the body, in the transport header, in an MCP argument or in A2A message metadata
— so the paid rung is refused before it is contacted. A capture that opened a socket to
api.openai.com would be neither reproducible nor free.

Regenerate (from the repo root) with::

    uv --project provider-router run python \\
      provider-router-erl/test/apr_conformance_SUITE_data/capture_python_surface.py \\
      > provider-router-erl/test/apr_conformance_SUITE_data/python-surface.json

Both halves of the equality are checked. ``apr_conformance_SUITE`` replays the capture
against the Erlang router — but only where rebar3 is installed, since ``make
check-router-erl`` skips otherwise. ``provider-router/tests/test_python_surface_corpus.py``
re-runs this script and diffs the bytes, so a Python change cannot silently leave the corpus
describing a surface no code produces (see ``docs/router-hand-built-behaviours.md``).
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

#: A path that cannot exist, so ``/doctor``'s env-file report is the same on every host.
ENV_FILE = "/nonexistent/agora-conformance/.env"
#: A fake key: it configures the paid rung so the ladder has something to refuse, and every
#: keyed exchange is ceilinged at zero so it is never sent anywhere.
FAKE_KEY = "sk-super-secret-not-a-real-key"

BARE_ENV = {"AGORA_ENV_FILE": ENV_FILE}
KEYED_ENV = {**BARE_ENV, "AGORA_PROVIDER_OPENAI_API_KEY": FAKE_KEY}

#: The console's captured request (``tests/test_conformance_fixture.py``), replayed here so
#: the two fixtures pin the same exchange from both sides.
CONSOLE_REQUEST: dict[str, Any] = {
    "model": "placeholder-text",
    "messages": [{"role": "user", "content": "In one sentence, what is the agora commons?"}],
    "max_tokens": 64,
}

READS = [
    ("GET", "/health", None, {}),
    ("GET", "/doctor", None, {}),
    ("GET", "/v1/models", None, {}),
    ("GET", "/v1/providers", None, {}),
    ("GET", "/.well-known/agent-card.json", None, {}),
    ("GET", "/.well-known/kcb-manifest.json", None, {}),
    # The MCP surface offers no server->client stream, and says so rather than hanging.
    ("GET", "/mcp", None, {}),
]


def rpc(method: str, params: dict[str, Any] | None = None, **fields: Any) -> dict[str, Any]:
    """One JSON-RPC request, as both transports take them."""
    return {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}, **fields}


def tool_call(tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return rpc("tools/call", {"name": tool, "arguments": arguments})


def send(text: str, **fields: Any) -> dict[str, Any]:
    """One ``message/send``, in the wire shape ``console/src/kcs/a2a-wire.ts`` sends."""
    message = {
        "role": "user",
        "parts": [{"kind": "text", "text": text}],
        "messageId": "agora-corpus-message",
        "kind": "message",
        "fromAgent": "agora-console",
        **fields,
    }
    return rpc("message/send", {"message": message})


#: The KCB §4 ``invoke`` verb on its two transports. Every id here is derived from the request
#: (``invoke.py::identifier``), so the bytes are a function of the corpus and not of the run —
#: which is the only reason a task id can be pinned at all.
#:
#: A malformed *body* is deliberately absent: both routers answer it with the same JSON-RPC
#: code at the same status, but the message quotes the parser's own prose, and CPython's
#: ``JSONDecodeError`` text is a detail of the host rather than this router's contract.
INVOCATIONS = [
    ("POST", "/mcp", rpc("initialize", {"protocolVersion": "2025-06-18"}), {}),
    ("POST", "/mcp", rpc("initialize", {"protocolVersion": "1999-01-01"}), {}),
    ("POST", "/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"}, {}),
    ("POST", "/mcp", rpc("ping"), {}),
    ("POST", "/mcp", rpc("tools/list"), {}),
    ("POST", "/mcp", tool_call("generate.text", {"prompt": "what is the agora commons?"}), {}),
    ("POST", "/mcp", tool_call("generate.image", {"prompt": "a clay tablet"}), {}),
    ("POST", "/mcp", tool_call("generate.speech", {"input": "the agora commons"}), {}),
    ("POST", "/mcp", tool_call("summarize.text", {}), {}),
    ("POST", "/mcp", rpc("resources/list"), {}),
    ("POST", "/mcp", ["not", "a", "request"], {}),
    ("POST", "/a2a", send("what is the agora commons?"), {}),
    ("POST", "/a2a", send("a clay tablet", metadata={"capability": "generate.image"}), {}),
    ("POST", "/a2a", send("a lyre", metadata={"modality": "music"}), {}),
    ("POST", "/a2a", send("in a conversation", contextId="a-conversation"), {}),
    ("POST", "/a2a", send("for somebody else", toAgent="example:agent:somebody-else"), {}),
    ("POST", "/a2a", send("summarize this", metadata={"capability": "summarize.text"}), {}),
    ("POST", "/a2a", rpc("message/stream"), {}),
    ("POST", "/a2a", rpc("message/send"), {}),
    ("POST", "/a2a", "not a request", {}),
]

#: The same two transports under a ceiling (KCB §5), in every spelling each one carries: the
#: transport header, an MCP argument, and A2A message metadata (which has no headers of its
#: own to put it in). Zero, so the paid rung is refused before it is contacted.
CEILINGED_INVOCATIONS = [
    (
        "POST",
        "/mcp",
        tool_call("generate.text", {"prompt": "hi", "budget_units": 0}),
        {},
    ),
    ("POST", "/mcp", tool_call("generate.text", {"prompt": "hi"}), {"X-Agora-Budget-Units": "0"}),
    ("POST", "/mcp", tool_call("generate.text", {"prompt": "hi", "budget_units": "abc"}), {}),
    ("POST", "/a2a", send("hi", metadata={"budget_units": 0}), {}),
    ("POST", "/a2a", send("hi", metadata={"X-Agora-Budget-Units": 0}), {}),
    ("POST", "/a2a", send("hi"), {"X-Agora-Budget-Units": "0"}),
    ("POST", "/a2a", send("hi", metadata={"budget_units": "abc"}), {}),
]

#: One generation per modality, on the OpenAI shape each route takes.
GENERATIONS = [
    ("POST", "/v1/chat/completions", CONSOLE_REQUEST, {}),
    (
        "POST",
        "/v1/images/generations",
        {"model": "placeholder-image", "prompt": "a clay tablet", "n": 1, "size": "512x512"},
        {},
    ),
    (
        "POST",
        "/v1/audio/speech",
        {"model": "placeholder-speech", "input": "the agora commons", "voice": "alloy"},
        {},
    ),
    (
        "POST",
        "/v1/audio/music-generations",
        {"model": "placeholder-music", "prompt": "a lyre", "duration": 8},
        {},
    ),
    (
        "POST",
        "/v1/video/generations",
        {"model": "placeholder-video", "prompt": "a marketplace at dawn", "seconds": 4},
        {},
    ),
]

#: The ceiling in both spellings, and the refusal of an unreadable one (the body form: the
#: header form is rejected by FastAPI's own validation, whose error shape is a framework
#: detail rather than this router's contract).
CEILINGS = [
    ("POST", "/v1/chat/completions", {**CONSOLE_REQUEST, "budget_units": 0}, {}),
    ("POST", "/v1/chat/completions", CONSOLE_REQUEST, {"X-Agora-Budget-Units": "0"}),
    ("POST", "/v1/chat/completions", {**CONSOLE_REQUEST, "budget_units": "abc"}, {}),
    ("POST", "/v1/chat/completions", {**CONSOLE_REQUEST, "budget_units": -5}, {}),
]

ENVIRONMENTS = [
    ("bare", BARE_ENV, READS + GENERATIONS + CEILINGS + INVOCATIONS + CEILINGED_INVOCATIONS),
    ("keyed", KEYED_ENV, READS + CEILINGS + CEILINGED_INVOCATIONS),
]

#: Response headers that are part of the contract (the rest — content-length, date — are the
#: server's own and differ between Starlette and cowboy by design).
REPORTED_HEADERS = (
    "x-agora-tier",
    "x-agora-provider",
    "x-agora-model",
    "x-agora-cost-units",
    "location",
)


def capture(env: dict[str, str], corpus: list[Any]) -> list[dict[str, Any]]:
    os.environ.clear()
    os.environ.update(env)

    from fastapi.testclient import TestClient

    from agora_provider_router.app import app, get_router

    get_router.cache_clear()
    client = TestClient(app)
    exchanges = []
    for method, path, request, headers in corpus:
        response = client.request(
            method, path, json=request, headers=headers, follow_redirects=False
        )
        exchanges.append(
            {
                "method": method,
                "path": path,
                "headers": headers,
                "request": request,
                "status": response.status_code,
                "response_headers": {
                    name: response.headers[name]
                    for name in REPORTED_HEADERS
                    if name in response.headers
                },
                # The exact bytes, as text. The suite compares these, not parsed JSON.
                "body": response.text,
            }
        )
    get_router.cache_clear()
    return exchanges


def main() -> None:
    captured = {
        "captured_from": "the Python provider-router (agora:50), via fastapi.testclient",
        "regenerate": (
            "uv --project provider-router run python "
            "provider-router-erl/test/apr_conformance_SUITE_data/capture_python_surface.py "
            "> provider-router-erl/test/apr_conformance_SUITE_data/python-surface.json"
        ),
        "environments": [
            {"name": name, "env": env, "exchanges": capture(env, corpus)}
            for name, env, corpus in ENVIRONMENTS
        ],
    }
    json.dump(captured, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
