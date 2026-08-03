"""The router: walk the ladder, dispatch to the first rung that answers, always complete.

**The invariant.** :meth:`Router.complete` does not raise *on runtime state*. Every rung
that is unconfigured, unreachable, over budget, or errors is recorded as an attempt and the
walk continues; the placeholder is terminal, offline and free, so the walk always terminates
in a response. With no keys and no local servers every modality resolves to the placeholder
and nothing spends — the ZERO-SPEND guarantee, asserted in ``tests/test_zero_spend.py``. The
only ``ValueError`` it raises is for a malformed *request* (an unknown modality, an
unreadable ``budget_units``), which is a caller bug rather than a state to fall down from.

**The budget.** A request may carry a ``budget_units`` ceiling (KCB §5). Each rung is priced
before it is dialed (:mod:`agora_provider_router.cost`); one that would exceed the ceiling is
refused *without being contacted* and the walk falls through to a cheaper — ultimately
zero-cost — rung. A ceiling of ``0`` therefore cannot spend at all, and no paid tier is ever
so much as connected to.

Dispatch is one code path for all four tiers because every dialable backend speaks the
OpenAI wire format (see :mod:`agora_provider_router.backends`). Transport is injected, so
tests exercise fallthrough without a network and without patching internals — and so the
optional LiteLLM adapter (:mod:`agora_provider_router.litellm_dispatch`, off unless
``AGORA_LITELLM`` is set) is a *transport*, not a fork in this module. It can add rungs the
router could not dial before; it cannot reorder the ladder, relax a ceiling, or displace the
placeholder, because none of those live below the transport boundary.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import httpx

from .backends import Backend, Rank, TierResolution, placeholder_backend, resolve_tier
from .config import RouterConfig
from .cost import Cost, project, refusal, settle, take_ceiling, within
from .ladder import MODALITIES, PLACEHOLDER, safe_resolve
from .litellm_dispatch import enabled as litellm_enabled
from .litellm_dispatch import transport as litellm_transport
from .placeholder import complete as placeholder_complete

logger = logging.getLogger(__name__)

#: An injected transport: dial ``backend`` with ``payload``, return the decoded response.
#: Raising is how it reports "this rung did not answer" — the router falls through.
Transport = Callable[[Backend, dict[str, Any]], Awaitable[dict[str, Any]]]

#: Seconds a single rung gets before it counts as unavailable. A slow paid tier must not
#: hold a request hostage when a free one is one rung down.
DEFAULT_TIMEOUT = 30.0


@dataclass(frozen=True)
class Attempt:
    """One rung the router tried, and what came back.

    ``dialed`` separates the two ways a rung can fail: it was contacted and did not answer,
    or it was refused on price and never contacted at all. A budget audit needs to tell
    those apart — only the first could have spent anything.
    """

    tier: str
    provider: str
    ok: bool
    reason: str | None = None
    dialed: bool = True
    projected: Cost | None = None

    def describe(self) -> dict[str, object]:
        entry: dict[str, object] = {
            "tier": self.tier,
            "provider": self.provider,
            "ok": self.ok,
            "dialed": self.dialed,
        }
        if self.reason:
            entry["reason"] = self.reason
        if self.projected is not None:
            entry["projected"] = self.projected.describe()
        return entry


@dataclass(frozen=True)
class Completion:
    """A completed request: the response, the routing story, and what it cost."""

    modality: str
    backend: Backend
    response: dict[str, Any]
    projected: Cost
    actual: Cost
    budget_units: float | None = None
    attempts: list[Attempt] = field(default_factory=list)

    @property
    def tier(self) -> str:
        return self.backend.tier

    def routing(self) -> dict[str, object]:
        """The out-of-band routing report attached to every response."""
        return {
            "modality": self.modality,
            "tier": self.backend.tier,
            "provider": self.backend.provider,
            "model": self.backend.model,
            "attempts": [a.describe() for a in self.attempts],
            "cost": self.cost(),
        }

    def cost(self) -> dict[str, object]:
        """Projected vs actual spend, in KCB budget units (KCB §3: surface it to the caller)."""
        return {
            "currency": "budget_units",
            "budget_units": self.budget_units,
            "projected_units": self.projected.units,
            "actual_units": self.actual.units,
            "projected": self.projected.describe(),
            "actual": self.actual.describe(),
        }


async def http_transport(backend: Backend, payload: dict[str, Any]) -> dict[str, Any]:
    """The real transport: POST the OpenAI-shaped payload at the backend's endpoint."""
    headers = {"content-type": "application/json"}
    if backend.api_key is not None:
        headers["authorization"] = f"Bearer {backend.api_key.get_secret_value()}"
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        response = await client.post(backend.url, json=payload, headers=headers)
        response.raise_for_status()
        decoded: dict[str, Any] = response.json()
        return decoded


def default_transport(config: RouterConfig) -> Transport:
    """The transport a router uses when none is injected.

    Plain HTTP, unless the LiteLLM dispatch adapter is switched on — in which case the
    native-wire paid vendors it covers go through LiteLLM and every other rung still takes
    the direct POST (:mod:`agora_provider_router.litellm_dispatch`). Choosing here rather
    than inside the dispatch loop keeps the loop one code path: the ladder, the ceiling and
    the placeholder do not know which vendor adapters happen to be installed.
    """
    if litellm_enabled(config.env):
        return litellm_transport(http_transport, timeout=DEFAULT_TIMEOUT)
    return http_transport


class Router:
    """Ladder resolution + dispatch over one configuration snapshot."""

    def __init__(self, config: RouterConfig, transport: Transport | None = None) -> None:
        self.config = config
        self._transport = transport or default_transport(config)

    # --- resolution -------------------------------------------------------------

    def resolutions(
        self, modality: str, rank: Rank | None = None
    ) -> tuple[list[TierResolution], str | None]:
        """Every configured rung for ``modality`` in order, plus any ladder-config error.

        The placeholder is appended unconditionally, so the list is never empty and its
        last entry is always ``ready``. ``rank`` is the cost function used to choose among
        equally-usable paid vendors; see :meth:`complete`.
        """
        tiers, error = safe_resolve(modality, self.config.env)
        resolved = [resolve_tier(tier, modality, self.config, rank) for tier in tiers]
        resolved.append(
            TierResolution(tier=PLACEHOLDER, status="ready", backend=placeholder_backend(modality))
        )
        return resolved, error

    def resolve(self, modality: str) -> Backend:
        """The backend ``modality`` would dial first. Never fails: worst case, placeholder."""
        return self.candidates(modality)[0]

    def candidates(self, modality: str) -> list[Backend]:
        """The ready backends for ``modality``, in ladder order, placeholder last."""
        resolutions, _ = self.resolutions(modality)
        return [r.backend for r in resolutions if r.backend is not None]

    def doctor(self) -> dict[str, Any]:
        """The resolved ladder per modality — what ``/doctor`` reports. Never raises."""
        report: dict[str, Any] = {}
        for modality in MODALITIES:
            resolutions, error = self.resolutions(modality)
            entry: dict[str, Any] = {
                "ladder": [r.tier for r in resolutions],
                "tiers": [r.describe() for r in resolutions],
                "resolves_to": self.resolve(modality).describe(),
            }
            if error:
                entry["error"] = error
            report[modality] = entry
        return report

    # --- dispatch ---------------------------------------------------------------

    async def complete(
        self, modality: str, payload: dict[str, Any], *, budget_units: float | None = None
    ) -> Completion:
        """Dispatch ``payload`` down ``modality``'s ladder, under an optional spend ceiling.

        The ceiling comes from the body's ``budget_units`` key (which is stripped before
        dispatch — it is an agora extension an upstream provider would reject) or, failing
        that, from ``budget_units``, which is how the ``X-Agora-Budget-Units`` header
        reaches here for clients that cannot add body keys.

        The ladder order is a *preference* and the ceiling is a *constraint*: rungs are
        tried in ladder order and one that is projected over budget is skipped without
        being dialed. Because the ladder runs expensive → free, the first surviving rung is
        the best one the caller can afford. Where the ladder expresses no preference — two
        usable paid vendors — the cheaper is chosen (KCB §3).

        Does not raise on runtime state; ``ValueError`` means the *request* was malformed.
        """
        if modality not in MODALITIES:
            raise ValueError(f"unknown modality {modality!r}")
        payload, body_ceiling = take_ceiling(payload)
        ceiling = body_ceiling if body_ceiling is not None else budget_units
        env = self.config.env

        def rank(candidate: Backend) -> float:
            return project(modality, candidate.provider, payload, env).units

        resolutions, _ = self.resolutions(modality, rank if ceiling is not None else None)
        attempts: list[Attempt] = []
        for resolution in resolutions:
            backend = resolution.backend
            if backend is None:
                attempts.append(
                    Attempt(
                        tier=resolution.tier,
                        provider="-",
                        ok=False,
                        reason=resolution.reason or resolution.status,
                        dialed=False,
                    )
                )
                continue
            projected = project(modality, backend.provider, payload, env)
            if not within(projected, ceiling):
                assert ceiling is not None  # noqa: S101 — `within` only refuses under one
                reason = refusal(projected, ceiling, modality, backend.provider)
                logger.info(
                    "tier %s (%s) refused for %s: %s",
                    backend.tier,
                    backend.provider,
                    modality,
                    reason,
                )
                attempts.append(
                    Attempt(
                        tier=backend.tier,
                        provider=backend.provider,
                        ok=False,
                        reason=reason,
                        dialed=False,
                        projected=projected,
                    )
                )
                continue
            if backend.tier == PLACEHOLDER:
                response = placeholder_complete(modality, payload, backend.model)
                attempts.append(Attempt(tier=backend.tier, provider=backend.provider, ok=True))
                return self._completed(
                    modality, backend, response, payload, projected, ceiling, attempts
                )
            try:
                response = await self._transport(backend, {"model": backend.model, **payload})
            except Exception as exc:  # noqa: BLE001 — any failure is just the next rung
                reason = _reason(exc, backend)
                # The backend, never the payload or the key: a request body can carry user
                # content and a header can carry a secret.
                logger.warning(
                    "tier %s (%s) unavailable for %s: %s",
                    backend.tier,
                    backend.provider,
                    modality,
                    reason,
                )
                attempts.append(
                    Attempt(
                        tier=backend.tier,
                        provider=backend.provider,
                        ok=False,
                        reason=reason,
                        projected=projected,
                    )
                )
                continue
            attempts.append(
                Attempt(tier=backend.tier, provider=backend.provider, ok=True, projected=projected)
            )
            return self._completed(
                modality, backend, response, payload, projected, ceiling, attempts
            )
        # Unreachable: resolutions always ends with the ready placeholder, which is free and
        # therefore survives every ceiling (a negative one having clamped to zero).
        raise AssertionError("the placeholder tier is missing from the ladder")

    def _completed(
        self,
        modality: str,
        backend: Backend,
        response: dict[str, Any],
        payload: Mapping[str, Any],
        projected: Cost,
        ceiling: float | None,
        attempts: list[Attempt],
    ) -> Completion:
        """Settle the actual cost against the response and assemble the result."""
        return Completion(
            modality=modality,
            backend=backend,
            response=response,
            projected=projected,
            actual=settle(modality, backend.provider, payload, response, self.config.env),
            budget_units=ceiling,
            attempts=attempts,
        )


def _reason(exc: Exception, backend: Backend) -> str:
    """A short, secret-free description of why a rung failed.

    A transport error's message can quote the URL it was dialing, and a base URL can carry
    an embedded credential — so the backend's own key is redacted out of it before the
    string reaches a log line or a response body.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code}"
    reason = f"{type(exc).__name__}: {exc}".strip()
    if backend.api_key is not None:
        secret = backend.api_key.get_secret_value()
        if secret:
            reason = reason.replace(secret, "***")
    return reason
