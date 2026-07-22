"""The ZERO-SPEND / always-completes invariant.

This is the contract the whole ladder exists to keep: with no keys and no local servers,
every modality resolves to the deterministic placeholder, no call raises, and nothing is
dialed. If a future change breaks any assertion here, the router has started being able to
fail — or to spend — and that is not a test to relax.
"""

from __future__ import annotations

from agora_provider_router.backends import Backend
from agora_provider_router.ladder import MODALITIES, PLACEHOLDER
from agora_provider_router.placeholder import complete as placeholder_complete
from agora_provider_router.router import Router
from conftest import config_for, recording_transport, router_for, run


def test_a_bare_environment_resolves_every_modality_to_the_placeholder() -> None:
    router = router_for()
    for modality in MODALITIES:
        assert router.resolve(modality).tier == PLACEHOLDER
        # The placeholder is the ONLY ready rung — nothing else even claims to be usable.
        assert [b.tier for b in router.candidates(modality)] == [PLACEHOLDER]


def test_no_modality_raises_and_nothing_is_dialed() -> None:
    dialed: list[Backend] = []
    router = Router(config_for(), recording_transport(dialed))
    for modality in MODALITIES:
        completion = run(router.complete(modality, {"prompt": "hello"}))
        assert completion.tier == PLACEHOLDER
        assert completion.response
    assert dialed == []


def test_a_broken_ladder_variable_still_completes() -> None:
    """A bad env var degrades; it never denies service."""
    router = router_for(AGORA_TEXT_LADDER="not-a-tier")
    completion = run(router.complete("text", {"messages": []}))
    assert completion.tier == PLACEHOLDER
    assert "not-a-tier" in str(router.doctor()["text"]["error"])


def test_the_placeholder_is_deterministic_and_free() -> None:
    payload = {"messages": [{"role": "user", "content": "same"}], "temperature": 0.7}
    first = run(router_for().complete("text", payload))
    second = run(router_for().complete("text", dict(reversed(list(payload.items())))))
    assert first.response == second.response
    assert first.response["usage"]["total_tokens"] == 0
    assert "placeholder" in first.response["choices"][0]["message"]["content"]


def test_a_placeholder_artifact_declares_itself() -> None:
    """Nothing downstream may mistake a stand-in for a real render (KMI §2)."""
    for modality in ("image", "speech", "music", "video"):
        response = placeholder_complete(modality, {"prompt": "a cat"}, "placeholder")
        artifact = response["data"][0]
        assert artifact["placeholder"] is True
        assert artifact["media_type"].split("/")[0] in {"image", "audio", "video"}


def test_the_placeholder_stays_terminal_even_when_configured_away() -> None:
    """An operator can narrow the ladder to nothing; the router still answers."""
    router = router_for(AGORA_TEXT_LADDER="paid")
    completion = run(router.complete("text", {"messages": []}))
    assert completion.tier == PLACEHOLDER
    assert [a.tier for a in completion.attempts] == ["paid", PLACEHOLDER]
