"""The router's KCB capability manifest — ``koine/specs/capability-bus.md`` §2.

"Every project publishes one manifest declaring who it is and what it offers, in KINP
terms." This is the router's, and it is the first concrete one in the ecosystem: identity,
endpoints, the ports it produces and consumes, and one invocable capability per modality
carrying a `cost` (§2.1) so the registry (US-AG4) can prefer cheap routes and a caller can
gate spend before invoking (§3, §5).

Post-0.3.0 the manifest no longer rides on its own ``/.well-known/kcb-manifest.json``; it is a
named **extension** of the provider's A2A AgentCard (§2/§6), served at
``/.well-known/agent-card.json``. The full body below becomes the ``params`` of the single
extension whose ``uri`` is :data:`KCB_MANIFEST_EXTENSION_URI` (mirrored from
``schemas/src/agent-card.ts``); the card is the document a peer or the registry fetches.

Two deliberate choices:

* **Cost is advertised for the tier that is actually resolved right now.** A keyless router
  advertises ``{"tier": "placeholder", "est_units": 0}``; the same binary with an OpenAI key
  advertises the paid rate. Publishing a static price list would make the registry's
  zero-cost preference a lie on exactly the deployments where it matters most. The number is
  priced against a fixed *nominal* request per modality (:data:`NOMINAL`), stated in
  ``basis``, so two providers' figures are comparable.
* **No endpoint is advertised that is not served.** KCB §2's example carries ``mcp`` and
  ``a2a`` addresses; this router serves neither yet, so it publishes neither. An address in
  a manifest is a promise the registry will hand to peers who then dial it directly
  (ADR-0001 decision 3) — a dead one is worse than an absent one.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from . import KCB_VERSION, ROUTER_IDENTITY, __version__
from .backends import ENDPOINTS
from .cost import BUDGET_HEADER, BUDGET_KEY, project
from .ladder import MODALITIES
from .placeholder import MEDIA_TYPES
from .router import Router

#: The stable URI of the KCB capability-manifest extension on an AgentCard (capability-bus.md
#: §2, 0.3.0). Mirrors ``KCB_MANIFEST_EXTENSION_URI`` in ``schemas/src/agent-card.ts`` — the two
#: are the same literal across the polyglot split, exactly as ``KCB_VERSION`` is.
KCB_MANIFEST_EXTENSION_URI = "https://koine.dev/kcb/manifest/0.3"

#: Where the AgentCard (carrying the KCB extension) is served, and how a crawler finds it
#: (KCB §3, pull population — the registry reads the extension off this card, §6).
MANIFEST_PATH = "/.well-known/agent-card.json"

#: The pre-0.3.0 standalone manifest path. Kept only as a permanent redirect to
#: :data:`MANIFEST_PATH` so a 0.2.0 crawler is pointed at the authoritative card rather than a
#: dead address (capability-bus.md §6 folds the standalone document onto the card).
LEGACY_MANIFEST_PATH = "/.well-known/kcb-manifest.json"

#: The router's own public address, for the endpoints it publishes. Part of the ``AGORA_*``
#: block the config keeps, so it needs no separate plumbing.
BASE_URL_ENV = "AGORA_PUBLIC_BASE_URL"
DEFAULT_BASE_URL = "http://127.0.0.1:8000"

#: The reference request each capability's ``est_units`` is priced against. Fixed on
#: purpose: a cost is only comparable between providers if the request is identical.
NOMINAL: dict[str, dict[str, Any]] = {
    "text": {"max_tokens": 1000},
    "image": {"n": 1},
    "speech": {"input": "x" * 1000},
    "music": {"n": 1},
    "video": {"duration": 5},
}

#: Human-readable form of :data:`NOMINAL`, published as the ``cost.basis``.
NOMINAL_BASIS: dict[str, str] = {
    "text": "1000 completion tokens",
    "image": "one image",
    "speech": "1000 characters of narration",
    "music": "one generation",
    "video": "5 seconds of video",
}


def consumed_port(modality: str) -> dict[str, Any]:
    """What a generation of ``modality`` takes in — a knowledge-plane port (KCB §2.1)."""
    shape = "chat-messages" if modality == "text" else "prompt-text"
    return {"plane": "knowledge", "shape": shape}


def produced_port(modality: str) -> dict[str, Any]:
    """What it emits: text is knowledge, everything else is a media port.

    The media ports carry ``world_pattern: "*"`` (delta J) — the router is world-agnostic,
    so it will serve a request for any world rather than claiming one.
    """
    if modality == "text":
        return {"plane": "knowledge", "shape": "completion-text"}
    return {
        "plane": "media",
        "media_types": [MEDIA_TYPES[modality]],
        "world_pattern": "*",
    }


def capability_name(modality: str) -> str:
    return f"generate.{modality}"


def capability_manifest(router: Router) -> dict[str, Any]:
    """The A2A AgentCard for ``router``, carrying the KCB manifest as its one extension.

    Post-0.3.0 wire shape (capability-bus.md §2/§6): the full manifest body is the ``params``
    of the single :data:`KCB_MANIFEST_EXTENSION_URI` extension under the card's
    ``capabilities.extensions[]``. ``name`` is the router's KINP agent id. No ``url`` (A2A
    service endpoint) is advertised because the router serves none yet — the same "no endpoint
    that is not served" rule that keeps ``a2a``/``mcp`` out of the body's ``endpoints``. Never
    raises.
    """
    return {
        "name": ROUTER_IDENTITY,
        "capabilities": {
            "extensions": [
                {
                    "uri": KCB_MANIFEST_EXTENSION_URI,
                    "description": "KCB capability manifest (koine capability-bus.md §2).",
                    # §2 example: the KCB extension is advertised, not mandated of a reader.
                    "required": False,
                    "params": manifest_body(router),
                }
            ]
        },
    }


def manifest_body(router: Router) -> dict[str, Any]:
    """The KCB manifest body — the extension ``params`` (capability-bus.md §2). Never raises."""
    base = (router.config.env.get(BASE_URL_ENV) or DEFAULT_BASE_URL).rstrip("/")
    capabilities = [_capability(router, modality, base) for modality in MODALITIES]
    return {
        "kcb_version": KCB_VERSION,
        "identity": ROUTER_IDENTITY,
        "version": __version__,
        "endpoints": {
            "openai": f"{base}/v1",
            "doctor": f"{base}/doctor",
            "manifest": f"{base}{MANIFEST_PATH}",
        },
        "produces": _unique(produced_port(m) for m in MODALITIES),
        "consumes": _unique(consumed_port(m) for m in MODALITIES),
        "capabilities": capabilities,
        "auth": {
            "scheme": "capability-token",
            "grants_required": [f"invoke:{capability_name(m)}" for m in MODALITIES],
            # KCB §5: a grant carries a spend ceiling. This is the router declaring it
            # honours one, and where to put it — see `Router.complete`.
            "budget_units": {
                "supported": True,
                "currency": "budget_units",
                "request_key": BUDGET_KEY,
                "header": BUDGET_HEADER,
            },
        },
    }


def _capability(router: Router, modality: str, base: str) -> dict[str, Any]:
    backend = router.resolve(modality)
    cost = project(modality, backend.provider, NOMINAL[modality], router.config.env)
    return {
        "name": capability_name(modality),
        "inputs": [consumed_port(modality)],
        "outputs": [produced_port(modality)],
        "cost": {
            "tier": backend.tier,
            "est_units": cost.units,
            "unit": cost.unit,
            "quantity": cost.quantity,
            "basis": NOMINAL_BASIS[modality],
            "unpriced": cost.unpriced,
        },
        "endpoint": f"{base}/v1{ENDPOINTS[modality]}",
        "provider": backend.provider,
        "model": backend.model,
    }


def _unique(ports: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Dedupe ports by value, keeping first-seen order (modalities share knowledge ports)."""
    seen: list[dict[str, Any]] = []
    for port in ports:
        if port not in seen:
            seen.append(port)
    return seen
