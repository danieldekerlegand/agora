"""Tier → concrete backend: what a ladder rung actually dials, and why it might not.

A backend is a base URL, a model id and (for the paid tier) a key. Every dispatchable
backend here speaks the **OpenAI wire format** — mlx-serve serves it natively, Ollama
exposes it at ``/v1``, and the OpenAI-compatible paid vendors need no translation. That is
what lets one dispatch path in :mod:`agora_provider_router.router` serve all four tiers.

Vendors whose HTTP surface is *not* OpenAI-shaped (Anthropic, Gemini, Replicate,
ElevenLabs, the video houses) are declared with ``wire="native"``: they are recognised and
reported, but resolve to ``pending-adapter`` rather than being dialed with a wire format
they do not speak. Silently sending them OpenAI JSON would be a fake tier that fails on
every real request.

The adapters for some of them can be **borrowed** rather than written: with
``AGORA_LITELLM=1`` (:mod:`agora_provider_router.litellm_dispatch`) a native-wire vendor
LiteLLM covers *for the modality agora routes it for* resolves into a real rung instead. The
adapter is off by default and the rest of this module does not change shape when it is on —
an uncovered vendor is still ``pending-adapter``, which is an honest refusal.

The mlx-serve endpoint/model table is ported from Analyzer
(``src/filmstudio/core/mlx_serve.py``) — the single source of the mlx-serve media routes.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from ipaddress import ip_address
from typing import Literal
from urllib.parse import urlsplit

from pydantic import SecretStr

from .config import RouterConfig
from .ladder import MODALITIES, PLACEHOLDER
from .litellm_dispatch import dialable as litellm_dialable
from .litellm_dispatch import enabled as litellm_enabled

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
    # The native-wire vendors declare their base URL too. This router cannot dial them with
    # its own transport (no adapter — see the module docstring), but the vendor vocabulary
    # ``/v1/providers`` publishes is shared with the Erlang router (agora:80), which can: a
    # console reading either one must see the same table, so the address is declared in both.
    # The two with a borrowable LiteLLM adapter carry a default model as well, so enabling
    # ``AGORA_LITELLM`` is one variable rather than three; ``AGORA_PROVIDER_<NAME>_MODEL``
    # overrides it, and a model id ages faster than a vendor does.
    "anthropic": PaidVendor(
        "anthropic", "native", "https://api.anthropic.com/v1", {"text": "claude-sonnet-4-5"}
    ),
    "gemini": PaidVendor(
        "gemini",
        "native",
        "https://generativelanguage.googleapis.com/v1beta",
        {"text": "gemini-2.5-flash"},
    ),
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

#: The providers of those tiers, as a set. Their address is the operator's and nobody
#: else's: a client library will happily supply one (LiteLLM defaults ``ollama`` to
#: ``http://localhost:11434``), and inheriting it would make "no local server configured"
#: a statement about whatever happens to be listening on the box rather than about the
#: configuration. Every agora dispatch path overrides that default by refusing to dial
#: without an explicit one — see :func:`dispatch_url`, and
#: ``docs/local-backend-posture.md``, which states the whole posture (bind, auth, why the
#: default is never inherited).
LOCAL_PROVIDERS: frozenset[str] = frozenset({MLX_PROVIDER, LOCAL_PROVIDER})

#: Where a local backend's configured address puts it: on this machine's loopback
#: interface, or somewhere a packet has to leave the box to reach. Ollama and mlx-serve
#: ship unauthenticated and bound for local use, so the two are not the same deployment
#: and are not reported as the same thing (``docs/local-backend-posture.md``).
LocalBind = Literal["loopback", "remote"]


def local_bind(base_url: str | None) -> LocalBind | None:
    """Classify a local backend's address; ``None`` when there is none to classify.

    Anything not *demonstrably* loopback is ``remote``. A host this cannot parse, or one
    that only a resolver could settle, is the operator's to explain — and the safe reading
    of "I could not tell" is "it leaves the box", because that is the reading under which
    an unauthenticated backend is the operator's explicit choice rather than this module's
    silent one. Never resolves DNS: classification is a fact about the configuration.
    """
    if not base_url:
        return None
    # ``OLLAMA_HOST=localhost:11434`` is a real spelling, and to ``urlsplit`` a bare
    # ``host:port`` reads as scheme ``host`` — so an authority with no ``//`` is given one.
    raw = base_url.strip()
    candidate = raw if "//" in raw else f"//{raw}"
    try:
        host = urlsplit(candidate).hostname
    except ValueError:
        return "remote"
    if not host:
        return "remote"
    if host == "localhost" or host.endswith(".localhost"):
        return "loopback"
    try:
        return "loopback" if ip_address(host).is_loopback else "remote"
    except ValueError:
        return "remote"


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

    @property
    def bind(self) -> LocalBind | None:
        """Where a *local* rung is bound. ``None`` for every other backend: a paid vendor's
        address is public vocabulary, not a statement about anybody's network."""
        if self.provider not in LOCAL_PROVIDERS:
            return None
        return local_bind(self.base_url)

    def describe(self) -> dict[str, object]:
        entry: dict[str, object] = {
            "tier": self.tier,
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
        }
        # Reported only where it means something, so that a local rung's posture is visible
        # on ``/doctor`` without inventing a field for the eight vendors it cannot describe.
        if self.bind is not None:
            entry["bind"] = self.bind
        return entry


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


class UnconfiguredLocalAddress(RuntimeError):
    """A local rung reached a transport without an operator-configured base URL.

    :func:`resolve_tier` never yields such a rung, so this is the same rule held a second
    time at the dispatch boundary — the half that a *transport* has to obey, so that no
    library one is layered under can substitute an address nobody configured. Raised
    rather than dialed: to :meth:`~agora_provider_router.router.Router.complete` that is
    one more rung that did not answer, and the walk continues to the next one.
    """


def dispatch_url(backend: Backend) -> str:
    """The address ``backend`` is dialed at — never one nobody configured.

    Only the keyless local tiers are held to it: a paid rung dialed through a borrowed
    adapter legitimately carries no address of its own, because the adapter knows the
    vendor's (:mod:`agora_provider_router.litellm_dispatch`), and a vendor address is
    public vocabulary where a local one is a fact about an operator's machine.

    Where that machine *is* is a separate question, answered by :func:`local_bind` and
    reported rather than judged: a non-loopback local backend is dialed exactly as
    configured, and marked so that it never passes for a loopback one.
    """
    if backend.provider in LOCAL_PROVIDERS and not backend.base_url:
        raise UnconfiguredLocalAddress(
            f"{backend.provider} has no configured base URL — a local tier is never dialed "
            "at a default address, only at one an operator set"
        )
    return backend.url


def dispatch_headers(backend: Backend) -> dict[str, str]:
    """The headers ``backend`` is dialed with: JSON, plus auth iff one was configured.

    The local tiers are keyless *by default*, not by rule. Ollama and mlx-serve ship
    unauthenticated, so a stock one needs no credential — but an operator who has put one
    behind a reverse proxy has a credential for it, and ``AGORA_PROVIDER_OLLAMA_API_KEY``
    is carried here the same way a paid vendor's is. What this never does is invent one:
    with nothing configured there is no ``authorization`` header at all, rather than an
    empty bearer that a permissive backend would accept and a strict one would reject for
    the wrong reason. See ``docs/local-backend-posture.md``.
    """
    headers = {"content-type": "application/json"}
    if backend.api_key is not None and backend.api_key.get_secret_value():
        headers["authorization"] = f"Bearer {backend.api_key.get_secret_value()}"
    return headers


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
    borrowed = litellm_enabled(config.env)
    pending: list[str] = []
    ready: list[Backend] = []
    for name in vendors:
        settings = config.provider(name)
        if not (settings.has_key and settings.usable):
            continue
        vendor = PAID_VENDORS[name]
        native = vendor.wire != "openai"
        if native and not (borrowed and litellm_dialable(name, modality)):
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
                # A native rung's address belongs to LiteLLM, which knows each vendor's own;
                # only an explicit override is passed through, so ``/doctor`` reports exactly
                # what will be dialed rather than a default that is really vocabulary.
                base_url=settings.base_url if native else (settings.base_url or vendor.base_url),
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

    A credential is optional and, when set, carried (:func:`dispatch_headers`); an address
    that is not loopback still resolves, and is marked as the operator choice it is rather
    than passing for one. Both are ``docs/local-backend-posture.md``.
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
            # Keyless is the default posture, not the only one: an operator who
            # authenticated their local server configured a key, and it is dialed with.
            api_key=settings.api_key,
        ),
        # A ``reason`` on a *ready* rung is the one thing ``/doctor`` says about a rung it
        # is otherwise happy with — which is exactly the weight a remote-local address
        # deserves: allowed, because configured; never silent, because unauthenticated
        # local backends were designed for a loopback interface.
        reason=(
            None
            if local_bind(settings.base_url) == "loopback"
            else _remote_local_reason(provider, settings.base_url)
        ),
    )


def _remote_local_reason(provider: str, base_url: str | None) -> str:
    """Why a ready local rung still has something to say for itself."""
    return (
        f"{provider} is configured at a non-loopback address ({base_url}) — a local backend "
        "reached over a network, which is an explicit operator choice and not a default"
    )


def known_modality(modality: str) -> bool:
    return modality in MODALITIES
