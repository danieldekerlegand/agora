"""Tier → concrete backend: what a ladder rung actually dials, and why it might not.

A backend is a base URL, a model id and (for the paid tier) a key. Every dispatchable
backend here speaks the **OpenAI wire format** — mlx-serve serves it natively, Ollama
exposes it at ``/v1``, and the OpenAI-compatible paid vendors need no translation. That is
what lets one dispatch path in :mod:`agora_provider_router.router` serve all four tiers.

Vendors whose HTTP surface is *not* OpenAI-shaped (Anthropic, Gemini, Replicate,
ElevenLabs, the video houses) are declared with ``wire="native"``: they are recognised and
reported, but resolve to ``pending-adapter`` rather than being dialed with a wire format
they do not speak. A per-vendor adapter is a later story; silently sending them OpenAI
JSON would be a fake tier that fails on every real request.

The mlx-serve endpoint/model table is ported from Analyzer
(``src/filmstudio/core/mlx_serve.py``) — the single source of the mlx-serve media routes.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from pydantic import SecretStr

from .config import RouterConfig
from .ladder import MODALITIES, PLACEHOLDER

Wire = Literal["openai", "native"]

#: Scores a candidate backend so the cheaper of two equally-usable ones can be preferred
#: (KCB §3, "path search prefers zero-cost routes"). Injected rather than imported so this
#: module stays free of pricing policy — see :mod:`agora_provider_router.cost`.
Rank = Callable[["Backend"], float]


@dataclass(frozen=True)
class PaidVendor:
    """A paid provider the router knows how to *rank*; ``wire`` says if it can dial it."""

    name: str
    wire: Wire
    base_url: str | None = None
    models: dict[str, str] | None = None


#: The paid vendors, keyed by name. Base URLs are defaults — a configured ``BASE_URL``
#: always wins (that is how one points ``openai`` at a compatible gateway).
PAID_VENDORS: dict[str, PaidVendor] = {
    "openai": PaidVendor(
        "openai",
        "openai",
        "https://api.openai.com/v1",
        {"text": "gpt-4o-mini", "image": "gpt-image-1", "speech": "gpt-4o-mini-tts"},
    ),
    "groq": PaidVendor(
        "groq", "openai", "https://api.groq.com/openai/v1", {"text": "llama-3.3-70b-versatile"}
    ),
    # The native-wire vendors declare their base URL too. This router cannot dial them (no
    # adapter — see the module docstring), but the vendor vocabulary ``/v1/providers``
    # publishes is shared with the Erlang router (agora:80), which can: a console reading
    # either one must see the same table, so the address is declared in both.
    "anthropic": PaidVendor("anthropic", "native", "https://api.anthropic.com/v1"),
    "gemini": PaidVendor("gemini", "native", "https://generativelanguage.googleapis.com/v1beta"),
    "replicate": PaidVendor("replicate", "native", "https://api.replicate.com/v1"),
    "elevenlabs": PaidVendor("elevenlabs", "native", "https://api.elevenlabs.io/v1"),
    "runway": PaidVendor("runway", "native", "https://api.dev.runwayml.com/v1"),
    "luma": PaidVendor("luma", "native", "https://api.lumalabs.ai/dream-machine/v1"),
    "minimax": PaidVendor("minimax", "native", "https://api.minimax.chat/v1"),
}

#: modality → paid vendors in preference order. Analyzer's per-skill orders, consolidated.
PAID_PROVIDERS: dict[str, tuple[str, ...]] = {
    "text": ("openai", "anthropic", "groq", "gemini"),
    "image": ("openai", "replicate"),
    "speech": ("elevenlabs", "openai"),
    "music": ("replicate",),
    "video": ("runway", "luma", "minimax"),
}

#: modality → OpenAI-shaped route the tier POSTs, relative to a backend's base URL.
ENDPOINTS: dict[str, str] = {
    "text": "/chat/completions",
    "image": "/images/generations",
    "speech": "/audio/speech",
    "music": "/audio/music-generations",
    "video": "/video/generations",
}

#: modality → mlx-serve default model id (the locally-downloaded set, per Analyzer).
MLX_MODELS: dict[str, str] = {
    "text": "mlx-community/Qwen3-8B-4bit",
    "image": "ddalcu/Krea-2-Turbo-MLX-Serve-mixed-4-8",
    "speech": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
    "music": "ddalcu/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit",
    "video": "dgrauet/ltx-2.3-mlx-q4",
}

#: modality → Ollama default model. Ollama is a text/vision stack: the other modalities
#: have no local tier there and fall straight through to the placeholder.
OLLAMA_MODELS: dict[str, str] = {"text": "llama3.2"}

#: Provider names of the keyless local tiers.
MLX_PROVIDER = "mlx-serve"
LOCAL_PROVIDER = "ollama"


@dataclass(frozen=True)
class Backend:
    """A dialable rung: everything :func:`~agora_provider_router.router.Router.complete`
    needs, and nothing a log may not print (the key is a ``SecretStr``)."""

    tier: str
    provider: str
    modality: str
    model: str
    base_url: str | None = None
    api_key: SecretStr | None = None

    @property
    def url(self) -> str:
        """The full endpoint for this backend's modality."""
        return f"{(self.base_url or '').rstrip('/')}{ENDPOINTS[self.modality]}"

    def describe(self) -> dict[str, object]:
        return {
            "tier": self.tier,
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
        }


@dataclass(frozen=True)
class TierResolution:
    """Why a rung is or is not usable — the body of the ``/doctor`` report."""

    tier: str
    status: Literal["ready", "unconfigured", "pending-adapter"]
    backend: Backend | None = None
    reason: str | None = None

    def describe(self) -> dict[str, object]:
        entry: dict[str, object] = {"tier": self.tier, "status": self.status}
        if self.backend is not None:
            entry.update(self.backend.describe())
        if self.reason:
            entry["reason"] = self.reason
        return entry


def placeholder_backend(modality: str) -> Backend:
    """The terminal rung. Free, offline, deterministic — always resolvable."""
    return Backend(
        tier=PLACEHOLDER, provider=PLACEHOLDER, modality=modality, model=f"{PLACEHOLDER}-{modality}"
    )


def resolve_tier(
    tier: str, modality: str, config: RouterConfig, rank: Rank | None = None
) -> TierResolution:
    """Resolve one rung for one modality against the configuration.

    Never dials anything: availability here is a *configuration* question. Whether a
    configured backend actually answers is a dispatch-time question, and a backend that
    does not answer falls through the same way an unconfigured one does.

    ``rank`` breaks the tie between several usable paid vendors; without it the declared
    :data:`PAID_PROVIDERS` order stands. Only the paid tier has a choice to make — the
    keyless tiers offer exactly one backend each.
    """
    if tier == "paid":
        return _resolve_paid(modality, config, rank)
    if tier == "mlx":
        return _resolve_keyless(tier, MLX_PROVIDER, MLX_MODELS, modality, config)
    if tier == "local":
        return _resolve_keyless(tier, LOCAL_PROVIDER, OLLAMA_MODELS, modality, config)
    raise ValueError(f"unknown tier {tier!r}")


def _resolve_paid(modality: str, config: RouterConfig, rank: Rank | None) -> TierResolution:
    vendors = PAID_PROVIDERS.get(modality, ())
    pending: list[str] = []
    ready: list[Backend] = []
    for name in vendors:
        settings = config.provider(name)
        if not (settings.has_key and settings.usable):
            continue
        vendor = PAID_VENDORS[name]
        if vendor.wire != "openai":
            pending.append(name)
            continue
        model = settings.model or (vendor.models or {}).get(modality)
        if model is None:
            pending.append(name)
            continue
        ready.append(
            Backend(
                tier="paid",
                provider=name,
                modality=modality,
                model=model,
                base_url=settings.base_url or vendor.base_url,
                api_key=settings.api_key,
            )
        )
    if ready:
        # ``min`` is stable, so an unranked call — or a tie — keeps the declared order.
        return TierResolution(
            tier="paid", status="ready", backend=ready[0] if rank is None else min(ready, key=rank)
        )
    if pending:
        return TierResolution(
            tier="paid",
            status="pending-adapter",
            reason=(
                f"{', '.join(pending)} has a key but no {modality} adapter for its native wire "
                "format — falling through rather than sending it OpenAI JSON"
            ),
        )
    return TierResolution(
        tier="paid",
        status="unconfigured",
        reason=f"no API key for any {modality} vendor ({', '.join(vendors) or 'none declared'})",
    )


def _resolve_keyless(
    tier: str, provider: str, models: dict[str, str], modality: str, config: RouterConfig
) -> TierResolution:
    """The mlx-serve / Ollama rungs: a base URL is the whole configuration.

    A base URL must be *configured* — the router never assumes a default localhost port.
    Probing one would make "no local servers" depend on whatever happens to be listening on
    the box, which is exactly the state the zero-spend invariant has to be able to assert.
    """
    settings = config.provider(provider)
    model = settings.model or models.get(modality)
    if model is None:
        return TierResolution(
            tier=tier,
            status="unconfigured",
            reason=f"{provider} serves no {modality} model",
        )
    if not settings.base_url:
        return TierResolution(
            tier=tier,
            status="unconfigured",
            reason=f"{provider} base URL not set",
        )
    if not settings.usable:
        return TierResolution(
            tier=tier, status="unconfigured", reason=f"{provider} explicitly disabled"
        )
    return TierResolution(
        tier=tier,
        status="ready",
        backend=Backend(
            tier=tier,
            provider=provider,
            modality=modality,
            model=model,
            base_url=settings.base_url,
        ),
    )


def known_modality(modality: str) -> bool:
    return modality in MODALITIES
