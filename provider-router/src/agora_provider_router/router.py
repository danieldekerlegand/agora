"""The router: walk the ladder, dispatch to the first rung that answers, always complete.

**The invariant.** :meth:`Router.complete` does not raise. Every rung that is unconfigured,
unreachable, or errors is recorded as an attempt and the walk continues; the placeholder is
terminal and offline, so the walk always terminates in a response. With no keys and no local
servers every modality resolves to the placeholder and nothing spends — the ZERO-SPEND
guarantee, asserted in ``tests/test_zero_spend.py``.

Dispatch is one code path for all four tiers because every dialable backend speaks the
OpenAI wire format (see :mod:`agora_provider_router.backends`). Transport is injected, so
tests exercise fallthrough without a network and without patching internals.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from .backends import Backend, TierResolution, placeholder_backend, resolve_tier
from .config import RouterConfig
from .ladder import MODALITIES, PLACEHOLDER, safe_resolve
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
    """One rung the router tried, and what came back."""

    tier: str
    provider: str
    ok: bool
    reason: str | None = None

    def describe(self) -> dict[str, object]:
        entry: dict[str, object] = {"tier": self.tier, "provider": self.provider, "ok": self.ok}
        if self.reason:
            entry["reason"] = self.reason
        return entry


@dataclass(frozen=True)
class Completion:
    """A completed request: the response plus the routing story behind it."""

    modality: str
    backend: Backend
    response: dict[str, Any]
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


class Router:
    """Ladder resolution + dispatch over one configuration snapshot."""

    def __init__(self, config: RouterConfig, transport: Transport | None = None) -> None:
        self.config = config
        self._transport = transport or http_transport

    # --- resolution -------------------------------------------------------------

    def resolutions(self, modality: str) -> tuple[list[TierResolution], str | None]:
        """Every configured rung for ``modality`` in order, plus any ladder-config error.

        The placeholder is appended unconditionally, so the list is never empty and its
        last entry is always ``ready``.
        """
        tiers, error = safe_resolve(modality, self.config.env)
        resolved = [resolve_tier(tier, modality, self.config) for tier in tiers]
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

    async def complete(self, modality: str, payload: dict[str, Any]) -> Completion:
        """Dispatch ``payload`` down ``modality``'s ladder. Does not raise.

        ``ValueError`` on an unknown modality is the one exception, and it is a caller bug
        (a typo'd endpoint), not a runtime state — no ladder exists to fall down.
        """
        if modality not in MODALITIES:
            raise ValueError(f"unknown modality {modality!r}")
        resolutions, _ = self.resolutions(modality)
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
                    )
                )
                continue
            if backend.tier == PLACEHOLDER:
                attempts.append(Attempt(tier=backend.tier, provider=backend.provider, ok=True))
                return Completion(
                    modality=modality,
                    backend=backend,
                    response=placeholder_complete(modality, payload, backend.model),
                    attempts=attempts,
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
                    Attempt(tier=backend.tier, provider=backend.provider, ok=False, reason=reason)
                )
                continue
            attempts.append(Attempt(tier=backend.tier, provider=backend.provider, ok=True))
            return Completion(
                modality=modality, backend=backend, response=response, attempts=attempts
            )
        # Unreachable: resolutions always ends with the ready placeholder.
        raise AssertionError("the placeholder tier is missing from the ladder")


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
