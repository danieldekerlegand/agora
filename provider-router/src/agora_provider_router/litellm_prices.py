"""Optional rate source — LiteLLM's maintained model price map, and nothing else.

The dispatch adapter (:mod:`agora_provider_router.litellm_dispatch`) borrowed one of the two
things the spike found LiteLLM genuinely owns: vendor wire adapters. This module borrows the
other: **the price map**, a per-model sheet maintained at LiteLLM's release cadence rather
than agora's.

It is a *source of rates*, not a cost model. Everything that makes a rate mean something —
the KCB ``budget_units`` denomination, the rule that an unpriced rung never passes a ceiling,
what a "unit" is per modality, how a request is measured — stays in
:mod:`agora_provider_router.cost`, which is why this module answers in **US dollars per
:data:`~agora_provider_router.cost.UNIT_OF` unit** and lets the cost model do the conversion.
A source that could set the denomination would be a cost model wearing a source's name.

Where it sits in the stack
--------------------------
``cost.rate_for`` consults four layers, and this one is third::

    AGORA_PRICE_<MODALITY>_<PROVIDER>   a deployer's single-rate override
    FREE_PROVIDERS                      the zero-spend tiers, held in code
    AGORA_PRICE_TABLE                   a deployer's replacement sheet
    this map                            model-exact, opt-in                  <-- here
    prices.toml                         the shipped per-provider estimate
    (nothing)                           -> unpriced, and refusable

Above the shipped sheet because it is *model*-exact where ``prices.toml`` is one conservative
estimate per provider — a deployer who points ``AGORA_PROVIDER_OPENAI_MODEL`` at a model an
order of magnitude dearer than the sheet's assumption gets the real number. Below both
deployer-set layers because a hand-set rate is a decision and a sourced one is only data.

The ``(0, 0)`` trap
-------------------
``litellm.cost_per_token`` returns ``(0, 0)`` for a model it does not price — *free* where it
means *unknown*, which is exactly the inversion ``cost.py``'s ``unpriced`` flag exists to
prevent (``docs/router-hand-built-behaviours.md`` §2.2). So this module never calls it. It
reads the map itself, where a model it does not price is a **missing key**: :func:`usd_rate_for`
answers ``None``, the cost model falls through to the shipped sheet and, failing that, flags
the rung ``unpriced``. A missing rate can only ever make a rung *more* refusable here.

Off by default
--------------
Opt-in via :data:`ENABLE_ENV` (``AGORA_PRICE_LITELLM=1``), against the same optional extra as
the dispatch adapter (``pip install 'agora-provider-router[litellm]'``), for the same two
reasons: the weight of the dependency is a deployment's call, and the Erlang router is
canonical (ADR-0004) with no LiteLLM half — so the Python router's *default* prices, and
therefore the bytes ``apr_conformance_SUITE`` replays, have to stay exactly what they were.
Being an ``AGORA_*`` variable is what gets it scrubbed by that suite for free.

An enabled source that cannot load is not an error, it is an absence: if the extra is not
installed the map contributes nothing and pricing falls back a layer. Degrading towards
``unpriced`` fails safe (an unpriced rung is refused under a ceiling); raising would cost the
request rather than the rate.
"""

from __future__ import annotations

import importlib
import math
import os
from collections.abc import Mapping
from typing import Any

#: Turns the price source on. Part of the ``AGORA_*`` block :class:`RouterConfig` already
#: keeps, so it needs no plumbing — and so the Erlang conformance suite scrubs it.
ENABLE_ENV = "AGORA_PRICE_LITELLM"

_TRUTHY = frozenset({"1", "true", "yes", "on"})

#: LiteLLM refreshes its cost map over the network at *import* unless told otherwise. Pricing
#: is on the request path and this package's cost module is documented as making no network
#: call, so the bundled map is forced before the import. ``setdefault``, not assignment: a
#: deployer who deliberately wants the live map can still say so.
LOCAL_MAP_ENV = "LITELLM_LOCAL_MODEL_COST_MAP"

#: agora modality → the map's cost keys for it, in preference order; the first one present on
#: the entry wins. Output-side where a vendor bills both ends, matching ``prices.toml``'s own
#: convention. Speech reads the *input* side because agora meters speech in characters of the
#: text handed in, which is what a TTS vendor bills. ``music`` is absent for the same reason
#: it is absent from the dispatch adapter's ``CALLS``: LiteLLM has no music surface, so
#: ``/v1/audio/music-generations`` stays priced by agora's own sheet.
COST_KEYS: dict[str, tuple[str, ...]] = {
    "text": ("output_cost_per_token",),
    "image": ("output_cost_per_image",),
    "speech": ("input_cost_per_character", "output_cost_per_character"),
    "video": ("output_cost_per_video_per_second", "output_cost_per_second"),
}


def enabled(env: Mapping[str, str]) -> bool:
    """Whether the LiteLLM price map is switched on as a rate source for this configuration."""
    return str(env.get(ENABLE_ENV) or "").strip().lower() in _TRUTHY


def usd_rate_for(
    modality: str, provider: str, model: str | None, env: Mapping[str, str]
) -> float | None:
    """US dollars per :data:`~agora_provider_router.cost.UNIT_OF` unit, or ``None``.

    ``None`` means "this source has no opinion" — switched off, extra not installed, modality
    LiteLLM does not price, or a model absent from the map. It never means zero; see the
    module docstring on the ``(0, 0)`` trap. Never raises: a rate source that can fail the
    request is worse than one that has nothing to say.
    """
    if not model or not enabled(env):
        return None
    keys = COST_KEYS.get(modality)
    if keys is None:
        return None
    entry = _entry(provider, model)
    if entry is None:
        return None
    for key in keys:
        rate = _rate(entry.get(key))
        if rate is not None:
            return rate
    return None


def _entry(provider: str, model: str) -> Mapping[str, Any] | None:
    """The map's record for one of agora's backends, under either name it may carry.

    Provider-qualified first (``gemini/gemini-2.5-flash``), because that key is unambiguous;
    the bare model id second, since the map lists plenty of models only that way. The entry's
    own ``litellm_provider`` is deliberately not cross-checked against agora's provider name —
    the two vocabularies genuinely differ (one vendor's models are filed under several
    LiteLLM providers), so the check would reject correct rates more often than wrong ones.
    """
    price_map = _price_map()
    for key in (f"{provider}/{model}", model):
        entry = price_map.get(key)
        if isinstance(entry, Mapping):
            return entry
    return None


def _rate(value: Any) -> float | None:
    """A usable rate off a map entry — a finite, non-negative number, or ``None``."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    rate = float(value)
    return rate if math.isfinite(rate) and rate >= 0 else None


def _price_map() -> Mapping[str, Any]:
    """LiteLLM's ``model_cost``, or an empty map when the extra is not installed.

    Imported lazily for the same reason the dispatch adapter does it: the import costs
    seconds and ~166 MB of dependency, and a router that never enables the source must pay
    neither. ``sys.modules`` makes every lookup after the first a dict access.
    """
    try:
        os.environ.setdefault(LOCAL_MAP_ENV, "True")
        litellm = importlib.import_module("litellm")
    except Exception:  # an unloadable source is an ABSENT source, never a failed request
        return {}
    price_map = getattr(litellm, "model_cost", None)
    return price_map if isinstance(price_map, Mapping) else {}
