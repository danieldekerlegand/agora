"""Bootstrap gate for the trainer area (US-1).

Proves the package imports, the app serves, and — because the trainer is one of the two areas
in another language — that its pinned KCB version still matches the TypeScript schemas package.
That cross-language pin is the only thing keeping the polyglot split honest, the same discipline
the provider-router keeps.
"""

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agora_trainer import KCB_VERSION, KFT_VERSION, TRAINER_IDENTITY
from agora_trainer.app import app

REPO_ROOT = Path(__file__).resolve().parents[2]
#: Where the TypeScript side pins the same spec versions (``@agora/schemas``).
SCHEMAS_VERSIONS = REPO_ROOT / "schemas" / "src" / "versions.ts"


def test_health_reports_identity_without_secrets() -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["identity"] == TRAINER_IDENTITY
    assert body["kcb_version"] == KCB_VERSION
    assert body["kft_version"] == KFT_VERSION
    assert not any("key" in key or "token" in key for key in body)


def test_the_trainer_is_a_distinct_identity_from_the_provider_router() -> None:
    """ADR-0001 decision 1: two distinct routers, never merged."""
    assert TRAINER_IDENTITY == "agora:agent:trainer"
    assert TRAINER_IDENTITY != "agora:agent:provider-router"


@pytest.mark.skipif(
    not SCHEMAS_VERSIONS.exists(),
    reason=f"standalone checkout: {SCHEMAS_VERSIONS} (the TS schemas package) is absent",
)
def test_kcb_version_matches_the_typescript_schemas_package() -> None:
    source = SCHEMAS_VERSIONS.read_text(encoding="utf-8")
    match = re.search(r"kcb:\s*('|\")([^'\"]+)\1", source)
    assert match is not None, f"could not find the kcb version pin in {SCHEMAS_VERSIONS}"
    assert match.group(2) == KCB_VERSION
