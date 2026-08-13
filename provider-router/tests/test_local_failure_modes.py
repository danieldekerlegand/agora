"""A local backend's failure modes leave the always-completes ladder intact.

The local tier is the one rung whose *server* is the operator's own: nobody runs an SLA on
the Ollama on somebody's laptop, so every way it can go wrong is an ordinary state rather
than an exception. Absent, refusing connections, accepting them and never answering, or
answering with something that is not a completion — each is one more rung that did not
answer, and the walk continues to the deterministic zero-spend placeholder.

Two of these dial a **real socket on loopback** rather than a stand-in transport, because
the assertion is about ``http_transport`` itself: a connection error and a read timeout are
raised by ``httpx`` several layers under this router, and a test that fakes them proves the
``except`` clause rather than the path to it. No server is reached — the ports are a closed
one and one that accepts and says nothing.

``docs/router-hand-built-behaviours.md`` §2.3 asks any change to a dispatch path to re-prove
the ladder's guards on it. This tasklist touched ``dispatch_url``, ``dispatch_headers`` and
``http_transport``, so the last class here re-asserts the two that matter most — an
``unpriced`` rung never passes a ceiling, and ``resolve_all`` never raises — with a local
rung configured and in play.
"""

from __future__ import annotations

import socket
import threading
from collections.abc import Iterator
from contextlib import closing, contextmanager
from typing import Any

import pytest

from agora_provider_router.backends import Backend
from agora_provider_router.cost import RATES
from agora_provider_router.ladder import LOCAL_TIERS, MODALITIES, PLACEHOLDER, resolve_all
from agora_provider_router.router import Router, Transport
from conftest import config_for, recording_transport, router_for, run

#: A payload for every modality — the ladder walk does not care which, and the point is
#: that none of them can be made to raise.
PROMPT: dict[str, Any] = {"prompt": "hello", "messages": []}

#: tier → the env var that gives it an address.
BASE_URL_VARS: dict[str, str] = {"local": "OLLAMA_BASE_URL", "mlx": "MLX_SERVE_BASE_URL"}

#: The ladder variable these tests narrow to put one rung above the placeholder.
LADDER_VAR = "AGORA_TEXT_LADDER"


@contextmanager
def _dead_port() -> Iterator[int]:
    """A loopback port with nothing listening on it — a connection there is refused."""
    with closing(socket.socket()) as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
    yield port


@contextmanager
def _silent_port() -> Iterator[int]:
    """A loopback port that completes the handshake and never answers.

    ``listen`` without ``accept`` is enough: the kernel finishes the connection out of the
    backlog, so the client connects, sends its request and waits — which is the failure a
    model server loading a 20GB checkpoint actually presents.
    """
    with closing(socket.socket()) as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        yield int(server.getsockname()[1])


@contextmanager
def _answering_port(raw: bytes) -> Iterator[int]:
    """A loopback port that answers one request with ``raw`` verbatim, then closes."""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)

    def serve() -> None:
        try:
            connection, _ = server.accept()
        except OSError:  # torn down before anyone dialed it
            return
        with closing(connection):
            connection.recv(65536)
            connection.sendall(raw)

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield int(server.getsockname()[1])
    finally:
        server.close()
        thread.join(timeout=2)


def _http(body: bytes, content_type: bytes = b"application/json") -> bytes:
    return (
        b"HTTP/1.1 200 OK\r\nContent-Type: "
        + content_type
        + b"\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\nConnection: close\r\n\r\n"
        + body
    )


def _local_router(port: int) -> Router:
    """A router whose whole text ladder is one local rung at ``127.0.0.1:port``.

    The real transport, deliberately: what is being asserted is that ``http_transport``'s
    failures are the router's fall-throughs.
    """
    return router_for(
        **{LADDER_VAR: "local", BASE_URL_VARS["local"]: f"http://127.0.0.1:{port}/v1"}
    )


def _returning(value: Any, dialed: list[Backend]) -> Transport:
    """A transport that answers every rung with ``value``, whatever shape that is."""

    async def transport(backend: Backend, payload: dict[str, Any]) -> dict[str, Any]:
        dialed.append(backend)
        return value  # type: ignore[no-any-return]  # the point: a transport can lie

    return transport


class TestAnAbsentLocalBackend:
    """(a) unconfigured — the state a keyless, serverless box is in by default."""

    def test_every_modality_completes_with_the_local_tier_named_and_absent(self) -> None:
        dialed: list[Backend] = []
        env = {f"AGORA_{m.upper()}_LADDER": "local,mlx" for m in MODALITIES}
        router = Router(config_for(**env), recording_transport(dialed))
        for modality in MODALITIES:
            completion = run(router.complete(modality, PROMPT))
            assert completion.tier == PLACEHOLDER
            assert [a.dialed for a in completion.attempts[:-1]] == [False, False]
        assert dialed == []

    @pytest.mark.parametrize("tier", LOCAL_TIERS)
    def test_the_attempt_says_it_was_configuration_not_the_network(self, tier: str) -> None:
        """Absent is not unreachable: nothing was contacted, so nothing could have spent."""
        router = router_for(**{LADDER_VAR: tier})
        completion = run(router.complete("text", PROMPT))
        absent = completion.attempts[0]
        assert (absent.tier, absent.dialed, absent.ok) == (tier, False, False)
        assert absent.reason is not None and "base URL not set" in absent.reason


class TestALocalBackendThatIsNotListening:
    """(b) connection refused — the address is configured and the server is not running."""

    def test_a_refused_connection_falls_through_to_the_placeholder(self) -> None:
        with _dead_port() as port:
            completion = run(_local_router(port).complete("text", PROMPT))
        assert completion.tier == PLACEHOLDER
        local = completion.attempts[0]
        assert (local.tier, local.dialed, local.ok) == ("local", True, False)
        # Contacted and silent, not skipped: a budget audit must be able to tell them apart.
        assert local.reason is not None and "Error" in local.reason

    def test_the_response_is_still_a_usable_completion(self) -> None:
        """The caller gets an answer, not an error — that is the whole invariant."""
        with _dead_port() as port:
            completion = run(_local_router(port).complete("text", PROMPT))
        assert completion.response["choices"][0]["message"]["content"]
        assert completion.actual.units == 0.0


class TestALocalBackendThatNeverAnswers:
    """(c) timeout — accepted the connection, then went away."""

    def test_a_read_timeout_falls_through_to_the_placeholder(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The shipped deadline is 30s; a rung that hangs must not hold the request for it.
        monkeypatch.setattr("agora_provider_router.router.DEFAULT_TIMEOUT", 0.25)
        with _silent_port() as port:
            completion = run(_local_router(port).complete("text", PROMPT))
        assert completion.tier == PLACEHOLDER
        local = completion.attempts[0]
        assert (local.tier, local.dialed, local.ok) == ("local", True, False)
        assert local.reason is not None and "Timeout" in local.reason


class TestALocalBackendThatAnswersWithGarbage:
    """(d) malformed — it answered, and what it said is not a completion."""

    def test_a_body_that_is_not_json_at_all_falls_through(self) -> None:
        with _answering_port(_http(b"<html>502 Bad Gateway</html>", b"text/html")) as port:
            completion = run(_local_router(port).complete("text", PROMPT))
        assert completion.tier == PLACEHOLDER
        assert completion.attempts[0].ok is False

    def test_json_that_is_not_an_object_falls_through(self) -> None:
        """Decodable and still not an answer — the shape every modality is read out of."""
        with _answering_port(_http(b'["not", "a", "completion"]')) as port:
            completion = run(_local_router(port).complete("text", PROMPT))
        assert completion.tier == PLACEHOLDER
        local = completion.attempts[0]
        assert local.reason == "malformed response: expected a JSON object, got array"

    @pytest.mark.parametrize(
        ("answer", "named"),
        [
            (["a"], "array"),
            ("a string", "string"),
            (7, "number"),
            (7.5, "number"),
            (True, "boolean"),
            (None, "null"),
            (object(), "a non-JSON value"),
        ],
    )
    def test_every_non_object_answer_is_a_failed_attempt_not_an_exception(
        self, answer: Any, named: str
    ) -> None:
        """Stated at the transport boundary too: an injected transport can lie as easily
        as a backend can, and neither may reach the settlement that would relay it."""
        dialed: list[Backend] = []
        router = Router(
            config_for(**{LADDER_VAR: "local", BASE_URL_VARS["local"]: "http://ollama.test/v1"}),
            _returning(answer, dialed),
        )
        completion = run(router.complete("text", PROMPT))
        assert completion.tier == PLACEHOLDER
        assert [b.tier for b in dialed] == ["local"]
        assert completion.attempts[0].reason == (
            f"malformed response: expected a JSON object, got {named}"
        )
        # Dialed, so it may well have billed — the audit must not read it as a skip.
        assert completion.attempts[0].dialed is True

    def test_an_object_is_still_an_answer(self) -> None:
        """The guard refuses a shape, not a body: an empty object is a legal completion."""
        dialed: list[Backend] = []
        router = Router(
            config_for(**{LADDER_VAR: "local", BASE_URL_VARS["local"]: "http://ollama.test/v1"}),
            _returning({}, dialed),
        )
        completion = run(router.complete("text", PROMPT))
        assert completion.tier == "local"
        assert completion.response == {}


class TestTheGuardsOnTheTouchedDispatchPaths:
    """§2.3: a change to a dispatch path re-proves the ladder's guards on it."""

    def test_an_unpriced_rung_above_a_local_one_is_refused_without_being_dialed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The rule the ceiling rests on, restated with the local tier as the fall-through:
        'we don't know what this costs' must never route around a ceiling the way 'free'
        legitimately does."""
        monkeypatch.delitem(RATES["text"], "openai")
        dialed: list[Backend] = []
        router = Router(
            config_for(
                OPENAI_API_KEY="sk-live",
                **{BASE_URL_VARS["local"]: "http://ollama.test/v1", LADDER_VAR: "paid,local"},
            ),
            recording_transport(dialed),
        )
        completion = run(router.complete("text", {**PROMPT, "budget_units": 10**9}))
        assert completion.tier == "local"
        # Never contacted: the unpriced rung could not be proven affordable at any ceiling.
        assert [b.provider for b in dialed] == ["ollama"]
        paid = completion.attempts[0]
        assert paid.dialed is False
        assert paid.projected is not None and paid.projected.unpriced is True

    def test_a_free_local_rung_still_serves_a_ceiling_of_zero(self) -> None:
        """The other half of the same rule: free is *priced*, so it passes every ceiling."""
        dialed: list[Backend] = []
        router = Router(
            config_for(**{BASE_URL_VARS["local"]: "http://ollama.test/v1", LADDER_VAR: "local"}),
            recording_transport(dialed),
        )
        completion = run(router.complete("text", {**PROMPT, "budget_units": 0}))
        assert completion.tier == "local"
        assert completion.projected.units == 0.0 and completion.projected.unpriced is False

    def test_a_failed_local_rung_cannot_spend_below_it(self) -> None:
        """A fall-through is not a licence: the rung *under* a failed one is priced too."""
        dialed: list[Backend] = []
        router = Router(
            config_for(
                OPENAI_API_KEY="sk-live",
                **{BASE_URL_VARS["local"]: "http://ollama.test/v1", LADDER_VAR: "local,paid"},
            ),
            recording_transport(dialed, fail={"local"}),
        )
        completion = run(router.complete("text", {**PROMPT, "budget_units": 0}))
        assert completion.tier == PLACEHOLDER
        assert [b.provider for b in dialed] == ["ollama"]
        assert completion.attempts[1].dialed is False

    def test_resolve_all_never_raises_on_a_hostile_local_configuration(self) -> None:
        """``/doctor`` answers whatever the operator put in the environment."""
        hostile = {
            LADDER_VAR: "local,not-a-tier",
            BASE_URL_VARS["local"]: "://:::",
            BASE_URL_VARS["mlx"]: "   ",
            "AGORA_PREFER_LOCAL": "maybe",
        }
        report = resolve_all(config_for(**hostile).env)
        assert report["text"]["error"] is not None
        # And the same configuration through the whole doctor path, which resolves rungs.
        assert router_for(**hostile).doctor()["text"]["resolves_to"]["tier"] == "local"

    def test_no_local_failure_mode_raises_out_of_complete(self) -> None:
        """The invariant in one line, over every failure this file names."""
        broken: list[Transport] = [
            recording_transport([], fail={"local", "mlx"}),
            _returning(["garbage"], []),
            _returning(None, []),
        ]
        for transport in broken:
            router = Router(
                config_for(
                    **{
                        BASE_URL_VARS["local"]: "http://ollama.test/v1",
                        BASE_URL_VARS["mlx"]: "http://mlx.test/v1",
                    }
                ),
                transport,
            )
            for modality in MODALITIES:
                assert run(router.complete(modality, PROMPT)).tier == PLACEHOLDER
