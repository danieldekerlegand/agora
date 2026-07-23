"""The standalone entry point — ``agora-provider-router`` / ``python -m agora_provider_router``.

Both boot the FastAPI app under uvicorn with host/port read from the environment. These
tests exercise :func:`agora_provider_router.__main__.main` without actually binding a
socket (``uvicorn.run`` is patched), and confirm the shipped price sheet is importable as
package data so a clean-venv install can price the ladder.
"""

from __future__ import annotations

from typing import Any

import pytest
import uvicorn

from agora_provider_router import __main__


def test_main_serves_the_app_on_the_env_host_and_port(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
    monkeypatch.setattr(uvicorn, "run", lambda *a, **k: calls.append((a, k)))
    monkeypatch.setenv("AGORA_HOST", "127.0.0.1")
    monkeypatch.setenv("AGORA_PORT", "9137")

    __main__.main()

    assert len(calls) == 1
    args, kwargs = calls[0]
    assert args == ("agora_provider_router.app:app",)
    assert kwargs == {"host": "127.0.0.1", "port": 9137}


def test_main_defaults_bind_all_interfaces_on_port_8000(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(uvicorn, "run", lambda *a, **k: calls.append(k))
    monkeypatch.delenv("AGORA_HOST", raising=False)
    monkeypatch.delenv("AGORA_PORT", raising=False)

    __main__.main()

    assert calls == [{"host": "0.0.0.0", "port": 8000}]


def test_the_price_sheet_ships_as_importable_package_data() -> None:
    from importlib.resources import files

    sheet = files("agora_provider_router").joinpath("prices.toml")
    assert sheet.is_file(), "prices.toml must ship inside the package so a wheel can price"
    assert "0.00001" in sheet.read_text(encoding="utf-8")
