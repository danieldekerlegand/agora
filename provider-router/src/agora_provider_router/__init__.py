"""The agora provider-router.

A gateway to *model backends* — one leaf capability on the bus, never the path other
platforms route through (ADR-0001 decision 1). The tier ladder (paid API key → mlx-serve
→ local Ollama/on-disk → deterministic placeholder) is ported from Analyzer, and every walk
down it is gated by the caller's KCB spend ceiling.

The pieces, in dependency order — this module stays constants-only so any of them can
import it:

* :mod:`~agora_provider_router.config` — the ``AGORA_PROVIDER_*`` settings schema
* :mod:`~agora_provider_router.ladder` — the configurable per-modality tier order
* :mod:`~agora_provider_router.backends` — tier → a dialable backend, or why not
* :mod:`~agora_provider_router.cost` — pricing and the ``budget_units`` ceiling (KCB §5)
* :mod:`~agora_provider_router.placeholder` — the deterministic terminal tier
* :mod:`~agora_provider_router.router` — the walk, the budget gate, and always-completes
* :mod:`~agora_provider_router.manifest` — the KCB capability manifest (KCB §2)
* :mod:`~agora_provider_router.app` — the OpenAI-compatible surface plus ``/doctor``
"""

import os

__all__ = ["KCB_VERSION", "ROUTER_IDENTITY", "ROUTER_IDENTITY_ENV_VAR", "__version__"]

__version__ = "0.1.0"

#: Env var overriding the router's KINP identity; unset keeps the historical default.
ROUTER_IDENTITY_ENV_VAR = "AGORA_ROUTER_IDENTITY"

#: The identity a bare deployment reports, byte-identical to the ported-from-Analyzer value.
_DEFAULT_ROUTER_IDENTITY = "agora:agent:provider-router"

#: KINP identity of the router — a capability provider is itself a fabric entity (KCB §2).
#: Overridable so a separate deployment can name itself; defaults to the historical literal
#: so ``/health`` and the KCB manifest are unchanged when the override is unset.
ROUTER_IDENTITY = os.environ.get(ROUTER_IDENTITY_ENV_VAR, "").strip() or _DEFAULT_ROUTER_IDENTITY

#: The koine capability-bus version this build speaks. Kept in step with
#: ``schemas/src/index.ts``'s ``SPEC_VERSIONS.kcb``; the cross-language check in
#: ``tests/test_skeleton.py`` fails if they drift.
KCB_VERSION = "0.2.0"
