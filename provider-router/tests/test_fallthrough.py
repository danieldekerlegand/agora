"""Tier resolution and fallthrough: paid → mlx-serve → local → placeholder."""

from __future__ import annotations

from agora_provider_router.backends import Backend, resolve_tier
from agora_provider_router.ladder import PLACEHOLDER
from agora_provider_router.router import Router
from conftest import config_for, recording_transport, router_for, run

MLX = "http://localhost:8080/v1"
OLLAMA = "http://localhost:11434/v1"

FULL_LADDER = {
    "OPENAI_API_KEY": "sk-live",
    "MLX_SERVE_BASE_URL": MLX,
    "OLLAMA_BASE_URL": OLLAMA,
}


def test_all_four_tiers_resolve_in_order_when_all_are_configured() -> None:
    router = router_for(**FULL_LADDER)
    assert [b.tier for b in router.candidates("text")] == ["paid", "mlx", "local", PLACEHOLDER]
    top = router.resolve("text")
    assert top.provider == "openai"
    assert top.url == "https://api.openai.com/v1/chat/completions"


def test_each_unavailable_tier_falls_through_to_the_next() -> None:
    dialed: list[Backend] = []
    router = Router(config_for(**FULL_LADDER), recording_transport(dialed, fail={"paid", "mlx"}))

    completion = run(router.complete("text", {"messages": []}))

    assert completion.tier == "local"
    assert [b.tier for b in dialed] == ["paid", "mlx", "local"]
    assert [(a.tier, a.ok) for a in completion.attempts] == [
        ("paid", False),
        ("mlx", False),
        ("local", True),
    ]
    assert completion.attempts[0].reason == "ConnectionError: openai is not listening"


def test_every_tier_failing_still_lands_on_the_placeholder() -> None:
    dialed: list[Backend] = []
    router = Router(
        config_for(**FULL_LADDER), recording_transport(dialed, fail={"paid", "mlx", "local"})
    )
    completion = run(router.complete("text", {"messages": []}))
    assert completion.tier == PLACEHOLDER
    assert len(dialed) == 3


def test_a_configured_backend_receives_its_own_model_and_the_payload() -> None:
    dialed: list[Backend] = []

    async def transport(backend: Backend, payload: dict[str, object]) -> dict[str, object]:
        dialed.append(backend)
        assert payload == {"model": "mlx-community/Qwen3-8B-4bit", "messages": [], "stream": False}
        return {"id": "ok"}

    router = Router(config_for(MLX_SERVE_BASE_URL=MLX, AGORA_TEXT_LADDER="mlx"), transport)
    completion = run(router.complete("text", {"messages": [], "stream": False}))

    assert completion.response == {"id": "ok"}
    assert dialed[0].url == f"{MLX}/chat/completions"


def test_a_local_tier_without_a_configured_base_url_is_not_probed() -> None:
    """No implicit localhost: 'no local servers' must not depend on what is listening."""
    resolution = resolve_tier("local", "text", config_for())
    assert resolution.status == "unconfigured"
    assert resolution.reason is not None and "base URL not set" in resolution.reason


def test_a_modality_the_local_stack_cannot_serve_skips_it() -> None:
    router = router_for(OLLAMA_BASE_URL=OLLAMA)
    # Ollama is a text stack; video has no local rung, so the placeholder is next.
    assert [b.tier for b in router.candidates("video")] == [PLACEHOLDER]
    assert [b.tier for b in router.candidates("text")] == ["local", PLACEHOLDER]


def test_a_native_wire_vendor_is_reported_rather_than_dialed_with_openai_json() -> None:
    resolution = resolve_tier("paid", "text", config_for(ANTHROPIC_API_KEY="sk-ant"))
    assert resolution.status == "pending-adapter"
    assert resolution.backend is None
    assert resolution.reason is not None and "anthropic" in resolution.reason


def test_paid_preference_order_picks_the_first_keyed_vendor() -> None:
    router = router_for(GROQ_API_KEY="gsk-live", OPENAI_API_KEY="sk-live")
    # 'openai' leads the text preference list regardless of env ordering.
    assert router.resolve("text").provider == "openai"
    assert router_for(GROQ_API_KEY="gsk-live").resolve("text").provider == "groq"


def test_prefer_local_never_dials_the_paid_tier() -> None:
    dialed: list[Backend] = []
    router = Router(config_for(AGORA_PREFER_LOCAL="1", **FULL_LADDER), recording_transport(dialed))
    completion = run(router.complete("text", {"messages": []}))
    assert completion.tier == "mlx"
    assert [b.tier for b in dialed] == ["mlx"]


def test_a_disabled_provider_is_skipped_even_with_a_key() -> None:
    router = router_for(AGORA_PROVIDER_OPENAI_ENABLED="0", **FULL_LADDER)
    assert router.resolve("text").tier == "mlx"


def test_a_backends_key_never_reaches_a_failure_reason() -> None:
    async def leaky(backend: Backend, payload: dict[str, object]) -> dict[str, object]:
        assert backend.api_key is not None
        # A real transport error quotes the URL it dialed, which can carry a credential.
        raise ConnectionError(
            f"failed to POST {backend.url}?key={backend.api_key.get_secret_value()}"
        )

    router = Router(config_for(OPENAI_API_KEY="sk-live", AGORA_TEXT_LADDER="paid"), leaky)
    completion = run(router.complete("text", {"messages": []}))
    assert "sk-live" not in str(completion.routing())
