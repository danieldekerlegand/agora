"""Bootstrap gate for the provider-router area (US-AG1).

Proves the package imports, the app serves, and — because the router is the one area in
another language — that its pinned KCB version still matches the TypeScript schemas
package. That cross-language pin is the only thing keeping the polyglot split honest.
"""

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agora_provider_router import KCB_VERSION, ROUTER_IDENTITY
from agora_provider_router.app import app

REPO_ROOT = Path(__file__).resolve().parents[2]
#: Where the TypeScript side pins the same spec versions (``@agora/schemas``).
SCHEMAS_VERSIONS = REPO_ROOT / "schemas" / "src" / "versions.ts"
#: The workspace manifest that lists the router as an area of the commons.
ROOT_PACKAGE_JSON = REPO_ROOT / "package.json"


def test_health_reports_identity_without_secrets() -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["identity"] == ROUTER_IDENTITY
    assert body["kcb_version"] == KCB_VERSION
    assert not any("key" in key or "token" in key for key in body)


@pytest.mark.skipif(
    not SCHEMAS_VERSIONS.exists(),
    reason=f"standalone checkout: {SCHEMAS_VERSIONS} (the TS schemas package) is absent",
)
def test_kcb_version_matches_the_typescript_schemas_package() -> None:
    source = SCHEMAS_VERSIONS.read_text(encoding="utf-8")
    match = re.search(r"kcb:\s*('|\")([^'\"]+)\1", source)
    assert match is not None, f"could not find the kcb version pin in {SCHEMAS_VERSIONS}"
    assert match.group(2) == KCB_VERSION


@pytest.mark.skipif(
    not ROOT_PACKAGE_JSON.exists(),
    reason=f"standalone checkout: {ROOT_PACKAGE_JSON} (the workspace root) is absent",
)
def test_the_router_is_listed_as_an_area_of_the_commons() -> None:
    workspaces = json.loads(ROOT_PACKAGE_JSON.read_text())["workspaces"]
    assert "registry" in workspaces
    assert (REPO_ROOT / "provider-router" / "pyproject.toml").exists()
