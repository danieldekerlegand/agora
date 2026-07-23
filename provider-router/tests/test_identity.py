"""The router's KINP identity: a fixed historical default, overridable from the env.

The identity is read once at import (the package stays constants-only), so these tests
reload the package under a controlled environment and restore the default afterward.
"""

from __future__ import annotations

import importlib

import pytest

import agora_provider_router as pkg
from agora_provider_router import ROUTER_IDENTITY_ENV_VAR


def test_the_router_identity_defaults_to_the_historical_literal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(ROUTER_IDENTITY_ENV_VAR, raising=False)
    reloaded = importlib.reload(pkg)
    assert reloaded.ROUTER_IDENTITY == "agora:agent:provider-router"


def test_the_router_identity_is_overridable_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(ROUTER_IDENTITY_ENV_VAR, "acme:agent:gateway")
    try:
        reloaded = importlib.reload(pkg)
        assert reloaded.ROUTER_IDENTITY == "acme:agent:gateway"
    finally:
        # Restore the default so app/manifest (bound at their own import) stay consistent.
        monkeypatch.delenv(ROUTER_IDENTITY_ENV_VAR, raising=False)
        importlib.reload(pkg)
