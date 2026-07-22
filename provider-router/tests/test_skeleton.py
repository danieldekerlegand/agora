"""Bootstrap gate for the provider-router area (US-AG1).

Proves the package imports, the app serves, and — because the router is the one area in
another language — that its pinned KCB version still matches the TypeScript schemas
package. That cross-language pin is the only thing keeping the polyglot split honest.
"""

import json
import re
from pathlib import Path

from fastapi.testclient import TestClient

from agora_provider_router import KCB_VERSION, ROUTER_IDENTITY
from agora_provider_router.app import app

SCHEMAS_INDEX = Path(__file__).resolve().parents[2] / "schemas" / "src" / "index.ts"


def test_health_reports_identity_without_secrets() -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["identity"] == ROUTER_IDENTITY
    assert body["kcb_version"] == KCB_VERSION
    assert not any("key" in key or "token" in key for key in body)


def test_kcb_version_matches_the_typescript_schemas_package() -> None:
    source = SCHEMAS_INDEX.read_text(encoding="utf-8")
    match = re.search(r"kcb:\s*('|\")([^'\"]+)\1", source)
    assert match is not None, f"could not find the kcb version pin in {SCHEMAS_INDEX}"
    assert match.group(2) == KCB_VERSION


def test_the_router_is_listed_as_an_area_of_the_commons() -> None:
    workspaces = json.loads((SCHEMAS_INDEX.parents[2] / "package.json").read_text())["workspaces"]
    assert "registry" in workspaces
    assert (SCHEMAS_INDEX.parents[2] / "provider-router" / "pyproject.toml").exists()
