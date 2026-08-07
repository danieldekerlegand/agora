"""The bridge against the REAL registry answer — the cross-language pin (KFT §8, FT-K).

``registry/src/fixtures/finetune-selection.json`` is what agora's TypeScript registry actually
returns from ``POST /finetune/select``, captured verbatim (``select.test.ts`` fails if it goes
stale). These read it from Python: the FT-K precedence is implemented once, in the registry, and
the bridge's only job is to understand the verdict and dial the address in it. If the two ever
drift, this goes red rather than the bridge silently routing a local-only corpus off-tier.

Then the whole walk, end to end, over real HTTP: a producer's exhaust → the §4 gate → the
registry's verdict → an `invoke` at the winner's own address. The scenario's Step 6, executed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from agora_trainer.bridge import http_dispatch, registry_directory, selection_from, submit
from agora_trainer.grant import Grant
from conftest import exhaust_header, exhaust_job

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "registry" / "src" / "fixtures" / "finetune-selection.json"

pytestmark = pytest.mark.skipif(
    not FIXTURE.exists(),
    reason=f"standalone checkout: {FIXTURE} (the TS registry fixture) is absent",
)


def captured(name: str) -> dict[str, Any]:
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
    case: dict[str, Any] = next(c for c in cases if c["name"] == name)
    return case


class TestReadingTheRegistrysRealAnswer:
    def test_the_specialized_verdict_projects_onto_an_in_tier_address(self) -> None:
        selection = selection_from(captured("specialized")["selection"])
        assert selection.outcome == "selected"
        assert selection.reason == "specialized"
        assert selection.provider is not None
        assert selection.provider.identity == "pinakes:agent:finetune"
        assert selection.provider.address.startswith("https://")
        # `tier: local` — inside the boundary, so a local-only exhaust may go here (§4.2).
        assert selection.provider.in_tier is True

    def test_the_general_fall_through_is_read_as_the_general_trainer(self) -> None:
        selection = selection_from(captured("general")["selection"])
        assert selection.outcome == "selected"
        assert selection.provider is not None
        assert selection.provider.identity == "agora:agent:trainer"
        assert selection.provider.address.endswith("/invoke")

    def test_an_unserved_job_is_read_as_none_not_an_empty_success(self) -> None:
        selection = selection_from(captured("none")["selection"])
        assert selection.outcome == "none"
        assert selection.provider is None


class TestTheWholeWalkOverHttp:
    """A producer's exhaust, a real registry answer, and a real POST at the winner's address."""

    def transport(self, recorder: list[httpx.Request]) -> httpx.MockTransport:
        def handle(request: httpx.Request) -> httpx.Response:
            recorder.append(request)
            if request.url.path == "/finetune/select":
                return httpx.Response(200, json=captured("specialized")["selection"])
            return httpx.Response(202, json={"accepted": True})

        return httpx.MockTransport(handle)

    def test_a_local_only_exhaust_reaches_the_specialist_and_nothing_else(self) -> None:
        seen: list[httpx.Request] = []
        with httpx.Client(transport=self.transport(seen)) as client:
            result = submit(
                exhaust_job(),
                grant=Grant(budget_units=1_000_000),
                directory=registry_directory("http://registry.local", client=client),
                dispatch=http_dispatch(client=client),
            )

        assert result.ok
        assert result.provider is not None
        assert result.provider.identity == "pinakes:agent:finetune"
        assert result.plan is not None
        assert result.plan.effective_egress == "local-only"

        # Exactly two dials: ask the registry, then `invoke` the provider. Nothing relayed.
        assert [str(request.url) for request in seen] == [
            "http://registry.local/finetune/select",
            result.provider.address,
        ]
        # The FT-K facets went to the registry; the job manifest went only to the provider.
        assert json.loads(seen[0].content) == {
            "capability": "finetune",
            "modality": "text-generation",
            "method": "qlora",
        }
        assert json.loads(seen[1].content)["job"] == "orchestrator:activity:ft-run/e9d7"
        # The §7 ceiling rides along so the provider re-gates against the same grant.
        assert float(seen[1].headers["X-Agora-Budget-Units"]) == 1_000_000.0

    def test_a_refused_corpus_never_reaches_the_registry_either(self) -> None:
        """Discovery is a dial too — an unadmitted job asks nobody anything."""
        seen: list[httpx.Request] = []
        with httpx.Client(transport=self.transport(seen)) as client:
            result = submit(
                exhaust_job(
                    dataset={
                        "records": ["ns:asset:blake3-a1"],
                        "header": [exhaust_header(rows=[{"instruction": "x"}])],
                    }
                ),
                directory=registry_directory("http://registry.local", client=client),
                dispatch=http_dispatch(client=client),
            )
        assert not result.ok
        assert [p.code for p in result.report.problems] == ["records-inlined"]
        assert seen == []
