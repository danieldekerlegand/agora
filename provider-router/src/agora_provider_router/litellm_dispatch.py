"""Optional dispatch through LiteLLM — its vendor adapters, and nothing else.

US-1's spike (``docs/spike-litellm-leaf.md``) asked which of this router's behaviours are
commodity. The answer was narrow. LiteLLM owns **vendor wire adapters plus a maintained
price map**; agora owns the ladder, the per-request ceiling, the placeholder rung, the cost
model and the KCB manifest — and the spike found no LiteLLM mechanism for any of those. This
module is the one borrowed piece.

**What it delegates.** Exactly the paid-tier vendors :mod:`agora_provider_router.backends`
declares with ``wire="native"`` — vendors whose HTTP surface is not OpenAI-shaped, which the
router can name and rank but has never been able to dial (they resolve to ``pending-adapter``
rather than being sent a wire format they do not speak). With the adapter on, the covered
ones become real rungs.

**What it deliberately leaves alone.** The OpenAI-wire paid vendors, mlx-serve and Ollama are
one OpenAI POST already (:func:`~agora_provider_router.router.http_transport`) and gain
nothing from a second abstraction — routing them through LiteLLM would only add a translation
that can disagree with the endpoint table in :data:`~agora_provider_router.backends.ENDPOINTS`.
And nothing here touches the ladder order, the pre-dial ceiling (``Attempt.dialed``), the
terminal placeholder, ``cost.py``'s ``unpriced`` rule / ``budget_units`` denomination, or the
AgentCard. A rung refused on price is refused *before* this module is reached, so turning the
adapter on cannot make a zero-budget request spend anything.

Which vendors are actually covered
----------------------------------
The spike found LiteLLM adapters for five of the seven native-wire vendors, but coverage has
to line up with the *modality agora routes each vendor for* (:data:`PAID_PROVIDERS`), and on
that test only two survive:

===========  ==============================  ====================================================
vendor       agora routes it for             status
===========  ==============================  ====================================================
anthropic    text                            **covered** — ``anthropic/`` chat
gemini       text                            **covered** — ``gemini/`` chat
replicate    image, music                    gap: LiteLLM prices replicate for *chat* only
minimax      video                           gap: LiteLLM covers its chat/speech, not video
elevenlabs   speech                          gap: ``aspeech`` returns a binary stream, and this
                                             router's ``/v1/audio/speech`` relays a JSON body
runway       video                           gap: no LiteLLM adapter at all
luma         video                           gap: no LiteLLM adapter at all
===========  ==============================  ====================================================

Those gaps are recorded rather than forced: a vendor absent from :data:`NATIVE_ADAPTERS` keeps
resolving to ``pending-adapter``, which is an honest refusal, where guessing at a translation
would be a fake tier that fails on every real request.

Off by default
--------------
The adapter is opt-in via :data:`ENABLE_ENV` (``AGORA_LITELLM=1``) and LiteLLM is an optional
extra (``pip install 'agora-provider-router[litellm]'``), for two reasons:

* **Weight.** 86 declared dependencies, ~166 MB installed, for two new dialable vendors. That
  is a deployment's call to make, not this package's.
* **The byte-for-byte corpus.** The canonical router is Erlang (ADR-0004) and
  ``apr_conformance_SUITE`` asserts the two surfaces answer with identical *bytes*. LiteLLM is
  a Python library with no Erlang half, so the Python router's **default** surface has to stay
  exactly what it was. Keying the adapter off an ``AGORA_*`` variable — which that suite
  scrubs before every case — is what keeps the corpus a function of the fixture.
"""

from __future__ import annotations

import importlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover — imported for types only, so there is no import cycle
    from .backends import Backend
    from .router import Transport

#: Turns the adapter on. Part of the ``AGORA_*`` block :class:`RouterConfig` already keeps, so
#: it needs no separate plumbing — and so the Erlang conformance suite scrubs it.
ENABLE_ENV = "AGORA_LITELLM"

_TRUTHY = frozenset({"1", "true", "yes", "on"})


@dataclass(frozen=True)
class Adapter:
    """A native-wire vendor LiteLLM can dial on agora's behalf.

    ``provider`` is LiteLLM's provider prefix (the ``anthropic`` of
    ``anthropic/claude-sonnet-4-5``); ``modalities`` is the subset of agora's modalities the
    adapter is claimed for, and every entry must be a key of :data:`CALLS`.
    """

    provider: str
    modalities: tuple[str, ...]


#: agora vendor name → its LiteLLM adapter. Only the vendor/modality pairs verified against
#: the library are listed; see the module docstring for the five that are not, and why.
NATIVE_ADAPTERS: dict[str, Adapter] = {
    "anthropic": Adapter("anthropic", ("text",)),
    "gemini": Adapter("gemini", ("text",)),
}

#: agora modality → the LiteLLM coroutine that serves it. ``speech`` is absent because
#: ``litellm.aspeech`` answers with a binary stream rather than the JSON body this router
#: relays, and ``music`` because LiteLLM has no music-generation surface at all (spike exp 9)
#: — ``/v1/audio/music-generations`` is agora's own route over its own vendors.
CALLS: dict[str, str] = {
    "text": "acompletion",
    "image": "aimage_generation",
    "video": "avideo_generation",
}

#: What to tell a deployer that set :data:`ENABLE_ENV` without installing the extra. It
#: surfaces as the rung's failure reason, and the walk continues to the next rung — an
#: uninstalled optional dependency degrades the ladder, it never denies service.
MISSING_MESSAGE = (
    f"{ENABLE_ENV} is set but litellm is not installed — "
    "install the extra: pip install 'agora-provider-router[litellm]'"
)


def enabled(env: Mapping[str, str]) -> bool:
    """Whether the LiteLLM dispatch adapter is switched on for this configuration."""
    return str(env.get(ENABLE_ENV) or "").strip().lower() in _TRUTHY


def dialable(provider: str, modality: str) -> bool:
    """Whether a native-wire ``provider`` can be dialed for ``modality`` through LiteLLM.

    Consulted by :func:`~agora_provider_router.backends.resolve_tier` *before* a backend
    exists: an uncovered pair must stay ``pending-adapter`` rather than resolve into a rung
    that would then fall back onto an OpenAI POST the vendor does not speak.
    """
    adapter = NATIVE_ADAPTERS.get(provider)
    return adapter is not None and modality in adapter.modalities


def model_id(backend: Backend) -> str:
    """``Backend`` → the provider-qualified model string LiteLLM routes on."""
    adapter = NATIVE_ADAPTERS[backend.provider]
    return f"{adapter.provider}/{backend.model}"


def transport(fallback: Transport, *, timeout: float) -> Transport:
    """Wrap ``fallback`` so native-wire backends go through LiteLLM and the rest do not.

    Returned as a :data:`~agora_provider_router.router.Transport`, so the router's dispatch
    loop is unchanged: this is one more way for a rung to answer or to raise, and raising is
    still just "the next rung, please".
    """

    async def dispatch(backend: Backend, payload: dict[str, Any]) -> dict[str, Any]:
        if backend.provider not in NATIVE_ADAPTERS:
            return await fallback(backend, payload)
        return await _via_litellm(backend, payload, timeout=timeout)

    return dispatch


async def _via_litellm(
    backend: Backend, payload: dict[str, Any], *, timeout: float
) -> dict[str, Any]:
    """Call LiteLLM for one native-wire backend and return the decoded OpenAI-shaped body."""
    call = CALLS.get(backend.modality)
    if call is None:  # pragma: no cover — `dialable` keeps such a rung out of the ladder
        raise ValueError(f"no litellm surface for {backend.modality}")
    litellm = _load()
    # The model is taken from the *backend*, never from the body: the ladder chose this rung,
    # and LiteLLM routes on a provider-qualified id a caller's `model` field cannot spell.
    request: dict[str, Any] = {
        **payload,
        "model": model_id(backend),
        "timeout": timeout,
        # An OpenAI-shaped body reaching a native vendor may carry parameters it has no
        # equivalent for; dropping them beats failing the rung over a `logit_bias`.
        "drop_params": True,
    }
    if backend.api_key is not None:
        request["api_key"] = backend.api_key.get_secret_value()
    if backend.base_url:
        # Only ever an explicitly configured override — LiteLLM knows each vendor's own
        # address, and the default in `PAID_VENDORS` is vocabulary for `/v1/providers`.
        request["api_base"] = backend.base_url
    return _as_dict(await getattr(litellm, call)(**request))


def _load() -> Any:
    """Import litellm lazily, with an actionable message when the extra is not installed.

    Lazy on purpose: the import costs seconds and ~166 MB of dependency, and a router that
    never enables the adapter must pay neither.
    """
    try:
        return importlib.import_module("litellm")
    except ImportError as exc:
        raise RuntimeError(MISSING_MESSAGE) from exc


def _as_dict(response: Any) -> dict[str, Any]:
    """LiteLLM's response object → the plain body the router reports and prices.

    ``settle`` reads ``usage.total_tokens`` off this, so the pydantic model has to be dumped
    rather than returned: a caller — and the cost report — sees the same JSON either transport
    produced. Anything undumpable raises, which costs the rung and not the request.
    """
    if isinstance(response, Mapping):
        return dict(response)
    dump = getattr(response, "model_dump", None)
    if callable(dump):
        dumped: dict[str, Any] = dump()
        return dumped
    raise TypeError(f"litellm returned an undecodable {type(response).__name__}")
