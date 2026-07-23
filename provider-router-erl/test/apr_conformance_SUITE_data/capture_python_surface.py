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
ceiling, so the paid rung is refused before it is contacted. A capture that opened a socket
to api.openai.com would be neither reproducible nor free.

Regenerate (from the repo root) with::

    uv --project provider-router run python \\
      provider-router-erl/test/apr_conformance_SUITE_data/capture_python_surface.py \\
      > provider-router-erl/test/apr_conformance_SUITE_data/python-surface.json
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
    ("bare", BARE_ENV, READS + GENERATIONS + CEILINGS),
    ("keyed", KEYED_ENV, READS + CEILINGS),
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
