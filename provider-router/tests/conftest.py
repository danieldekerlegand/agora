"""Shared fixtures: build routers from an explicit environment, never the process's.

Every test states its whole configuration inline. ``read_file=False`` matters — without it
a developer's real ``.env`` two directories up would silently configure a paid tier and the
zero-spend assertions would pass or fail by accident of the machine.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import Any, TypeVar

from agora_provider_router.backends import Backend
from agora_provider_router.config import RouterConfig
from agora_provider_router.router import Router, Transport

T = TypeVar("T")


def config_for(**env: str) -> RouterConfig:
    """A config from exactly these variables — no process env, no env file."""
    return RouterConfig.from_env(env, read_file=False)


def router_for(**env: str) -> Router:
    """A router on exactly these variables, with the real HTTP transport.

    No ``transport`` parameter on purpose: it would collide with an env var of that name
    when a test spreads a configuration dict. A test that needs a fake transport builds
    ``Router(config_for(...), transport=...)`` directly.
    """
    return Router(config_for(**env))


def run(coro: Awaitable[T]) -> T:
    """Drive one coroutine to completion (no pytest-asyncio in the gate's dep set)."""
    return asyncio.run(_await(coro))


async def _await(coro: Awaitable[T]) -> T:
    return await coro


def recording_transport(
    calls: list[Backend], *, fail: set[str] | None = None, response: dict[str, Any] | None = None
) -> Transport:
    """A transport that records every backend it is handed.

    Backends whose *tier* is in ``fail`` raise, standing in for an unreachable server; the
    rest return ``response``. Recording is what proves the zero-spend invariant: a test can
    assert the paid tier was never dialed at all, not merely that it did not win.
    """

    async def transport(backend: Backend, payload: dict[str, Any]) -> dict[str, Any]:
        calls.append(backend)
        if fail and backend.tier in fail:
            raise ConnectionError(f"{backend.provider} is not listening")
        return response if response is not None else {"id": f"{backend.provider}-response"}

    return transport
